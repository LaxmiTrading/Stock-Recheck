/**
 * CROSS-ORIGIN ACCESS for a separately hosted frontend — specification
 * section 34.
 *
 * Serving the UI from GitHub Pages while the API stays on Netlify forces the
 * session cookie down to `SameSite=None`, which removes the browser's built-in
 * CSRF protection. The origin allow-list is what replaces it, so these tests
 * exist to keep that list strict — an over-permissive match here hands the
 * session to whoever asks.
 *
 * The two halves are deliberately tested together: a cookie the browser refuses
 * to send makes a perfect CORS policy useless, and the reverse is equally
 * broken, so `isCrossSiteFrontend` must drive both or neither.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { corsHeaders, isCrossSiteFrontend, preflightResponse } from '../../netlify/shared/cors';
import {
  buildClearSessionCookie,
  buildSessionCookie,
} from '../../netlify/shared/auth/session';

const PAGES_ORIGIN = 'https://laxmitrading.github.io';

const originalEnv = { ...process.env };

beforeEach(() => {
  delete process.env.FRONTEND_ORIGINS;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

/** A request as the browser would send it from `origin`. */
function requestFrom(origin: string | null, method = 'GET'): Request {
  return new Request('https://api.example.netlify.app/api/rechecks', {
    method,
    headers: origin === null ? {} : { origin },
  });
}

describe('single-origin deployment (FRONTEND_ORIGINS unset)', () => {
  it('adds no CORS headers at all', () => {
    expect(isCrossSiteFrontend()).toBe(false);
    expect(corsHeaders(requestFrom(PAGES_ORIGIN))).toEqual({});
  });

  it('does not intercept OPTIONS', () => {
    expect(preflightResponse(requestFrom(PAGES_ORIGIN, 'OPTIONS'))).toBeNull();
  });

  it('keeps the session cookie on SameSite=Lax', () => {
    process.env.APP_BASE_URL = 'https://api.example.netlify.app';

    expect(buildSessionCookie('token', 3600)).toContain('SameSite=Lax');
  });
});

describe('allow-list matching', () => {
  beforeEach(() => {
    process.env.FRONTEND_ORIGINS = PAGES_ORIGIN;
  });

  it('echoes an allow-listed origin and permits credentials', () => {
    const headers = corsHeaders(requestFrom(PAGES_ORIGIN));

    expect(headers['access-control-allow-origin']).toBe(PAGES_ORIGIN);
    expect(headers['access-control-allow-credentials']).toBe('true');
  });

  it('never answers with a wildcard', () => {
    // `*` is invalid with credentials and would expose the session to everyone.
    expect(corsHeaders(requestFrom(PAGES_ORIGIN))['access-control-allow-origin']).not.toBe('*');
  });

  it('always sets Vary: Origin, including on refusal', () => {
    // Without this a shared cache can serve one origin's permissive response
    // to a different origin.
    expect(corsHeaders(requestFrom(PAGES_ORIGIN)).vary).toBe('Origin');
    expect(corsHeaders(requestFrom('https://evil.example')).vary).toBe('Origin');
  });

  it('refuses an origin that is not on the list', () => {
    const headers = corsHeaders(requestFrom('https://evil.example'));

    expect(headers['access-control-allow-origin']).toBeUndefined();
  });

  it.each([
    // The classic suffix attack: a prefix match would let this through.
    'https://laxmitrading.github.io.attacker.example',
    // A prefix match would let this through.
    'https://evil.example?x=https://laxmitrading.github.io',
    // Scheme matters — http is a different origin and is not trusted.
    'http://laxmitrading.github.io',
    // A subdomain is a different origin.
    'https://pages.laxmitrading.github.io',
  ])('refuses the near-miss origin %s', (origin) => {
    expect(corsHeaders(requestFrom(origin))['access-control-allow-origin']).toBeUndefined();
  });

  it('ignores surrounding whitespace and trailing slashes in configuration', () => {
    process.env.FRONTEND_ORIGINS = ` ${PAGES_ORIGIN}/ , https://staging.example `;

    expect(corsHeaders(requestFrom(PAGES_ORIGIN))['access-control-allow-origin']).toBe(
      PAGES_ORIGIN,
    );
    expect(corsHeaders(requestFrom('https://staging.example'))['access-control-allow-origin']).toBe(
      'https://staging.example',
    );
  });

  it('adds nothing for a same-origin request, which sends no Origin header', () => {
    expect(corsHeaders(requestFrom(null))['access-control-allow-origin']).toBeUndefined();
  });
});

