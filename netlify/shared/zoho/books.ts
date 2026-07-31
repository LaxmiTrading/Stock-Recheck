/**
 * Zoho Books read operations — specification sections 16 and 32.
 *
 * Everything here is GET-only; the transport itself refuses any other method.
 * Field access is defensive: Zoho's payload differs between accounts that use
 * locations or custom fields, so we probe several plausible field names and
 * fall back to the documented "not available" strings rather than failing a
 * row (section 16).
 *
 * ------------------------------------------------------------------------
 * WHY BOOKS AND NOT INVENTORY
 * The Zoho API console issues a refresh token against ONE product family. A
 * `ZohoBooks.*` token is rejected by every `/inventory/v1/*` endpoint with
 * HTTP 401 code 57 ("You are not authorized to perform this operation"), and
 * the reverse is equally true — the failure is an authorization error, not a
 * missing-feature error, so it is easy to misread as a bad token.
 *
 * Books has no item groups and no warehouses; both are Inventory-only
 * concepts. Stock lives on the item itself and on locations.
 * ------------------------------------------------------------------------
 */

import { toNormalizedSku } from '../../../src/domain/sku';
import { resolveStockQuantity, type StockBasis } from '../../../src/domain/stockBasis';
import {
  ZohoAuthenticationError,
  ZohoRateLimitedError,
  ZohoUnexpectedResponseError,
} from '../errors';
import { mapWithConcurrency, zohoGet } from './client';
import { getAccessToken, invalidateAccessToken, requireResolvedCredentials } from './tokens';
import type {
  ZohoItemDetail,
  ZohoItemResponse,
  ZohoItemsListResponse,
  ZohoItemSummary,
  ZohoLocationRecord,
  ZohoLocationsResponse,
  ZohoOrganization,
  ZohoOrganizationsResponse,
  ZohoWarehouseRecord,
} from './types';

/** Section 32: bounded concurrency against Zoho. */
export const ZOHO_CONCURRENCY = 4;

/*
 * Bulk-resolution tuning.
 *
 * Resolving a SKU one at a time costs TWO Zoho round trips (a search, then a
 * detail fetch). At 1200+ SKUs that is ~2500 requests, which no serverless
 * request budget accommodates — the function is killed and the browser gets a
 * non-JSON error page.
 *
 * Paging the whole item catalogue instead costs `ceil(items / 200)` requests
 * regardless of how many SKUs are being imported, so the cost stops scaling
 * with the import and starts scaling with the catalogue.
 */

/** Zoho's maximum page size for /items. */
const CATALOGUE_PAGE_SIZE = 200;

/**
 * Below this many unique SKUs, per-SKU lookups are cheaper than paging the
 * whole catalogue — and they return richer per-item detail. Above it, the
 * single catalogue sweep wins by an increasing margin.
 */
const BULK_LOOKUP_THRESHOLD = 25;

/** Refuses to page forever if `has_more_page` never goes false. */
const MAX_CATALOGUE_PAGES = 500;

/**
 * Pages fetched in parallel.
 *
 * A real catalogue here is ~10,000 items — 51 pages at roughly 600 ms each,
 * which is ~36 s sequentially and therefore still over the platform ceiling
 * even after the request count collapsed. The pages are independent, so
 * fetching them in waves brings that back under ten seconds.
 *
 * Kept modest because the point is to fit the budget, not to hammer Zoho: 51
 * requests spread over a few seconds sits far inside a per-minute quota, and
 * `withRateLimitRetry` absorbs a burst if one is hit anyway.
 */
const CATALOGUE_PAGE_CONCURRENCY = 6;

/** Attempts per page when Zoho answers 429. */
const RATE_LIMIT_RETRIES = 3;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retries a rate-limited call with linear backoff.
 *
 * Only 429 is retried. Anything else — including an auth failure — propagates
 * immediately, because repeating it would waste the request budget the sweep is
 * trying to conserve.
 */
async function withRateLimitRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ZohoRateLimitedError) || attempt >= RATE_LIMIT_RETRIES) throw error;
      await delay(attempt * 1000);
    }
  }
}

