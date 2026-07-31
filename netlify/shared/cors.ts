/**
 * Cross-origin access for a separately hosted frontend — specification
 * section 34.
 *
 * The application is designed to be served from ONE origin, where the session
 * cookie is same-site and no CORS is involved at all. Hosting the UI on GitHub
 * Pages while the API runs elsewhere splits that into two origins, which forces
 * three changes:
 *
 *   1. The API must send CORS headers permitting credentials.
 *   2. The session cookie must become `SameSite=None`, or the browser will not
 *      attach it to a cross-site request at all. That is exactly the protection
 *      `SameSite=Lax` was providing against CSRF.
 *   3. Anything that is not a simple request costs a preflight round trip.
 *
 * Because of (2), the allow-list here is the ONLY thing standing between the
 * session cookie and any site that cares to ask for it. So:
 *
 *   - `Access-Control-Allow-Origin` is never `*`. The spec forbids pairing `*`
 *     with credentials and browsers reject it, but the real point is that an
 *     accidental wildcard would hand the session to every origin.
 *   - The inbound `Origin` is echoed back ONLY after an exact string match
 *     against the configured list. No prefix, suffix or regex matching — that
 *     is how `https://laxmitrading.github.io.attacker.example` gets through.
 *   - `Vary: Origin` is always set, so a shared cache can never serve one
 *     origin's permissive response to another.
 *
 * With `FRONTEND_ORIGINS` unset the module goes dormant: no CORS headers, and
 * the cookie stays `SameSite=Lax`. Single-origin deployments therefore keep the
 * stronger posture with no configuration at all.
 */

/** Origins permitted to call this API with credentials. Exact matches only. */
export function allowedOrigins(): string[] {
  const raw = process.env.FRONTEND_ORIGINS ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter((entry) => entry !== '');
}

/**
 * True when the UI is hosted on a different origin from the API.
 *
 * Drives both the CORS headers and the cookie's SameSite attribute, so the two
 * can never disagree — a cookie the browser refuses to send makes a perfectly
 * configured CORS policy useless, and the reverse is equally broken.
 */
export function isCrossSiteFrontend(): boolean {
  return allowedOrigins().length > 0;
}

function matchOrigin(request: Request): string | null {
  const origin = request.headers.get('origin');
  if (origin === null) return null;
  const normalized = origin.replace(/\/+$/, '');
  return allowedOrigins().includes(normalized) ? origin : null;
}

/**
 * CORS headers for a response, or just `Vary` when the request is same-origin
 * or the origin is not allow-listed.
 *
 * Returning no allow-origin for an unknown caller is deliberate: the browser
 * then blocks the response, which is the correct outcome. Echoing the origin
 * and relying on something downstream to reject it would put the policy
 * decision in the wrong place.
 */
/**
 * Response headers the browser lets client JavaScript read cross-origin.
 *
 * Without this the fetch still succeeds, but `response.headers.get(...)`
 * returns null for anything outside the tiny CORS-safelist — a silent,
 * same-origin-only-works failure rather than an error:
 *
 *   - `content-disposition` carries the export filename, so every .xlsx would
 *     save as the generic fallback name instead of the real one.
 *   - `x-correlation-id` is what ties a UI error back to the function logs;
 *     losing it reports 'unknown' on exactly the responses worth diagnosing.
 */
const EXPOSED_HEADERS = 'content-disposition, x-correlation-id';

export function corsHeaders(request: Request): Record<string, string> {
  if (!isCrossSiteFrontend()) return {};

  const origin = matchOrigin(request);
  // Vary even on refusal: the same URL genuinely differs per origin.
  if (origin === null) return { vary: 'Origin' };

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-expose-headers': EXPOSED_HEADERS,
    vary: 'Origin',
  };
}

/**
 * Answers the browser's preflight, or null when this is not one.
 *
 * `content-type` must be listed or every JSON POST/PATCH fails the preflight
 * outright — an unlisted request header is refused before the real request is
 * ever sent. `x-correlation-id` is listed ahead of need: the server generates
 * one today, and allowing the client to propagate its own later should not
 * require a CORS change to be remembered.
 *
 * `Access-Control-Max-Age` keeps the extra round trip off the hot path —
 * without it every mutating call costs two requests.
 */
export function preflightResponse(request: Request): Response | null {
  if (request.method !== 'OPTIONS' || !isCrossSiteFrontend()) return null;

  const headers = corsHeaders(request);
  if (headers['access-control-allow-origin'] === undefined) {
    // Unknown origin: refuse without disclosing the allow-list.
    return new Response(null, { status: 403, headers: { vary: 'Origin' } });
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, x-correlation-id',
      'access-control-max-age': '86400',
    },
  });
}
