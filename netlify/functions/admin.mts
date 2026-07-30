/**
 * Administration endpoints — specification sections 27, 28, 29, 31.
 *
 *   GET   /api/admin/users
 *   POST  /api/admin/users/invite
 *   PATCH /api/admin/users/:id
 *   POST  /api/admin/users/:id/disable
 *   GET   /api/admin/audit-events
 *   GET   /api/admin/settings
 *   PATCH /api/admin/settings
 *
 * Every handler re-checks the administrator role on the server; hiding the
 * navigation entry is not the enforcement mechanism (section 7).
 */

import type { Config, Context } from '@netlify/functions';
import {
  auditQuerySchema,
  disableUserRequestSchema,
  inviteUserRequestSchema,
  updateSettingsRequestSchema,
  updateUserRequestSchema,
} from '../../src/schemas/api';
import { AUDIT_EVENT_TYPES } from '../../src/domain/audit';
import {
  blockDisableReason,
  blockPromotionReason,
  blockRoleChangeReason,
} from '../../src/domain/permissions';
import { clampPageSize, validateSettings, type AppSettings } from '../../src/domain/settings';
import { recordAuditEvent } from '../shared/audit';
import { requireActorWith } from '../shared/auth/session';
import { INVITE_LIFETIME_SECONDS, issueToken } from '../shared/auth/password';
import { isUniqueViolation, queryMany, queryOne } from '../shared/database/client';
import { AppError, NotFoundError, ValidationError } from '../shared/errors';
import {
  jsonSuccess,
  matchRoute,
  parseJsonBody,
  parseSearchParams,
  withErrorHandling,
  type Route,
  type RouteContext,
} from '../shared/http';
import { buildInviteLink, deliverLink } from '../shared/mailer';
import {
  countActiveAdministrators,
  countAdministrators,
  findProfileById,
  findProfileByEmail,
  insertInvitedProfile,
  listProfiles,
  refreshInvite,
  updateDisplayName,
  updateProfileRole,
  updateProfileStatus,
} from '../shared/repositories/profiles';
import { getSettings, updateSettings } from '../shared/repositories/settings';
import { releaseClaim } from '../shared/repositories/items';

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:8888';
}

/* ------------------------------------------------------------------ users */

/**
 * The partial unique index added in migration 0003. Named here so a violation
 * can be told apart from the email-uniqueness index on the same table.
 */
const ADMINISTRATOR_INDEX = 'profiles_single_administrator_idx';
const SINGLE_ADMINISTRATOR_MESSAGE =
  'There can only be one administrator, and one already exists. The administrator role cannot be transferred from this screen.';

const listUsersHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireActorWith(request, 'user:manage');
  const users = await listProfiles();

  return jsonSuccess(
    {
      users: users.map((user) => ({
        id: user.id,
        name: user.display_name,
        email: user.email,
        role: user.role,
        status: user.status,
        lastLoginAt: user.last_login_at,
        createdAt: user.created_at,
        activeClaim:
          user.active_claim_item_id === null
            ? null
            : { itemId: user.active_claim_item_id, itemName: user.active_claim_item_name },
      })),
    },
    context.correlationId,
  );
};

const inviteUserHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'user:manage');
  const body = await parseJsonBody(request, inviteUserRequestSchema);

  /*
   * Check the ceiling BEFORE issuing an invite token or sending mail: an
   * invitation that cannot ever be accepted is worse than a refusal, and the
   * partial unique index would otherwise reject the insert as a raw 500.
   */
  if (body.role === 'administrator') {
    const blockedPromotion = blockPromotionReason({
      targetCurrentRole: 'counter',
      targetNewRole: body.role,
      administratorCount: await countAdministrators(),
    });
    if (blockedPromotion !== null) {
      throw new AppError('ADMINISTRATOR_LIMIT', blockedPromotion, 409);
    }
  }

  const token = issueToken(INVITE_LIFETIME_SECONDS);
  const existing = await findProfileByEmail(body.email);

  let profileId: string;
  if (existing !== null) {
    if (existing.status !== 'invited') {
      throw new AppError(
        'DUPLICATE_EMAIL',
        'An account with that email already exists.',
        409,
      );
    }
    // Re-inviting someone who has not accepted yet refreshes their link.
    await refreshInvite({
      profileId: existing.id,
      inviteTokenHash: token.tokenHash,
      inviteExpiresAt: token.expiresAt,
      role: body.role,
      displayName: body.displayName,
    });
    profileId = existing.id;
  } else {
    try {
      const created = await insertInvitedProfile({
        email: body.email,
        displayName: body.displayName,
        role: body.role,
        inviteTokenHash: token.tokenHash,
        inviteExpiresAt: token.expiresAt,
      });
      profileId = created.id;
    } catch (error) {
      /*
       * Order matters: `profiles` now carries TWO unique indexes, so an
       * unqualified isUniqueViolation() would report a second-administrator
       * conflict as "duplicate email" and send the administrator hunting for
       * an account that does not exist. Check the narrower one first.
       */
      if (isUniqueViolation(error, ADMINISTRATOR_INDEX)) {
        throw new AppError('ADMINISTRATOR_LIMIT', SINGLE_ADMINISTRATOR_MESSAGE, 409);
      }
      if (isUniqueViolation(error)) {
        throw new AppError('DUPLICATE_EMAIL', 'An account with that email already exists.', 409);
      }
      throw error;
    }
  }

  const delivery = await deliverLink({
    kind: 'invite',
    to: body.email,
    recipientName: body.displayName,
    link: buildInviteLink(appBaseUrl(), token.token),
    expiresAt: token.expiresAt,
    correlationId: context.correlationId,
  });

  await recordAuditEvent({
    eventType: 'user.invited',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    metadata: { invitedEmail: body.email, role: body.role, delivered: delivery.delivered },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return jsonSuccess(
    {
      userId: profileId,
      emailDelivered: delivery.delivered,
      // Present only when no mail provider is configured, so the administrator
      // can pass the link on themselves.
      manualInviteLink: delivery.manualLink ?? null,
      expiresAt: token.expiresAt.toISOString(),
    },
    context.correlationId,
    { status: 201 },
  );
};

const updateUserHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'user:manage');
  const targetId = context.params.id as string;
  const body = await parseJsonBody(request, updateUserRequestSchema);

  const target = await findProfileById(targetId);
  if (target === null) throw new NotFoundError('user');

  if (body.role !== undefined && body.role !== target.role) {
    // Ceiling: at most one administrator, counting every status.
    const blockedPromotion = blockPromotionReason({
      targetCurrentRole: target.role,
      targetNewRole: body.role,
      administratorCount: await countAdministrators(),
    });
    if (blockedPromotion !== null) {
      throw new AppError('ADMINISTRATOR_LIMIT', blockedPromotion, 409);
    }

    const activeAdministratorCount = await countActiveAdministrators();
    // Section 27: never let the last active administrator lose the role.
    const blocked = blockRoleChangeReason({
      actorId: actor.id,
      targetUserId: targetId,
      targetCurrentRole: target.role,
      targetNewRole: body.role,
      activeAdministratorCount,
    });
    if (blocked !== null) throw new AppError('LAST_ADMINISTRATOR', blocked, 409);

    try {
      await updateProfileRole(targetId, body.role);
    } catch (error) {
      // Lost a race with a concurrent promotion; the index is the arbiter.
      if (isUniqueViolation(error, ADMINISTRATOR_INDEX)) {
        throw new AppError('ADMINISTRATOR_LIMIT', SINGLE_ADMINISTRATOR_MESSAGE, 409);
      }
      throw error;
    }
    await recordAuditEvent({
      eventType: 'user.role_changed',
      actorUserId: actor.id,
      actorDisplayName: actor.displayName,
      metadata: { targetUserId: targetId, from: target.role, to: body.role },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });
  }

  if (body.displayName !== undefined) await updateDisplayName(targetId, body.displayName);

  if (body.status !== undefined && body.status !== target.status) {
    if (body.status === 'disabled') {
      const activeAdministratorCount = await countActiveAdministrators();
      const blocked = blockDisableReason({
        actorId: actor.id,
        targetUserId: targetId,
        targetRole: target.role,
        activeAdministratorCount,
      });
      if (blocked !== null) throw new AppError('LAST_ADMINISTRATOR', blocked, 409);
    }
    await updateProfileStatus(targetId, body.status);
    await recordAuditEvent({
      eventType: body.status === 'disabled' ? 'user.disabled' : 'user.enabled',
      actorUserId: actor.id,
      actorDisplayName: actor.displayName,
      metadata: { targetUserId: targetId },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });
  }

  const updated = await findProfileById(targetId);
  return jsonSuccess({ user: updated }, context.correlationId);
};

const disableUserHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'user:manage');
  const targetId = context.params.id as string;
  const body = await parseJsonBody(request, disableUserRequestSchema);

  const target = await findProfileById(targetId);
  if (target === null) throw new NotFoundError('user');

  const activeAdministratorCount = await countActiveAdministrators();
  const blocked = blockDisableReason({
    actorId: actor.id,
    targetUserId: targetId,
    targetRole: target.role,
    activeAdministratorCount,
  });
  if (blocked !== null) throw new AppError('LAST_ADMINISTRATOR', blocked, 409);

  // Section 27: warn about an active claim and optionally release it.
  const activeClaim = await queryOne<{ id: string; stock_recheck_id: string; item_name: string }>(
    `SELECT id, stock_recheck_id, item_name
       FROM stock_recheck_items
      WHERE claimed_by = $1 AND workflow_status = 'counting_in_progress'
      LIMIT 1`,
    [targetId],
  );

  let releasedClaim = false;
  if (activeClaim !== null && body.releaseActiveClaim) {
    const released = await releaseClaim({
      recheckId: activeClaim.stock_recheck_id,
      itemId: activeClaim.id,
      userId: actor.id,
      force: true,
    });
    releasedClaim = released !== null;

    if (releasedClaim) {
      await recordAuditEvent({
        eventType: 'item.claim_force_released',
        actorUserId: actor.id,
        actorDisplayName: actor.displayName,
        stockRecheckId: activeClaim.stock_recheck_id,
        stockRecheckItemId: activeClaim.id,
        metadata: { reason: body.reason ?? 'User disabled', previousOwnerId: targetId },
        correlationId: context.correlationId,
        requestIp: context.requestIp,
      });
    }
  }

  await updateProfileStatus(targetId, 'disabled');
  await recordAuditEvent({
    eventType: 'user.disabled',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    metadata: { targetUserId: targetId, releasedClaim, reason: body.reason ?? null },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return jsonSuccess(
    {
      disabled: true,
      hadActiveClaim: activeClaim !== null,
      releasedClaim,
      activeClaimItemName: activeClaim?.item_name ?? null,
    },
    context.correlationId,
  );
};

/* ------------------------------------------------------------- audit log */

interface AuditRow {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_display_name: string | null;
  stock_recheck_id: string | null;
  stock_recheck_item_id: string | null;
  metadata_json: Record<string, unknown>;
  correlation_id: string | null;
  created_at: string;
}

const auditHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireActorWith(request, 'audit:view');
  const params = parseSearchParams(request, auditQuerySchema);

  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10));
  const pageSize = clampPageSize(Number.parseInt(params.pageSize ?? '50', 10));

  const conditions: string[] = ['TRUE'];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    conditions.push(sql.replace('$?', `$${values.length}`));
  };

  if (params.eventType !== undefined) {
    // Constrain to the known taxonomy so the filter cannot be abused.
    if (!(AUDIT_EVENT_TYPES as readonly string[]).includes(params.eventType)) {
      throw new ValidationError('Unknown audit event type.');
    }
    add('event_type = $?', params.eventType);
  }
  if (params.actorUserId !== undefined) add('actor_user_id = $?', params.actorUserId);
  if (params.recheckId !== undefined) add('stock_recheck_id = $?', params.recheckId);
  if (params.fromDate !== undefined) add('created_at >= $?::timestamptz', params.fromDate);
  if (params.toDate !== undefined) add('created_at <= $?::timestamptz', params.toDate);

  const whereClause = conditions.join(' AND ');
  const totalRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM audit_events WHERE ${whereClause}`,
    values,
  );

  values.push(pageSize, (page - 1) * pageSize);
  const events = await queryMany<AuditRow>(
    `SELECT id, event_type, actor_user_id, actor_display_name,
            stock_recheck_id, stock_recheck_item_id, metadata_json,
            correlation_id, created_at
       FROM audit_events
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  const total = totalRow?.total ?? 0;

  return jsonSuccess(
    {
      events: events.map((event) => ({
        id: event.id,
        eventType: event.event_type,
        actorUserId: event.actor_user_id,
        actorDisplayName: event.actor_display_name,
        recheckId: event.stock_recheck_id,
        itemId: event.stock_recheck_item_id,
        metadata: event.metadata_json,
        correlationId: event.correlation_id,
        createdAt: event.created_at,
      })),
      eventTypes: AUDIT_EVENT_TYPES,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
    context.correlationId,
  );
};