/* ---------------------------------------------------------- field helpers */

function firstNonEmptyString(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return null;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Section 16 — item is active. */
export function isItemActive(item: ZohoItemSummary): boolean {
  const status = (item.status ?? '').toLowerCase();
  // Absent status is treated as active: some list responses omit it.
  return status === '' || status === 'active';
}

/**
 * Section 16 — item is a stock-tracked inventory item.
 * Zoho signals this through `product_type: 'goods'` combined with either
 * `item_type: 'inventory'` or `track_inventory: true`, depending on API version.
 */
export function isInventoryTracked(item: ZohoItemSummary): boolean {
  const productType = (item.product_type ?? '').toLowerCase();
  if (productType === 'service' || productType === 'digital_service') return false;

  const itemType = (item.item_type ?? '').toLowerCase();
  if (itemType === 'inventory') return true;
  if (item.track_inventory === true) return true;

  // When neither signal is present, fall back to "has a stock figure".
  if (itemType === '' && item.track_inventory === undefined) {
    return toNumberOrNull(item.stock_on_hand) !== null;
  }
  return false;
}

/* ------------------------------------------------------------- reader API */

export interface ResolvedZohoItem {
  zohoItemId: string;
  itemName: string;
  sku: string;
  normalizedSku: string;
  stockInHand: number;
  vendorName: string | null;
  unit: string | null;
}

export type SkuLookupOutcome =
  | { kind: 'found'; item: ZohoItemDetail }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; matchCount: number }
  /**
   * One SKU's lookup threw while the others succeeded.
   *
   * Only `lookupManyBySku` produces this — `lookupBySku` throws instead. It
   * keeps section 15's rule intact: a single failing SKU must never fail the
   * batch, so the error is carried back attached to the SKU that caused it
   * rather than rejecting the whole call.
   */
  | { kind: 'error'; error: unknown };

/**
 * The read surface the validator depends on. Both the live client and the mock
 * implement it, so mock mode exercises the same code path.
 */
export interface BooksReader {
  lookupBySku(sku: string, correlationId: string): Promise<SkuLookupOutcome>;
  /**
   * Resolves MANY SKUs at once — see `LiveBooksReader.lookupManyBySku` for why
   * this exists rather than the caller looping over `lookupBySku`.
   */
  lookupManyBySku(
    skus: readonly string[],
    correlationId: string,
    options?: {
      signal?: AbortSignal;
      /** Forces per-SKU detail fetches, for data the list payload omits. */
      requireDetail?: boolean;
    },
  ): Promise<Map<string, SkuLookupOutcome>>;
  listOrganizations(correlationId: string): Promise<ZohoOrganization[]>;
  listLocations(
    correlationId: string,
  ): Promise<{ locations: ZohoLocationRecord[]; warehouses: ZohoWarehouseRecord[] }>;
  testConnection(correlationId: string): Promise<{ organizationName: string | null; responseMs: number }>;
  readonly isMock: boolean;
}

/* --------------------------------------------------------- live implementation */

async function getWithAuthRetry<Body>(params: {
  path: string;
  searchParams?: Record<string, string | number | undefined>;
  correlationId: string;
}): Promise<Body> {
  const credentials = await requireResolvedCredentials();

  const run = async (forceRefresh: boolean): Promise<Body> => {
    const { accessToken, apiDomain } = await getAccessToken(params.correlationId, { forceRefresh });
    const response = await zohoGet<Body>({
      path: params.path,
      searchParams: params.searchParams,
      accessToken,
      apiDomain,
      organizationId: credentials.organizationId,
      correlationId: params.correlationId,
    });
    return response.body;
  };

  try {
    return await run(false);
  } catch (error) {
    // Section 32: on a 401, refresh ONCE and retry ONCE. A second failure
    // propagates so the caller can mark the connection unhealthy.
    if (error instanceof ZohoAuthenticationError) {
      invalidateAccessToken();
      return run(true);
    }
    throw error;
  }
}

class LiveBooksReader implements BooksReader {
  readonly isMock = false;

