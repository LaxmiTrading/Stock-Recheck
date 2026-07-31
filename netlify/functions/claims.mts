/**
 * Item claiming, counting lifecycle and submission — specification
 * sections 20, 21, 23, 39.
 *
 *   POST /api/rechecks/:recheckId/items/bulk-claim
 *   POST /api/rechecks/:recheckId/items/:itemId/claim
 *   POST /api/rechecks/:recheckId/items/:itemId/heartbeat
 *   POST /api/rechecks/:recheckId/items/:itemId/release
 *   POST /api/rechecks/:recheckId/items/:itemId/force-release
 *   POST /api/rechecks/:recheckId/items/:itemId/submit
 *   POST /api/rechecks/:recheckId/items/:itemId/reopen
 *   POST /api/rechecks/:recheckId/items/:itemId/amend
 *   GET  /api/rechecks/:recheckId/items/:itemId
 *
 * Every ownership decision is made by the database, never by the caller
 * (section 20: "Never perform claim ownership using only frontend state").
 */

import type { Config, Context } from '@netlify/functions';
import {
  amendCountRequestSchema,
  bulkClaimRequestSchema,
  forceReleaseRequestSchema,
  heartbeatRequestSchema,
  reopenItemRequestSchema,
  submitCountRequestSchema,
} from '../../src/schemas/api';
import { canReleaseClaim } from '../../src/domain/permissions';
import { isRecheckReadOnly } from '../../src/domain/status';
import { describeQuantityDifference } from '../../src/domain/quantity';
import { recordAuditEvent } from '../shared/audit';
import { requireActorWith, requireUser, type Actor } from '../shared/auth/session';
import {
  AppError,
  ClaimNotOwnedError,
  ForbiddenError,
  ItemAlreadyClaimedError,
  NotFoundError,
  RecheckReadOnlyError,
} from '../shared/errors';
import {
  jsonSuccess,
  matchRoute,
  parseJsonBody,
  withErrorHandling,
  type Route,
  type RouteContext,
} from '../shared/http';
import {
  abandonIdempotentOperation,
  beginIdempotentOperation,
  completeIdempotentOperation,
} from '../shared/idempotency';
import {
  amendSubmittedCount,
  claimItemAtomically,
  expireStaleClaims,
  findItemById,
  heartbeatClaim,
  refreshRecheckProgress,
  releaseClaim,
  reopenItem,
  submitCount,
} from '../shared/repositories/items';
import { findRecheckById } from '../shared/repositories/rechecks';
import { getSettings } from '../shared/repositories/settings';
import { CLAIM_RATE_LIMIT, enforceRateLimit } from '../shared/rateLimit';

/** Loads the recheck and refuses work on a completed/cancelled one (section 38). */
async function loadWritableRecheck(recheckId: string) {
  const recheck = await findRecheckById(recheckId);
  if (recheck === null) throw new NotFoundError('Stock Recheck');
  if (isRecheckReadOnly(recheck.status)) throw new RecheckReadOnlyError(recheck.status);
  return recheck;
}


function serializeItem(item: Awaited<ReturnType<typeof findItemById>>, actor: Actor) {
  if (item === null) return null;
  return {
    id: item.id,
    recheckId: item.stock_recheck_id,
    itemName: item.item_name,
    sku: item.sku,
    normalizedSku: item.normalized_sku,
    zohoStock: item.zoho_stock_quantity,
    vendor: item.vendor_name,
    unit: item.unit,
    workflowStatus: item.workflow_status,
    resultStatus: item.result_status,
    claimedBy: item.claimed_by,
    claimedByName: item.claimed_by_name,
    claimedAt: item.claimed_at,
    claimExpiresAt: item.claim_expires_at,
    claimVersion: item.claim_version,
    isClaimedByMe: item.claimed_by === actor.id,
    countedQuantity: item.counted_quantity,
    quantityDifference: item.quantity_difference,
    submittedByName: item.submitted_by_name,
    submittedAt: item.submitted_at,
  };
}

/* ------------------------------------------------------------------- read */

const getItemHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireUser(request);
  const recheckId = context.params.recheckId as string;
  const itemId = context.params.itemId as string;

  const recheck = await findRecheckById(recheckId);
  if (recheck === null) throw new NotFoundError('Stock Recheck');

  const item = await findItemById(recheckId, itemId);
  if (item === null) throw new NotFoundError('item');

  const settings = await getSettings();
  const serialized = serializeItem(item, actor);

  // Blind count: withhold the Zoho figure until the item is submitted.
  if (
    serialized !== null &&
    settings.blindCountEnabled &&
    item.workflow_status !== 'submitted'
  ) {
    serialized.zohoStock = null as unknown as number;
  }

  return jsonSuccess(
    {
      item: serialized,
      recheck: {
        id: recheck.id,
        recheckNumber: recheck.recheck_number,
        name: recheck.name,
        status: recheck.status,
        isReadOnly: isRecheckReadOnly(recheck.status),
        stockBasisType: recheck.stock_basis_type,
        stockBasisName: recheck.stock_location_name ?? recheck.stock_warehouse_name,
        zohoSnapshotAt: recheck.zoho_snapshot_at,
      },
      blindCountEnabled: settings.blindCountEnabled,
      resultMessage:
        item.quantity_difference === null
          ? null
          : describeQuantityDifference(item.quantity_difference),
    },
    context.correlationId,
  );
};

/* ------------------------------------------------------------------ claim */

const claimHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'item:claim');
  const recheckId = context.params.recheckId as string;
  const itemId = context.params.itemId as string;

  await enforceRateLimit(CLAIM_RATE_LIMIT, actor.id, context.correlationId);
  await loadWritableRecheck(recheckId);

  const settings = await getSettings();

  // Opportunistic sweep so a stale claim is recorded as expired (with its
  // audit event) rather than silently overwritten.
  const expired = await expireStaleClaims(settings.staleClaimGraceSeconds, 50);
  for (const entry of expired) {
    await recordAuditEvent({
      eventType: 'item.claim_expired',
      actorUserId: entry.previous_owner,
      stockRecheckId: entry.stock_recheck_id,
      stockRecheckItemId: entry.id,
      metadata: { sweptBy: actor.id },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });
  }

  const result = await claimItemAtomically({
    recheckId,
    itemId,
    userId: actor.id,
    leaseSeconds: settings.claimLeaseSeconds,
    graceSeconds: settings.staleClaimGraceSeconds,
  });

  if (result === null) {
    // The conditional UPDATE matched nothing: someone else holds the claim, it
    // is already submitted, or the recheck closed.
    const current = await findItemById(recheckId, itemId);
    if (current === null) throw new NotFoundError('item');
    if (current.workflow_status === 'submitted') {
      throw new AppError(
        'ITEM_ALREADY_SUBMITTED',
        'This item has already been submitted by another user.',
        409,
      );
    }
    throw new ItemAlreadyClaimedError(current.claimed_by_name ?? undefined);
  }

  await recordAuditEvent({
    eventType: 'item.claimed',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    stockRecheckId: recheckId,
    stockRecheckItemId: itemId,
    metadata: { sku: result.item.sku, claimVersion: result.claimVersion },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  const item = await findItemById(recheckId, itemId);

  // Cached counters follow the item state (available -> counting).
  await refreshRecheckProgress(recheckId);

  return jsonSuccess(
    {
      claimed: true,
      claimVersion: result.claimVersion,
      claimExpiresAt: result.claimExpiresAt,
      heartbeatSeconds: settings.heartbeatSeconds,
      item: serializeItem(item, actor),
    },
    context.correlationId,
  );
};

/* ------------------------------------------------------------- bulk claim */

/**
 * Claims several items in one request — the multi-select flow on the workspace
 * table.
 *
 * Deliberately NOT one transaction. Each item goes through the same
 * `claimItemAtomically` conditional UPDATE as the single-item route, so
 * section 2.4 ("one active claimant per item, enforced by an atomic database
 * operation") holds per item. Wrapping the batch in a single transaction would
 * mean one item already taken by a colleague rolls back the whole selection,
 * which is exactly the wrong outcome for a shared shop floor: the user should
 * keep the items they won and be told which ones they lost.
 */
const bulkClaimHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'item:claim');
  const recheckId = context.params.recheckId as string;
  const body = await parseJsonBody(request, bulkClaimRequestSchema);

  await enforceRateLimit(CLAIM_RATE_LIMIT, actor.id, context.correlationId);
  await loadWritableRecheck(recheckId);

  const settings = await getSettings();

  const expired = await expireStaleClaims(settings.staleClaimGraceSeconds, 50);
  for (const entry of expired) {
    await recordAuditEvent({
      eventType: 'item.claim_expired',
      actorUserId: entry.previous_owner,
      stockRecheckId: entry.stock_recheck_id,
      stockRecheckItemId: entry.id,
      metadata: { sweptBy: actor.id },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });
  }

  const claimed: { itemId: string; sku: string; itemName: string; claimVersion: number }[] = [];
  const rejected: { itemId: string; sku: string | null; code: string; message: string }[] = [];

  for (const itemId of body.itemIds) {
    const result = await claimItemAtomically({
      recheckId,
      itemId,
      userId: actor.id,
      leaseSeconds: settings.claimLeaseSeconds,
      graceSeconds: settings.staleClaimGraceSeconds,
    });

    if (result !== null) {
      claimed.push({
        itemId,
        sku: result.item.sku,
        itemName: result.item.item_name,
        claimVersion: result.claimVersion,
      });
      await recordAuditEvent({
        eventType: 'item.claimed',
        actorUserId: actor.id,
        actorDisplayName: actor.displayName,
        stockRecheckId: recheckId,
        stockRecheckItemId: itemId,
        metadata: { sku: result.item.sku, claimVersion: result.claimVersion, bulk: true },
        correlationId: context.correlationId,
        requestIp: context.requestIp,
      });
      continue;
    }

    // Explain precisely why this one did not land, using current row state.
    const current = await findItemById(recheckId, itemId);
    if (current === null) {
      rejected.push({ itemId, sku: null, code: 'NOT_FOUND', message: 'This item no longer exists.' });
    } else if (current.workflow_status === 'submitted') {
      rejected.push({
        itemId,
        sku: current.sku,
        code: 'ITEM_ALREADY_SUBMITTED',
        message: 'Already submitted.',
      });
    } else {
      rejected.push({
        itemId,
        sku: current.sku,
        code: 'ITEM_ALREADY_CLAIMED',
        message:
          current.claimed_by_name === null
            ? 'Claimed by another user.'
            : `Claimed by ${current.claimed_by_name}.`,
      });
    }
  }

  // Once for the whole batch: the counters are recomputed from the items table,
  // so one refresh after N claims is both correct and N-1 fewer transactions.
  if (claimed.length > 0 || expired.length > 0) {
    await refreshRecheckProgress(recheckId);
  }

  return jsonSuccess(
    {
      claimed,
      rejected,
      claimedCount: claimed.length,
      rejectedCount: rejected.length,
      heartbeatSeconds: settings.heartbeatSeconds,
    },
    context.correlationId,
  );
};

