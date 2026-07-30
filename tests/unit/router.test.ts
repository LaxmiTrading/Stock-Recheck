/**
 * Function router — specification sections 7 and 31.
 *
 * Path parameters in this API are always UUIDs. Enforcing that in the router
 * keeps a malformed identifier from reaching a repository (where Postgres
 * would raise "invalid input syntax for type uuid" and turn a bad request into
 * a 500) and stops unrelated paths from matching a `:id` route.
 */

import { describe, expect, it, vi } from 'vitest';
import { matchRoute, type Route } from '../../netlify/shared/http';
import { MethodNotAllowedError } from '../../netlify/shared/errors';

const noop = vi.fn(async () => new Response('ok'));

const ROUTES: Route[] = [
  { method: 'GET', pattern: '/api/admin/users', handler: noop },
  { method: 'POST', pattern: '/api/admin/users/invite', handler: noop },
  { method: 'PATCH', pattern: '/api/admin/users/:id', handler: noop },
  { method: 'GET', pattern: '/api/rechecks/:recheckId/items/:itemId', handler: noop },
  { method: 'GET', pattern: '/api/rechecks/:id/export.xlsx', handler: noop },
];

const UUID_A = '5383d9fb-e19a-4694-a0c0-0cb52c28cb24';
const UUID_B = 'd840094c-bb6b-44c5-acf1-5398ef64439c';

function request(method: string, path: string): Request {
  return new Request(`http://localhost:8888${path}`, { method });
}

describe('matchRoute', () => {
  it('matches a static route', () => {
    const match = matchRoute(ROUTES, request('GET', '/api/admin/users'));
    expect(match).not.toBeNull();
    expect(match?.params).toEqual({});
  });

  it('extracts UUID parameters', () => {
    const match = matchRoute(
      ROUTES,
      request('GET', `/api/rechecks/${UUID_A}/items/${UUID_B}`),
    );
    expect(match?.params).toEqual({ recheckId: UUID_A, itemId: UUID_B });
  });

  it('prefers a static segment over a parameter at the same position', () => {
    // /api/admin/users/invite must not be swallowed by /api/admin/users/:id.
    const match = matchRoute(ROUTES, request('POST', '/api/admin/users/invite'));
    expect(match).not.toBeNull();
    expect(match?.params).toEqual({});
  });

  it('returns null for an unknown path', () => {
    expect(matchRoute(ROUTES, request('GET', '/api/nope'))).toBeNull();
  });

  it('throws 405 when the path matches but the method does not', () => {
    expect(() => matchRoute(ROUTES, request('DELETE', '/api/admin/users'))).toThrow(
      MethodNotAllowedError,
    );
  });

  it('ignores a trailing slash', () => {
    expect(matchRoute(ROUTES, request('GET', '/api/admin/users/'))).not.toBeNull();
  });

  it('ignores the query string', () => {
    const match = matchRoute(ROUTES, request('GET', '/api/admin/users?page=2&pageSize=50'));
    expect(match).not.toBeNull();
  });

  it('matches a route whose last segment contains a dot', () => {
    const match = matchRoute(ROUTES, request('GET', `/api/rechecks/${UUID_A}/export.xlsx`));
    expect(match?.params).toEqual({ id: UUID_A });
  });
});

describe('matchRoute — parameter constraints', () => {
  it('does NOT match a non-UUID parameter', () => {
    // Without the constraint this matched PATCH /api/admin/users/:id and
    // produced a misleading 405 for a static-asset probe.
    expect(matchRoute(ROUTES, request('GET', '/api/admin/users/index.html'))).toBeNull();
  });

  it('does not let a bad identifier reach a handler', () => {
    expect(matchRoute(ROUTES, request('PATCH', '/api/admin/users/not-a-uuid'))).toBeNull();
    expect(matchRoute(ROUTES, request('PATCH', '/api/admin/users/12345'))).toBeNull();
    expect(matchRoute(ROUTES, request('PATCH', "/api/admin/users/1' OR '1'='1"))).toBeNull();
  });

  it('accepts a valid UUID for the same route', () => {
    const match = matchRoute(ROUTES, request('PATCH', `/api/admin/users/${UUID_A}`));
    expect(match?.params).toEqual({ id: UUID_A });
  });

  it('rejects a UUID-shaped value with the wrong length', () => {
    expect(matchRoute(ROUTES, request('PATCH', '/api/admin/users/5383d9fb-e19a-4694'))).toBeNull();
  });

  it('honours an explicit per-route constraint', () => {
    const routes: Route[] = [
      {
        method: 'GET',
        pattern: '/api/reports/:slug',
        handler: noop,
        constraints: { slug: /^[a-z-]+$/ },
      },
    ];

    expect(matchRoute(routes, request('GET', '/api/reports/daily-summary'))?.params).toEqual({
      slug: 'daily-summary',
    });
    expect(matchRoute(routes, request('GET', '/api/reports/Daily_Summary'))).toBeNull();
  });
});