  /**
   * Exact-SKU search — section 16 step 4.
   *
   * Zoho's `sku` filter is an exact match server-side, but we re-verify every
   * returned row against the normalized SKU because some Zoho versions treat
   * the parameter as a prefix search. Anything that survives that check and
   * leaves more than one item is genuinely ambiguous.
   */
  async lookupBySku(sku: string, correlationId: string): Promise<SkuLookupOutcome> {
    const normalized = toNormalizedSku(sku);

    const listResponse = await getWithAuthRetry<ZohoItemsListResponse>({
      path: '/books/v3/items',
      searchParams: { sku, per_page: 50 },
      correlationId,
    });

    const candidates = (listResponse.items ?? []).filter(
      (item) => toNormalizedSku(item.sku ?? '') === normalized,
    );

    if (candidates.length === 0) return { kind: 'not_found' };
    if (candidates.length > 1) return { kind: 'ambiguous', matchCount: candidates.length };

    const summary = candidates[0] as ZohoItemSummary;
    const itemId = summary.item_id;
    if (typeof itemId !== 'string' || itemId === '') {
      throw new ZohoUnexpectedResponseError('Zoho returned an item without an identifier.');
    }

    // Step 9: fetch full detail for stock breakdown, vendor and attributes.
    const detailResponse = await getWithAuthRetry<ZohoItemResponse>({
      path: `/books/v3/items/${encodeURIComponent(itemId)}`,
      correlationId,
    });

    const detail = detailResponse.item;
    if (detail === undefined) {
      throw new ZohoUnexpectedResponseError('Zoho returned an empty item detail response.');
    }

    return { kind: 'found', item: { ...summary, ...detail } };
  }

  /**
   * Resolves many SKUs with a cost that does not scale with the import size.
   *
   * For a large import this pages the entire item catalogue ONCE and matches
   * locally, turning ~2N requests into `ceil(items / 200)`. A 1200-SKU import
   * drops from roughly 2500 Zoho calls to about a dozen, which is the
   * difference between a request that is killed mid-flight and one that
   * finishes well inside the budget.
   *
   * The list payload carries everything a snapshot needs — `item_id`, `name`,
   * `sku`, `status`, `product_type`, `track_inventory`, `stock_on_hand`,
   * `unit`, `vendor_name`. It does NOT carry the per-location stock breakdown,
   * so a location-based stock basis still needs the detail call and says so via
   * `requireDetail`.
   *
   * Small imports keep the per-SKU path: pulling a whole catalogue to resolve
   * five SKUs would be slower, not faster.
   */
  async lookupManyBySku(
    skus: readonly string[],
    correlationId: string,
    options: { signal?: AbortSignal; requireDetail?: boolean } = {},
  ): Promise<Map<string, SkuLookupOutcome>> {
    const results = new Map<string, SkuLookupOutcome>();
    const unique = [...new Set(skus.map((sku) => toNormalizedSku(sku)))].filter((s) => s !== '');
    if (unique.length === 0) return results;

    if (unique.length < BULK_LOOKUP_THRESHOLD || options.requireDetail === true) {
      await mapWithConcurrency(unique, ZOHO_CONCURRENCY, async (sku) => {
        if (options.signal?.aborted === true) return;
        try {
          results.set(sku, await this.lookupBySku(sku, correlationId));
        } catch (error) {
          // Broken authentication is not a per-SKU problem — every remaining
          // lookup would fail the same way, so stop rather than burn them.
          if (error instanceof ZohoAuthenticationError) throw error;
          results.set(sku, { kind: 'error', error });
        }
      });
      return results;
    }

    /* ---- one sweep of the catalogue ------------------------------------- */

    const bySku = new Map<string, ZohoItemSummary[]>();

    const fetchPage = async (page: number): Promise<ZohoItemsListResponse> =>
      withRateLimitRetry(() =>
        getWithAuthRetry<ZohoItemsListResponse>({
          path: '/books/v3/items',
          searchParams: { page, per_page: CATALOGUE_PAGE_SIZE },
          correlationId,
        }),
      );

    const absorb = (response: ZohoItemsListResponse): void => {
      for (const item of response.items ?? []) {
        // Normalized the same way as the per-SKU path, so both agree on what
        // counts as a match.
        const normalized = toNormalizedSku(item.sku ?? '');
        if (normalized === '') continue;
        const existing = bySku.get(normalized);
        if (existing === undefined) bySku.set(normalized, [item]);
        else existing.push(item);
      }
    };

    /*
     * Fetched in waves rather than one page after another.
     *
     * Zoho reports only `has_more_page`, never a total, so the page count is
     * unknown up front and cannot simply be fanned out. Requesting a fixed
     * window concurrently and stopping at the first page that reports no more
     * gets the parallelism anyway. Overshooting within a wave is harmless: the
     * pages past the end come back empty.
     */
    let reachedEnd = false;

    for (let first = 1; !reachedEnd && first <= MAX_CATALOGUE_PAGES; first += CATALOGUE_PAGE_CONCURRENCY) {
      if (options.signal?.aborted === true) break;

      const wave = Array.from({ length: CATALOGUE_PAGE_CONCURRENCY }, (_, offset) => first + offset);
      const responses = await Promise.all(wave.map(fetchPage));

      for (const response of responses) {
        absorb(response);
        if (response.page_context?.has_more_page !== true) {
          reachedEnd = true;
          break;
        }
      }

      if (!reachedEnd && first + CATALOGUE_PAGE_CONCURRENCY > MAX_CATALOGUE_PAGES) {
        throw new ZohoUnexpectedResponseError(
          `The Zoho catalogue exceeds ${MAX_CATALOGUE_PAGES * CATALOGUE_PAGE_SIZE} items; ` +
            'import validation cannot page it in one request.',
        );
      }
    }

    for (const sku of unique) {
      const matches = bySku.get(sku) ?? [];
      if (matches.length === 0) {
        results.set(sku, { kind: 'not_found' });
      } else if (matches.length > 1) {
        // Same rule as the per-SKU path: more than one exact match is genuinely
        // ambiguous and must not be guessed at.
        results.set(sku, { kind: 'ambiguous', matchCount: matches.length });
      } else {
        results.set(sku, { kind: 'found', item: matches[0] as ZohoItemDetail });
      }
    }

    return results;
  }

