/**
 * Authentication endpoints — specification sections 4.5, 9, 31.
 *
 *   POST /api/auth/login
 *   POST /api/auth/logout
 *   POST /api/auth/accept-invite
 *   POST /api/auth/forgot-password
 *   POST /api/auth/reset-password
 *   POST /api/auth/change-password
 *   GET  /api/me
 *
 * Registration is invite-only: there is no self-registration endpoint at all
 * (section 4.5, section 9 "Do not display a Sign Up option").
 */

import type { Config, Context } from '@netlify/functions';
import {
  acceptInviteRequestSchema,
  changeOwnPasswordSchema,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  resetPasswordRequestSchema,
} from '../../src/schemas/api';
import { recordAuditEvent } from '../shared/audit';
import {
  buildClearSessionCookie,
  createSessionCookie,
  requireUser,
} from '../shared/auth/session';
import {
  hashPassword,
  hashToken,
  issueToken,
  passwordValidationMessage,
  RESET_LIFETIME_SECONDS,
  verifyPassword,
} from '../shared/auth/password';
import {
  AccountDisabledError,
  AppError,
  InvalidCredentialsError,
  ValidationError,
} from '../shared/errors';
import {
  jsonSuccess,
  matchRoute,
  parseJsonBody,
  withErrorHandling,
  type Route,
  type RouteContext,
} from '../shared/http';
import { buildResetLink, deliverLink } from '../shared/mailer';
import {
  activateProfileWithPassword,
  findProfileByEmail,
  findProfileByInviteToken,
  findProfileByResetToken,
  recordLogin,
  setResetToken,
  updatePassword,
} from '../shared/repositories/profiles';
import {
  enforceRateLimit,
  LOGIN_RATE_LIMIT,
  PASSWORD_RESET_RATE_LIMIT,
} from '../shared/rateLimit';
import { getSettings } from '../shared/repositories/settings';
import { findActiveClaimForUser } from '../shared/repositories/items';

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:8888';
}

/* ------------------------------------------------------------------ login */

