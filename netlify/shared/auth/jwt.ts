/**
 * HS256 JSON Web Tokens — specification section 4.5.
 *
 * Implemented on `node:crypto` rather than a third-party library so the
 * verification path is small enough to audit in full. Only HS256 is accepted:
 * the `alg` header is checked against a constant, which closes the classic
 * "alg: none" and algorithm-confusion attacks.
 *
 * The signing secret lives in AUTH_JWT_SECRET and never leaves the server.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { SessionExpiredError, UnauthenticatedError } from '../errors';

const ALGORITHM = 'HS256';

export interface JwtPayload {
  /** Subject — the profile ID. */
  sub: string;
  /** Issued at (seconds since epoch). */
  iat: number;
  /** Expiry (seconds since epoch). */
  exp: number;
  /** Session identifier, so a single session can be invalidated. */
  sid: string;
  role: string;
  email: string;
  name: string;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url');
}

function getSecret(): Buffer {
  const secret = process.env.AUTH_JWT_SECRET;
  if (secret === undefined || secret.length < 32) {
    throw new Error(
      'AUTH_JWT_SECRET is missing or shorter than 32 characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"',
    );
  }
  return Buffer.from(secret, 'utf8');
}

function sign(data: string): string {
  return createHmac('sha256', getSecret()).update(data).digest('base64url');
}

export function signJwt(payload: Omit<JwtPayload, 'iat' | 'exp'>, lifetimeSeconds: number): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const fullPayload: JwtPayload = {
    ...payload,
    iat: issuedAt,
    exp: issuedAt + lifetimeSeconds,
  };

  const header = base64UrlEncode(JSON.stringify({ alg: ALGORITHM, typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = sign(`${header}.${body}`);

  return `${header}.${body}.${signature}`;
}

/**
 * Verifies signature and expiry, then returns the payload.
 * Throws `UnauthenticatedError` for a malformed/forged token and
 * `SessionExpiredError` for a well-formed but expired one, so the UI can tell
 * "sign in" from "your session ended" (section 37).
 */
export function verifyJwt(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new UnauthenticatedError('Malformed session token.');

  const [header, body, signature] = parts as [string, string, string];

  let decodedHeader: { alg?: unknown; typ?: unknown };
  try {
    decodedHeader = JSON.parse(base64UrlDecode(header).toString('utf8'));
  } catch {
    throw new UnauthenticatedError('Malformed session token.');
  }
  // Reject anything that is not exactly HS256 — never trust the token's own
  // algorithm claim to select the verification routine.
  if (decodedHeader.alg !== ALGORITHM) {
    throw new UnauthenticatedError('Unsupported token algorithm.');
  }

  const expected = sign(`${header}.${body}`);
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    throw new UnauthenticatedError('Session token signature is not valid.');
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString('utf8')) as JwtPayload;
  } catch {
    throw new UnauthenticatedError('Malformed session token.');
  }

  if (typeof payload.exp !== 'number' || typeof payload.sub !== 'string') {
    throw new UnauthenticatedError('Malformed session token.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new SessionExpiredError();

  return payload;
}

/** Reads the payload WITHOUT verifying. Only for logging non-sensitive fields. */
export function decodeJwtUnsafe(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(base64UrlDecode(parts[1] as string).toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
}