  async listOrganizations(correlationId: string): Promise<ZohoOrganization[]> {
    const response = await getWithAuthRetry<ZohoOrganizationsResponse>({
      path: '/books/v3/organizations',
      correlationId,
    });
    return response.organizations ?? [];
  }

  async listLocations(
    correlationId: string,
  ): Promise<{ locations: ZohoLocationRecord[]; warehouses: ZohoWarehouseRecord[] }> {
    /*
     * Books models multi-location stock as LOCATIONS only. Warehouses are an
     * Inventory-only concept with no Books equivalent, so the list is always
     * empty here rather than probing an endpoint that cannot exist. The shape
     * is kept so the stock-basis code and its tests stay unchanged.
     */
    const locations = await getWithAuthRetry<ZohoLocationsResponse>({
      path: '/books/v3/locations',
      correlationId,
    }).catch(() => ({ locations: [] }) as ZohoLocationsResponse);

    return { locations: locations.locations ?? [], warehouses: [] };
  }

  async testConnection(
    correlationId: string,
  ): Promise<{ organizationName: string | null; responseMs: number }> {
    const startedAt = Date.now();
    const organizations = await this.listOrganizations(correlationId);
    const credentials = await requireResolvedCredentials();
    const match = organizations.find(
      (organization) => organization.organization_id === credentials.organizationId,
    );
    return {
      organizationName: match?.name ?? organizations[0]?.name ?? null,
      responseMs: Date.now() - startedAt,
    };
  }
}

/* ------------------------------------------------------------- resolution */

export type ResolutionFailure =
  | 'INACTIVE_ITEM'
  | 'NOT_INVENTORY_TRACKED'
  | 'STOCK_BASIS_NOT_FOUND'
  | 'STOCK_QUANTITY_UNAVAILABLE'
  | 'UNEXPECTED_ZOHO_RESPONSE';

