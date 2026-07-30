/**
 * Authentication primitives — specification sections 4.5, 9, 34.
 */

import { describe, expect, it, vi } from 'vitest';
import { signJwt, verifyJwt, decodeJwtUnsafe } from '../../netlify/shared/auth/jwt';
import {
  hashPassword,
  hashToken,
  issueToken,
  passwordValidationMessage,
  verifyPassword,
} from '../../netlify/shared/auth/password';
import {
  buildClearSessionCookie,
  buildSessionCookie,
  parseCookies,
} from '../../netlify/shared/auth/session';
import { SessionExpiredError, UnauthenticatedError } from '../../netlify/shared/errors';

const PAYLOAD = {
  sub: 'user-1',
  sid: 'session-1',
  role: 'counter',
  email: 'counter@example.com',
  name: 'Test Counter',
};

describe('JWT', () => {
  it('round-trips a payload', () => {
    const token = signJwt(PAYLOAD, 3600);
    const verified = verifyJwt(token);

    expect(verified.sub).toBe('user-1');
    expect(verified.role).toBe('counter');
    expect(verified.exp).toBeGreaterThan(verified.iat);
  });

  it('rejects a tampered payload', () => {
    const token = signJwt(PAYLOAD, 3600);
    const [header, , signature] = token.split('.');

    const forgedPayload = Buffer.from(
      JSON.stringify({ ...PAYLOAD, role: 'administrator', iat: 0, exp: 9_999_999_999 }),
    ).toString('base64url');

    expect(() => verifyJwt(`${header}.${forgedPayload}.${signature}`)).toThrow(
      UnauthenticatedError,
    );
  });

  it('rejects the alg:none attack', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ ...PAYLOAD, exp: 9_999_999_999 }),
    ).toString('base64url');

    // No signature at all.
    expect(() => verifyJwt(`${header}.${payload}.`)).toThrow(UnauthenticatedError);
  });

  it('rejects an algorithm-confusion attempt', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ ...PAYLOAD, exp: 9_999_999_999 }),
    ).toString('base64url');

    expect(() => verifyJwt(`${header}.${payload}.anything`)).toThrow(UnauthenticatedError);
  });

  it('rejects a malformed token', () => {
    expect(() => verifyJwt('not-a-token')).toThrow(UnauthenticatedError);
    expect(() => verifyJwt('a.b')).toThrow(UnauthenticatedError);
  });

  it('distinguishes an EXPIRED token from a forged one', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const token = signJwt(PAYLOAD, 60);

      vi.setSystemTime(new Date('2026-01-01T00:02:00Z'));
      // The UI needs "your session ended" to differ from "sign in".
      expect(() => verifyJwt(token)).toThrow(SessionExpiredError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('decodeJwtUnsafe never validates', () => {
    const token = signJwt(PAYLOAD, 3600);
    expect(decodeJwtUnsafe(token)?.sub).toBe('user-1');
    expect(decodeJwtUnsafe('garbage')).toBeNull();
  });
});

describe('password hashing', () => {
  it('verifies a correct password', async () => {
    const record = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('correct horse battery staple', record)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const record = await hashPassword('correct horse battery staple');
    await expect(verifyPassword('wrong password entirely', record)).resolves.toBe(false);
  });

  it('produces a unique salt per password', async () => {
    const first = await hashPassword('same password');
    const second = await hashPassword('same password');

    expect(first.salt).not.toBe(second.salt);
    // Same input, different hash: rainbow tables are useless.
    expect(first.hash).not.toBe(second.hash);
  });

  it('returns false — without throwing — when no hash is stored', async () => {
    // This path runs for a non-existent email, so it must not reveal anything.
    await expect(verifyPassword('anything', { hash: null, salt: null })).resolves.toBe(false);
  });
});

describe('password strength (section 34)', () => {
  it('requires at least 12 characters', () => {
    expect(passwordValidationMessage('short')).toContain('12');
    expect(passwordValidationMessage('abcdefghijk')).toContain('12');
  });

  it('requires three character classes', () => {
    expect(passwordValidationMessage('alllowercaseletters')).toContain('three');
    expect(passwordValidationMessage('Passw0rd!Passw0rd')).toBeNull();
  });

  it('rejects an absurdly long password', () => {
    expect(passwordValidationMessage('Aa1!'.repeat(100))).toContain('200');
  });
});

describe('single-use tokens', () => {
  it('stores only the hash, never the token', () => {
    const issued = issueToken(3600);

    expect(issued.token).not.toBe(issued.tokenHash);
    // A database leak must not yield a usable link.
    expect(issued.tokenHash).toBe(hashToken(issued.token));
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('produces a distinct token every time', () => {
    expect(issueToken(60).token).not.toBe(issueToken(60).token);
  });
});

describe('session cookies (section 34)', () => {
  it('is HttpOnly, SameSite=Lax and path-scoped', () => {
    const cookie = buildSessionCookie('token-value', 3600);

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('expires the cookie on sign-out', () => {
    expect(buildClearSessionCookie()).toContain('Max-Age=0');
  });

  it('parses a cookie header', () => {
    const cookies = parseCookies(
      new Request('http://localhost/', { headers: { cookie: 'a=1; sr_session=abc%3Ddef; b=2' } }),
    );

    expect(cookies.a).toBe('1');
    expect(cookies.sr_session).toBe('abc=def');
    expect(cookies.b).toBe('2');
  });

  it('returns an empty object when there is no cookie header', () => {
    expect(parseCookies(new Request('http://localhost/'))).toEqual({});
  });
});
