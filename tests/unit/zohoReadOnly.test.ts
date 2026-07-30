/**
 * READ-ONLY ZOHO GUARANTEE — specification sections 2.1 and 41 (scenario 14).
 *
 * "Assert that the Zoho Books integration layer never sends mutation
 * methods."
 *
 * These tests intercept `fetch` and fail if any request to a Zoho Books
 * host uses anything other than GET.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { postToAccountsEndpoint, zohoGet } from '../../netlify/shared/zoho/client';
import { ZohoReadOnlyViolationError } from '../../netlify/shared/errors';

interface RecordedRequest {
  url: string;
  method: string;
}

let recorded: RecordedRequest[] = [];

function installFetchSpy(response: unknown = { items: [] }, status = 200): void {
  recorded = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
      recorded.push({ url, method });

      return new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const BASE_OPTIONS = {
  accessToken: 'test-token',
  apiDomain: 'https://www.zohoapis.in',
  organizationId: '60000000001',
  correlationId: 'test-correlation',
};

beforeEach(() => installFetchSpy());
afterEach(() => vi.unstubAllGlobals());

describe('zohoGet', () => {
  it('issues GET and nothing else', async () => {
    await zohoGet({ ...BASE_OPTIONS, path: '/books/v3/items' });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.method).toBe('GET');
  });

  it('always includes the organization id', async () => {
    await zohoGet({ ...BASE_OPTIONS, path: '/books/v3/items' });
    expect(recorded[0]?.url).toContain('organization_id=60000000001');
  });

  it('passes search parameters through', async () => {
    await zohoGet({
      ...BASE_OPTIONS,
      path: '/books/v3/items',
      searchParams: { sku: 'ABC-001', per_page: 50 },
    });
    expect(recorded[0]?.url).toContain('sku=ABC-001');
    expect(recorded[0]?.url).toContain('per_page=50');
  });

  it('targets the configured API domain, never a hardcoded US one', async () => {
    await zohoGet({ ...BASE_OPTIONS, path: '/books/v3/items' });
    expect(recorded[0]?.url).toContain('www.zohoapis.in');
    expect(recorded[0]?.url).not.toContain('zohoapis.com');
  });
});

describe('the module surface itself', () => {
  it('exports no function capable of a mutating Books request', async () => {
    const module = await import('../../netlify/shared/zoho/client');
    const exported = Object.keys(module);

    // There is deliberately no post/put/patch/delete counterpart to zohoGet.
    expect(exported).toContain('zohoGet');
    for (const name of exported) {
      expect(name.toLowerCase()).not.toMatch(/^zoho(post|put|patch|delete)/);
    }
  });
});

describe('accounts-endpoint POST (permitted by section 2.1)', () => {
  it('allows a token request to accounts.zoho.in', async () => {
    installFetchSpy({ access_token: 'a', expires_in: 3600 });

    await postToAccountsEndpoint({
      accountsDomain: 'https://accounts.zoho.in',
      path: '/oauth/v2/token',
      form: { grant_type: 'refresh_token' },
    });

    expect(recorded[0]?.method).toBe('POST');
    expect(recorded[0]?.url).toContain('accounts.zoho.in');
    // Crucially, this is NOT an inventory endpoint.
    expect(recorded[0]?.url).not.toContain('/inventory/');
  });

  it('REFUSES to POST at a non-accounts host', async () => {
    await expect(
      postToAccountsEndpoint({
        accountsDomain: 'https://www.zohoapis.in',
        path: '/books/v3/items',
        form: {},
      }),
    ).rejects.toBeInstanceOf(ZohoReadOnlyViolationError);

    // Nothing was sent at all.
    expect(recorded).toHaveLength(0);
  });

  it('REFUSES an attacker-controlled lookalike host', async () => {
    await expect(
      postToAccountsEndpoint({
        accountsDomain: 'https://accounts.zoho.in.evil.example.com',
        path: '/oauth/v2/token',
        form: {},
      }),
    ).rejects.toBeInstanceOf(ZohoReadOnlyViolationError);

    expect(recorded).toHaveLength(0);
  });
});

describe('end-to-end assertion over a realistic call sequence', () => {
  it('never records a mutating method against a Books host', async () => {
    installFetchSpy({ items: [{ item_id: '1', sku: 'ABC-001', name: 'Item' }] });

    await zohoGet({ ...BASE_OPTIONS, path: '/books/v3/items', searchParams: { sku: 'ABC-001' } });
    await zohoGet({ ...BASE_OPTIONS, path: '/books/v3/items/1' });
    await zohoGet({ ...BASE_OPTIONS, path: '/books/v3/items/9' });
    await zohoGet({ ...BASE_OPTIONS, path: '/books/v3/organizations' });
    await zohoGet({ ...BASE_OPTIONS, path: '/books/v3/locations' });

    // The >0 assertion matters: without it a mis-typed filter would make this
    // pass vacuously while observing nothing at all.
    const resourceRequests = recorded.filter((request) => request.url.includes('/books/'));
    expect(resourceRequests.length).toBeGreaterThan(0);

    for (const request of resourceRequests) {
      expect(request.method).toBe('GET');
      expect(['POST', 'PUT', 'PATCH', 'DELETE']).not.toContain(request.method);
    }
  });
});
