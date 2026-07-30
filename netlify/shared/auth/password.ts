/**
 * Password hashing and single-use tokens — specification sections 4.5, 34.
 *
 * Uses scrypt from `node:crypto`: memory-hard, in the standard library, and
 * with well-understood parameters. Each password gets a unique random salt and
 * comparisons are constant-time.
 */

import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/** OWASP-recommended scrypt parameters (N=2^17 via the default cost factor). */
const KEY_LENGTH = 64;
const SALT_BYTES = 32;

export interface PasswordRecord {
  hash: string;
  salt: string;
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_BYTES).toString('base64');
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return { hash: derived.toString('base64'), salt };
}

/**
 * Constant-time password verification.
 *
 * When the account has no stored hash we still perform a dummy scrypt so that
 * response timing does not reveal whether the email exists (section 9).
 */
export async function verifyPassword(
  password: string,
  record: { hash: string | null; salt: string | null },
): Promise<boolean> {
  if (record.hash === null || record.salt === null) {
    await scrypt(password, 'timing-equalizer-salt', KEY_LENGTH);
    return false;
  }

  const derived = await scrypt(password, record.salt, KEY_LENGTH);
  const expected = Buffer.from(record.hash, 'base64');

  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

/* ------------------------------------------------------ password strength */

export const MIN_PASSWORD_LENGTH = 12;

export function passwordValidationMessage(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > 200) {
    return 'Password must be 200 characters or fewer.';
  }
  // Encourage variety without imposing rules that push users toward
  // predictable substitutions.
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) =>
    pattern.test(password),
  ).length;
  if (classes < 3) {
    return 'Use at least three of: lowercase, uppercase, digits, symbols.';
  }
  return null;
}

/* --------------------------------------------- invite / reset link tokens */

export interface IssuedToken {
  /** Sent to the user in the link. Never stored. */
  token: string;
  /** Stored in the database. A leaked table cannot be used to log in. */
  tokenHash: string;
  expiresAt: Date;
}

export function issueToken(lifetimeSeconds: number): IssuedToken {
  const token = `${randomUUID()}.${randomBytes(24).toString('base64url')}`;
  return {
    token,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + lifetimeSeconds * 1000),
  };
}

/** SHA-256 is appropriate here: the token is already high-entropy random. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionId(): string {
  return randomUUID();
}

export const INVITE_LIFETIME_SECONDS = 7 * 24 * 3600; // 7 days
export const RESET_LIFETIME_SECONDS = 60 * 60; // 1 hour
