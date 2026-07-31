/**
 * Session cookies and request authorization — specification sections 4.5, 34.
 *
 * The session JWT is stored in an httpOnly, Secure, SameSite=Lax cookie so it
 * is unreadable from JavaScript and is never placed in a URL (section 34).
 *
 * `requireUser` re-reads the profile from the database on every protected
 * request rather than trusting the token's claims, so a disabled account or a
 * role change takes effect immediately instead of at token expiry.
 */

import {
  AccountDisabledError,
  ForbiddenError,
  UnauthenticatedError,
} from '../errors';
import { actorCan, type Permission, type Role, type UserStatus } from '../../../src/domain/permissions';
import { queryOne } from '../database/client';
import { signJwt, verifyJwt } from './jwt';
import { newSessionId } from './password';

export const SESSION_COOKIE_NAME = '__Host-sr_session';
/** Local development over plain http cannot use the __Host- prefix. */
export const SESSION_COOKIE_NAME_INSECURE = 'sr_session';

export function isSecureContext(): boolean {
  const baseUrl = process.env.APP_BASE_URL ?? '';
  if (baseUrl.startsWith('https://')) return true;
  return process.env.NODE_ENV === 'production' && !baseUrl.startsWith('http://localhost');
}

export function sessionCookieName(): string {
  return isSecureContext() ? SESSION_COOKIE_NAME : SESSION_COOKIE_NAME_INSECURE;
}

export function sessionLifetimeSeconds(): number {
  const configured = Number.parseInt(process.env.AUTH_SESSION_SECONDS ?? '', 10);
  if (Number.isInteger(configured) && configured >= 300 && configured <= 7 * 24 * 3600) {
    return configured;
  }
  return 12 * 3600;
}

/* ---------------------------------------------------------------- cookies */

export function parseCookies(request: Request): Record<string, string> {
  const header = request.headers.get('cookie');
  if (header === null) return {};

  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length > 0) cookies[name] = decodeURIComponent(value);
  }
  return cookies;
}

export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  const secure = isSecureContext();
  const attributes = [
    `${sessionCookieName()}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function buildClearSessionCookie(): string {
  const attributes = [`${sessionCookieName()}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureContext()) attributes.push('Secure');
  return attributes.join('; ');
}

/* ------------------------------------------------------------ actor model */

export interface Actor {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  sessionId: string;
}

interface ProfileRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  status: 'active' | 'disabled' | 'invited';
}

/** Issues a fresh session cookie for a profile. */
export function createSessionCookie(profile: {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}): { cookie: string; sessionId: string; expiresInSeconds: number } {
  const sessionId = newSessionId();
  const lifetime = sessionLifetimeSeconds();
  const token = signJwt(
    {
      sub: profile.id,
      sid: sessionId,
      role: profile.role,
      email: profile.email,
      name: profile.displayName,
    },
    lifetime,
  );
  return {
    cookie: buildSessionCookie(token, lifetime),
    sessionId,
    expiresInSeconds: lifetime,
  };
}

/**
 * Resolves the authenticated actor, or throws.
 *
 * Section 31: "Never trust role, user ID, claim ownership, count, item status
 * or Stock Recheck status supplied by the browser."
 */
export async function requireUser(request: Request): Promise<Actor> {
  const cookies = parseCookies(request);
  const token = cookies[sessionCookieName()] ?? cookies[SESSION_COOKIE_NAME] ?? cookies[SESSION_COOKIE_NAME_INSECURE];

  if (token === undefined || token.length === 0) {
    throw new UnauthenticatedError();
  }

  // Throws UnauthenticatedError / SessionExpiredError.
  const payload = verifyJwt(token);

  // Authoritative re-read: the token is only a pointer to a profile.
  const profile = await queryOne<ProfileRow>(
    'SELECT id, email, display_name, role, status FROM profiles WHERE id = $1',
    [payload.sub],
  );

  if (profile === null) throw new UnauthenticatedError('This account no longer exists.');
  if (profile.status === 'disabled') throw new AccountDisabledError();
  if (profile.status === 'invited') {
    throw new UnauthenticatedError('Finish accepting your invitation before signing in.');
  }

  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.display_name,
    role: profile.role,
    status: 'active',
    sessionId: payload.sid,
  };
}

/** Returns the actor when signed in, or null — used by public-ish endpoints. */
export async function optionalUser(request: Request): Promise<Actor | null> {
  try {
    return await requireUser(request);
  } catch {
    return null;
  }
}

/** Enforces a capability. Called inside EVERY administrative function. */
export function requirePermission(actor: Actor, permission: Permission): void {
  if (!actorCan(actor, permission)) {
    throw new ForbiddenError();
  }
}

export async function requireAdministrator(request: Request): Promise<Actor> {
  const actor = await requireUser(request);
  if (actor.role !== 'administrator') throw new ForbiddenError();
  return actor;
}

/** Convenience: authenticate then authorize in one step. */
export async function requireActorWith(
  request: Request,
  permission: Permission,
): Promise<Actor> {
  const actor = await requireUser(request);
  requirePermission(actor, permission);
  return actor;
}