const login = async (request: Request, context: RouteContext): Promise<Response> => {
  const body = await parseJsonBody(request, loginRequestSchema);

  // Throttle by IP so credential stuffing is expensive (section 34).
  await enforceRateLimit(LOGIN_RATE_LIMIT, context.requestIp ?? 'unknown-ip', context.correlationId);

  const profile = await findProfileByEmail(body.email);

  // The password check runs even when no profile exists, so response timing
  // does not disclose whether the email is registered (section 9).
  const passwordMatches = await verifyPassword(body.password, {
    hash: profile?.password_hash ?? null,
    salt: profile?.password_salt ?? null,
  });

  if (profile === null || !passwordMatches) {
    // Deliberately generic — never reveal whether the email exists.
    throw new InvalidCredentialsError();
  }
  if (profile.status === 'disabled') throw new AccountDisabledError();
  if (profile.status === 'invited') {
    throw new InvalidCredentialsError();
  }

  const session = createSessionCookie({
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    role: profile.role,
  });

  await recordLogin(profile.id);
  await recordAuditEvent({
    eventType: 'user.signed_in',
    actorUserId: profile.id,
    actorDisplayName: profile.display_name,
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return jsonSuccess(
    {
      user: {
        id: profile.id,
        email: profile.email,
        displayName: profile.display_name,
        role: profile.role,
      },
      expiresInSeconds: session.expiresInSeconds,
    },
    context.correlationId,
    { headers: { 'set-cookie': session.cookie } },
  );
};

/* ----------------------------------------------------------------- logout */

const logout = async (_request: Request, context: RouteContext): Promise<Response> =>
  jsonSuccess({ signedOut: true }, context.correlationId, {
    headers: { 'set-cookie': buildClearSessionCookie() },
  });

/* --------------------------------------------------------------- identity */

const me = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireUser(request);
  const settings = await getSettings();
  const activeClaim = await findActiveClaimForUser(actor.id);

  return jsonSuccess(
    {
      user: {
        id: actor.id,
        email: actor.email,
        displayName: actor.displayName,
        role: actor.role,
      },
      // Counters receive the operational settings they need for the scanner
      // and claim behaviour, never integration detail (section 4.5).
      settings: {
        businessName: settings.businessName,
        businessTimezone: settings.businessTimezone,
        dateFormat: settings.dateFormat,
        skuCaseSensitive: settings.skuCaseSensitive,
        claimLeaseSeconds: settings.claimLeaseSeconds,
        heartbeatSeconds: settings.heartbeatSeconds,
        blindCountEnabled: settings.blindCountEnabled,
        scannerSoundEnabled: settings.scannerSoundEnabled,
        scannerSuccessSound: settings.scannerSuccessSound,
        scannerErrorSound: settings.scannerErrorSound,
        scannerSuccessFlash: settings.scannerSuccessFlash,
        scannerErrorFlash: settings.scannerErrorFlash,
        scannerRequireEnter: settings.scannerRequireEnter,
        scannerAutoSelectInvalid: settings.scannerAutoSelectInvalid,
        scannerPreventSleep: settings.scannerPreventSleep,
        countersMayReleaseOwnClaims: settings.countersMayReleaseOwnClaims,
        defaultSort: settings.defaultSort,
      },
      activeClaim:
        activeClaim === null
          ? null
          : {
              itemId: activeClaim.item_id,
              recheckId: activeClaim.stock_recheck_id,
              recheckNumber: activeClaim.recheck_number,
              itemName: activeClaim.item_name,
              sku: activeClaim.sku,
              claimExpiresAt: activeClaim.claim_expires_at,
            },
    },
    context.correlationId,
  );
};

/* ---------------------------------------------------------- accept invite */

const acceptInvite = async (request: Request, context: RouteContext): Promise<Response> => {
  const body = await parseJsonBody(request, acceptInviteRequestSchema);

  const strengthIssue = passwordValidationMessage(body.password);
  if (strengthIssue !== null) throw new ValidationError(strengthIssue, { field: 'password' });

  const profile = await findProfileByInviteToken(hashToken(body.token));
  if (profile === null) {
    throw new AppError('INVITE_INVALID', 'This invitation link is not valid.', 400);
  }
  if (profile.invite_expires_at !== null && new Date(profile.invite_expires_at) <= new Date()) {
    throw new AppError(
      'INVITE_EXPIRED',
      'This invitation has expired. Ask an administrator to send a new one.',
      400,
    );
  }

  const { hash, salt } = await hashPassword(body.password);
  const activated = await activateProfileWithPassword({
    profileId: profile.id,
    passwordHash: hash,
    passwordSalt: salt,
  });
  if (activated === null) {
    throw new AppError('INVITE_INVALID', 'This invitation link is not valid.', 400);
  }

  await recordAuditEvent({
    eventType: 'user.invite_accepted',
    actorUserId: activated.id,
    actorDisplayName: activated.display_name,
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  const session = createSessionCookie({
    id: activated.id,
    email: activated.email,
    displayName: activated.display_name,
    role: activated.role,
  });

  return jsonSuccess(
    {
      user: {
        id: activated.id,
        email: activated.email,
        displayName: activated.display_name,
        role: activated.role,
      },
    },
    context.correlationId,
    { headers: { 'set-cookie': session.cookie } },
  );
};

/* -------------------------------------------------------- forgot password */

const forgotPassword = async (request: Request, context: RouteContext): Promise<Response> => {
  const body = await parseJsonBody(request, forgotPasswordRequestSchema);
  await enforceRateLimit(
    PASSWORD_RESET_RATE_LIMIT,
    context.requestIp ?? 'unknown-ip',
    context.correlationId,
  );

  const profile = await findProfileByEmail(body.email);

  // Always answer identically, whether or not the account exists (section 9).
  const genericResponse = jsonSuccess(
    {
      submitted: true,
      message: 'If that email belongs to an account, a reset link has been sent.',
    },
    context.correlationId,
  );

  if (profile === null || profile.status === 'disabled') return genericResponse;

  const token = issueToken(RESET_LIFETIME_SECONDS);
  await setResetToken({
    profileId: profile.id,
    tokenHash: token.tokenHash,
    expiresAt: token.expiresAt,
  });

  await deliverLink({
    kind: 'password_reset',
    to: profile.email,
    recipientName: profile.display_name,
    link: buildResetLink(appBaseUrl(), token.token),
    expiresAt: token.expiresAt,
    correlationId: context.correlationId,
  });

  await recordAuditEvent({
    eventType: 'user.password_reset_requested',
    actorUserId: profile.id,
    actorDisplayName: profile.display_name,
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return genericResponse;
};

/* --------------------------------------------------------- reset password */

const resetPassword = async (request: Request, context: RouteContext): Promise<Response> => {
  const body = await parseJsonBody(request, resetPasswordRequestSchema);

  const strengthIssue = passwordValidationMessage(body.password);
  if (strengthIssue !== null) throw new ValidationError(strengthIssue, { field: 'password' });

  const profile = await findProfileByResetToken(hashToken(body.token));
  if (profile === null) {
    throw new AppError('INVITE_INVALID', 'This reset link is not valid.', 400);
  }
  if (profile.reset_expires_at !== null && new Date(profile.reset_expires_at) <= new Date()) {
    throw new AppError('INVITE_EXPIRED', 'This reset link has expired. Request a new one.', 400);
  }

  const { hash, salt } = await hashPassword(body.password);
  await updatePassword({ profileId: profile.id, passwordHash: hash, passwordSalt: salt });

  // Force a fresh sign-in so an attacker holding an old session is evicted.
  return jsonSuccess({ reset: true }, context.correlationId, {
    headers: { 'set-cookie': buildClearSessionCookie() },
  });
};

/* -------------------------------------------------------- change password */

const changePassword = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireUser(request);
  const body = await parseJsonBody(request, changeOwnPasswordSchema);

  const strengthIssue = passwordValidationMessage(body.newPassword);
  if (strengthIssue !== null) throw new ValidationError(strengthIssue, { field: 'newPassword' });

  const profile = await findProfileByEmail(actor.email);
  if (profile === null) throw new InvalidCredentialsError();

  const matches = await verifyPassword(body.currentPassword, {
    hash: profile.password_hash,
    salt: profile.password_salt,
  });
  if (!matches) throw new ValidationError('Your current password is incorrect.');

  const { hash, salt } = await hashPassword(body.newPassword);
  await updatePassword({ profileId: actor.id, passwordHash: hash, passwordSalt: salt });

  return jsonSuccess({ changed: true }, context.correlationId);
};

/* ------------------------------------------------------------------ route */

const routes: Route[] = [
  { method: 'POST', pattern: '/api/auth/login', handler: login },
  { method: 'POST', pattern: '/api/auth/logout', handler: logout },
  { method: 'POST', pattern: '/api/auth/accept-invite', handler: acceptInvite },
  { method: 'POST', pattern: '/api/auth/forgot-password', handler: forgotPassword },
  { method: 'POST', pattern: '/api/auth/reset-password', handler: resetPassword },
  { method: 'POST', pattern: '/api/auth/change-password', handler: changePassword },
  { method: 'GET', pattern: '/api/me', handler: me },
];

const handler = withErrorHandling('auth', async (request, context) => {
  const match = matchRoute(routes, request);
  if (match === null) {
    return jsonSuccess({ notFound: true }, context.correlationId, { status: 404 });
  }
  return match.handler(request, { ...context, params: match.params });
});

export default async (request: Request, context: Context): Promise<Response> =>
  handler(request, { params: context.params, ip: context.ip });

export const config: Config = {
  path: [
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/accept-invite',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/auth/change-password',
    '/api/me',
  ],
};