/* -------------------------------------------------------------- settings */

const getSettingsHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireActorWith(request, 'settings:manage');
  const settings = await getSettings();
  return jsonSuccess({ settings }, context.correlationId);
};

const patchSettingsHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'settings:manage');
  const body = await parseJsonBody(request, updateSettingsRequestSchema);

  const current = await getSettings();
  const merged: AppSettings = { ...current, ...body } as AppSettings;

  // Re-run the shared validator against the MERGED result, so a partial patch
  // cannot create an invalid combination (e.g. heartbeat vs lease).
  const issues = validateSettings(merged);
  if (issues.length > 0) {
    throw new ValidationError('These settings are not valid.', { issues });
  }

  const stockBasisChanged =
    body.defaultStockBasisType !== undefined ||
    body.defaultLocationId !== undefined ||
    body.defaultWarehouseId !== undefined;

  const updated = await updateSettings(body as Partial<AppSettings>, actor.id);

  await recordAuditEvent({
    eventType: stockBasisChanged ? 'settings.stock_basis_changed' : 'settings.updated',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    metadata: { changedFields: Object.keys(body) },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return jsonSuccess(
    {
      settings: updated,
      // Section 28.3: the new basis applies to NEW rechecks only.
      note: stockBasisChanged
        ? 'The new stock basis applies to newly created Stock Rechecks. Existing Stock Rechecks keep their stored basis.'
        : null,
    },
    context.correlationId,
  );
};

/* ------------------------------------------------------------------ route */

const routes: Route[] = [
  { method: 'GET', pattern: '/api/admin/users', handler: listUsersHandler },
  { method: 'POST', pattern: '/api/admin/users/invite', handler: inviteUserHandler },
  { method: 'PATCH', pattern: '/api/admin/users/:id', handler: updateUserHandler },
  { method: 'POST', pattern: '/api/admin/users/:id/disable', handler: disableUserHandler },
  { method: 'GET', pattern: '/api/admin/audit-events', handler: auditHandler },
  { method: 'GET', pattern: '/api/admin/settings', handler: getSettingsHandler },
  { method: 'PATCH', pattern: '/api/admin/settings', handler: patchSettingsHandler },
];

const handler = withErrorHandling('admin', async (request, context) => {
  const match = matchRoute(routes, request);
  if (match === null) throw new NotFoundError('endpoint');
  return match.handler(request, { ...context, params: match.params });
});

export default async (request: Request, context: Context): Promise<Response> =>
  handler(request, { params: context.params, ip: context.ip });

export const config: Config = {
  path: [
    '/api/admin/users',
    '/api/admin/users/invite',
    '/api/admin/users/:id',
    '/api/admin/users/:id/disable',
    '/api/admin/audit-events',
    '/api/admin/settings',
  ],
};