describe('response headers readable by the client', () => {
  beforeEach(() => {
    process.env.FRONTEND_ORIGINS = PAGES_ORIGIN;
  });

  /*
   * Cross-origin JavaScript can only read the CORS-safelisted response headers
   * unless they are explicitly exposed. Both of these are read by
   * src/services/api.ts, and the failure is silent rather than an error: the
   * export saves under a generic filename, and errors report an unknown
   * correlation ID.
   */
  it.each(['content-disposition', 'x-correlation-id'])('exposes %s', (header) => {
    expect(corsHeaders(requestFrom(PAGES_ORIGIN))['access-control-expose-headers']).toContain(
      header,
    );
  });
});

describe('preflight', () => {
  beforeEach(() => {
    process.env.FRONTEND_ORIGINS = PAGES_ORIGIN;
  });

  it('answers an allow-listed OPTIONS with 204 and the permitted methods', () => {
    const response = preflightResponse(requestFrom(PAGES_ORIGIN, 'OPTIONS'));

    expect(response?.status).toBe(204);
    expect(response?.headers.get('access-control-allow-origin')).toBe(PAGES_ORIGIN);
    expect(response?.headers.get('access-control-allow-credentials')).toBe('true');
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(response?.headers.get('access-control-allow-methods')).toContain(method);
    }
  });

  it('permits the content-type header the client actually sends', () => {
    // An unlisted request header fails the preflight outright, and every
    // POST/PATCH in the app sends a JSON content-type.
    const response = preflightResponse(requestFrom(PAGES_ORIGIN, 'OPTIONS'));

    expect(response?.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('rejects an unknown origin without disclosing the allow-list', () => {
    const response = preflightResponse(requestFrom('https://evil.example', 'OPTIONS'));

    expect(response?.status).toBe(403);
    expect(response?.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('leaves non-OPTIONS requests to the handler', () => {
    expect(preflightResponse(requestFrom(PAGES_ORIGIN, 'POST'))).toBeNull();
  });
});

describe('session cookie under a cross-site frontend', () => {
  beforeEach(() => {
    process.env.FRONTEND_ORIGINS = PAGES_ORIGIN;
  });

  it('switches to SameSite=None over https, paired with Secure', () => {
    process.env.APP_BASE_URL = 'https://api.example.netlify.app';
    const cookie = buildSessionCookie('token', 3600);

    // A browser silently DROPS SameSite=None without Secure, so the two must
    // always travel together.
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
  });

  it('stays on SameSite=Lax over plain http', () => {
    // Local development is same-origin through `netlify dev`, and SameSite=None
    // would be discarded by the browser anyway without Secure.
    process.env.APP_BASE_URL = 'http://localhost:8888';
    process.env.NODE_ENV = 'development';

    expect(buildSessionCookie('token', 3600)).toContain('SameSite=Lax');
  });

  it('clears the cookie with matching attributes', () => {
    process.env.APP_BASE_URL = 'https://api.example.netlify.app';
    const cookie = buildClearSessionCookie();

    // The browser only replaces a cookie when the attributes line up; a
    // mismatch here leaves the old session cookie in place on sign-out.
    expect(cookie).toContain('SameSite=None');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Max-Age=0');
  });
});