/* -------------------------------------------------------------- heartbeat */

const heartbeatHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'item:count');
  const recheckId = context.params.recheckId as string;
  const itemId = context.params.itemId as string;
  const body = await parseJsonBody(request, heartbeatRequestSchema);

  const settings = await getSettings();
  const extended = await heartbeatClaim({
    recheckId,
    itemId,
    userId: actor.id,
    claimVersion: body.claimVersion,
    leaseSeconds: settings.claimLeaseSeconds,
  });

  if (extended === null) {
    // Section 29: a heartbeat that cannot extend the lease is worth recording.
    await recordAuditEvent({
      eventType: 'item.claim_heartbeat_failed',
      actorUserId: actor.id,
      actorDisplayName: actor.displayName,
      stockRecheckId: recheckId,
      stockRecheckItemId: itemId,
      metadata: { claimVersion: body.claimVersion },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });
    throw new ClaimNotOwnedError(
      'Your claim on this item is no longer active. The local count has not been submitted.',
    );
  }

  return jsonSuccess(
    {
      claimExpiresAt: extended.claimExpiresAt,
      claimVersion: extended.claimVersion,
      heartbeatSeconds: settings.heartbeatSeconds,
    },
    context.correlationId,
  );
};

/* ---------------------------------------------------------------- release */

const releaseHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireUser(request);
  const recheckId = context.params.recheckId as string;
  const itemId = context.params.itemId as string;
  // A self-release carries no required payload; any body is ignored.

  const settings = await getSettings();
  const item = await findItemById(recheckId, itemId);
  if (item === null) throw new NotFoundError('item');

  const allowed = canReleaseClaim(actor, item.claimed_by, {
    countersMayReleaseOwnClaims: settings.countersMayReleaseOwnClaims,
    adminsMayForceRelease: settings.adminsMayForceRelease,
  });
  if (!allowed) {
    throw new ForbiddenError('You cannot release this claim.');
  }

  const released = await releaseClaim({ recheckId, itemId, userId: actor.id, force: false });
  if (released === null) {
    throw new ClaimNotOwnedError('You do not hold an active claim on this item.');
  }

  await recordAuditEvent({
    eventType: 'item.claim_released',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    stockRecheckId: recheckId,
    stockRecheckItemId: itemId,
    metadata: { sku: item.sku },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  // Counting -> available again.
  await refreshRecheckProgress(recheckId);

  return jsonSuccess({ released: true }, context.correlationId);
};

/* ---------------------------------------------------------- force-release */

const forceReleaseHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'item:force_release');
  const recheckId = context.params.recheckId as string;
  const itemId = context.params.itemId as string;
  // Section 19: a force-release requires a reason.
  const body = await parseJsonBody(request, forceReleaseRequestSchema);

  const settings = await getSettings();
  if (!settings.adminsMayForceRelease) {
    throw new ForbiddenError('Force-release is disabled in Claim Rules.');
  }

  const item = await findItemById(recheckId, itemId);
  if (item === null) throw new NotFoundError('item');

  const released = await releaseClaim({ recheckId, itemId, userId: actor.id, force: true });
  if (released === null) {
    throw new ClaimNotOwnedError('This item does not currently have an active claim.');
  }

  await recordAuditEvent({
    eventType: 'item.claim_force_released',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    stockRecheckId: recheckId,
    stockRecheckItemId: itemId,
    metadata: {
      reason: body.reason,
      previousOwnerId: released.previousOwnerId,
      previousOwnerName: item.claimed_by_name,
      sku: item.sku,
    },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  // Counting -> available again.
  await refreshRecheckProgress(recheckId);

  return jsonSuccess(
    { released: true, previousOwnerName: item.claimed_by_name },
    context.correlationId,
  );
};

/* ----------------------------------------------------------------- submit */

const submitHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'item:count');
  const recheckId = context.params.recheckId as string;
  const itemId = context.params.itemId as string;
  const body = await parseJsonBody(request, submitCountRequestSchema);

  await loadWritableRecheck(recheckId);

  // Section 23: an idempotency key prevents duplicate processing when the
  // network fails after the server already committed.
  const reservation = await beginIdempotentOperation<Record<string, unknown>>({
    userId: actor.id,
    operation: 'count.submit',
    idempotencyKey: body.idempotencyKey,
    requestPayload: { itemId, countedQuantity: body.countedQuantity, claimVersion: body.claimVersion },
  });

  if (reservation.kind === 'replay') {
    return jsonSuccess(reservation.body, context.correlationId);
  }
  if (reservation.kind === 'in_flight') {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'This submission is already being processed. Refresh to see the result.',
      409,
    );
  }

  try {
    const result = await submitCount({
      recheckId,
      itemId,
      userId: actor.id,
      userDisplayName: actor.displayName,
      countedQuantity: body.countedQuantity,
      claimVersion: body.claimVersion,
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });

    const payload = {
      submitted: true,
      itemId,
      countedQuantity: result.item.counted_quantity,
      zohoStock: result.item.zoho_stock_quantity,
      quantityDifference: result.quantityDifference,
      resultStatus: result.resultStatus,
      resultMessage: describeQuantityDifference(result.quantityDifference),
      submittedAt: result.item.submitted_at,
      recheckCompleted: result.recheckCompleted,
    };

    await completeIdempotentOperation({
      userId: actor.id,
      operation: 'count.submit',
      idempotencyKey: body.idempotencyKey,
      status: 200,
      body: payload,
    });

    return jsonSuccess(payload, context.correlationId);
  } catch (error) {
    await abandonIdempotentOperation({
      userId: actor.id,
      operation: 'count.submit',
      idempotencyKey: body.idempotencyKey,
    });
    throw error;
  }
};

/* ----------------------------------------------------------------- reopen */

const reopenHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'item:reopen');
  const recheckId = context.params.recheckId as string;
  const itemId = context.params.itemId as string;
  const body = await parseJsonBody(request, reopenItemRequestSchema);

  await loadWritableRecheck(recheckId);

  const reopened = await reopenItem({
    recheckId,
    itemId,
    actorId: actor.id,
    actorDisplayName: actor.displayName,
    reason: body.reason,
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return jsonSuccess(
    { reopened: true, itemId: reopened.id, workflowStatus: reopened.workflow_status },
    context.correlationId,
  );
};

/* ------------------------------------------------------------------ amend */

/**
 * Corrects the counted quantity on an item that has already been submitted.
 *
 * The difference is recomputed from the stored Zoho snapshot inside the same
 * transaction (section 2.6); nothing is read from or written to Zoho.
 */
const amendHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'item:amend');
  const recheckId = context.params.recheckId as string;
  const itemId = context.params.itemId as string;
  const body = await parseJsonBody(request, amendCountRequestSchema);

  await loadWritableRecheck(recheckId);

  // Same replay protection as submission: a retried request must not create a
  // second history attempt (section 23).
  const reservation = await beginIdempotentOperation<Record<string, unknown>>({
    userId: actor.id,
    operation: 'item.amend',
    idempotencyKey: body.idempotencyKey,
    requestPayload: { itemId, countedQuantity: body.countedQuantity, reason: body.reason },
  });

  if (reservation.kind === 'replay') {
    return jsonSuccess(reservation.body, context.correlationId);
  }
  if (reservation.kind === 'in_flight') {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'This edit is already being processed. Refresh to see the result.',
      409,
    );
  }

  try {
    const result = await amendSubmittedCount({
      recheckId,
      itemId,
      actorId: actor.id,
      actorDisplayName: actor.displayName,
      countedQuantity: body.countedQuantity,
      reason: body.reason,
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });

    const payload = {
      amended: true,
      itemId,
      countedQuantity: result.item.counted_quantity,
      zohoStock: result.item.zoho_stock_quantity,
      quantityDifference: result.quantityDifference,
      resultStatus: result.resultStatus,
      resultMessage: describeQuantityDifference(result.quantityDifference),
      submittedAt: result.item.submitted_at,
    };

    await completeIdempotentOperation({
      userId: actor.id,
      operation: 'item.amend',
      idempotencyKey: body.idempotencyKey,
      status: 200,
      body: payload,
    });

    return jsonSuccess(payload, context.correlationId);
  } catch (error) {
    await abandonIdempotentOperation({
      userId: actor.id,
      operation: 'item.amend',
      idempotencyKey: body.idempotencyKey,
    });
    throw error;
  }
};

/* ------------------------------------------------------------------ route */

const BASE = '/api/rechecks/:recheckId/items/:itemId';

const routes: Route[] = [
  { method: 'GET', pattern: BASE, handler: getItemHandler },
  { method: 'POST', pattern: '/api/rechecks/:recheckId/items/bulk-claim', handler: bulkClaimHandler },
  { method: 'POST', pattern: `${BASE}/claim`, handler: claimHandler },
  { method: 'POST', pattern: `${BASE}/heartbeat`, handler: heartbeatHandler },
  { method: 'POST', pattern: `${BASE}/release`, handler: releaseHandler },
  { method: 'POST', pattern: `${BASE}/force-release`, handler: forceReleaseHandler },
  { method: 'POST', pattern: `${BASE}/submit`, handler: submitHandler },
  { method: 'POST', pattern: `${BASE}/reopen`, handler: reopenHandler },
  { method: 'POST', pattern: `${BASE}/amend`, handler: amendHandler },
];

const handler = withErrorHandling('claims', async (request, context) => {
  const match = matchRoute(routes, request);
  if (match === null) throw new NotFoundError('endpoint');
  return match.handler(request, { ...context, params: match.params });
});

export default async (request: Request, context: Context): Promise<Response> =>
  handler(request, { params: context.params, ip: context.ip });

export const config: Config = {
  path: [
    // Must list every route the internal router serves — Netlify only invokes
    // this function for paths declared here.
    '/api/rechecks/:recheckId/items/bulk-claim',
    '/api/rechecks/:recheckId/items/:itemId',
    '/api/rechecks/:recheckId/items/:itemId/claim',
    '/api/rechecks/:recheckId/items/:itemId/amend',
    '/api/rechecks/:recheckId/items/:itemId/heartbeat',
    '/api/rechecks/:recheckId/items/:itemId/release',
    '/api/rechecks/:recheckId/items/:itemId/force-release',
    '/api/rechecks/:recheckId/items/:itemId/submit',
    '/api/rechecks/:recheckId/items/:itemId/reopen',
  ],
};