export type ResolutionResult =
  | { ok: true; item: ResolvedZohoItem }
  | { ok: false; failure: ResolutionFailure };

/** Extracts the preferred vendor name — section 16. */
export function resolveVendorName(item: ZohoItemDetail): string | null {
  const primary = item.preferred_vendors?.find((vendor) => vendor.is_primary === true);
  return firstNonEmptyString(
    primary?.vendor_name,
    item.preferred_vendors?.[0]?.vendor_name,
    item.vendor_name,
  );
}

/**
 * Turns a Zoho item into the immutable snapshot stored on the import row.
 * Returns a typed failure instead of throwing so one bad row never fails the
 * whole import (section 15).
 */
export function resolveItemSnapshot(params: {
  item: ZohoItemDetail;
  stockBasis: StockBasis;
  caseSensitive: boolean;
}): ResolutionResult {
  const { item, stockBasis } = params;

  if (!isItemActive(item)) return { ok: false, failure: 'INACTIVE_ITEM' };
  if (!isInventoryTracked(item)) return { ok: false, failure: 'NOT_INVENTORY_TRACKED' };

  const itemId = item.item_id;
  const itemName = item.name;
  const sku = item.sku;
  if (
    typeof itemId !== 'string' ||
    typeof itemName !== 'string' ||
    typeof sku !== 'string' ||
    sku.trim() === ''
  ) {
    return { ok: false, failure: 'UNEXPECTED_ZOHO_RESPONSE' };
  }

  const stock = resolveStockQuantity(
    {
      stockOnHand: toNumberOrNull(item.stock_on_hand),
      locations: (item.locations ?? []).map((entry) => ({
        locationId: entry.location_id ?? null,
        locationName: entry.location_name ?? null,
        locationStockOnHand: toNumberOrNull(entry.location_stock_on_hand),
      })),
      // Always empty for Books; retained so the stock-basis contract is one
      // shape across both the live reader and the mock.
      warehouses: (item.warehouses ?? []).map((entry) => ({
        warehouseId: entry.warehouse_id ?? null,
        warehouseName: entry.warehouse_name ?? null,
        warehouseStockOnHand: toNumberOrNull(entry.warehouse_stock_on_hand),
      })),
    },
    stockBasis,
  );

  if (!stock.ok) return { ok: false, failure: stock.failure };

  return {
    ok: true,
    item: {
      zohoItemId: itemId,
      // Section 16: the Zoho name and SKU are authoritative after a match.
      itemName,
      sku,
      normalizedSku: toNormalizedSku(sku, { caseSensitive: params.caseSensitive }),
      stockInHand: stock.quantity,
      vendorName: resolveVendorName(item),
      unit: firstNonEmptyString(item.unit),
    },
  };
}

/* ------------------------------------------------------------- factory -- */

let mockReaderFactory: (() => BooksReader) | null = null;

/** Registered by the mock module so this file has no import-time dependency on it. */
export function registerMockReaderFactory(factory: () => BooksReader): void {
  mockReaderFactory = factory;
}

export function isMockModeEnabled(): boolean {
  return process.env.ZOHO_MOCK_MODE === 'true';
}

/**
 * Returns the reader for the current environment.
 * Mock mode must be enabled explicitly and is refused in production unless the
 * operator has also set ALLOW_MOCK_IN_PRODUCTION (section 42).
 */
export async function createBooksReader(): Promise<BooksReader> {
  if (isMockModeEnabled()) {
    const isProduction = process.env.NODE_ENV === 'production' || process.env.CONTEXT === 'production';
    if (isProduction && process.env.ALLOW_MOCK_IN_PRODUCTION !== 'true') {
      throw new Error(
        'ZOHO_MOCK_MODE is enabled in a production context. Refusing to serve mock inventory data.',
      );
    }
    if (mockReaderFactory === null) {
      const module = await import('./mock');
      registerMockReaderFactory(module.createMockBooksReader);
    }
    return (mockReaderFactory as () => BooksReader)();
  }
  return new LiveBooksReader();
}

export { mapWithConcurrency };
