/**
 * Import validation against a mocked Zoho — specification sections 15, 16, 41.
 *
 * Exercises the whole algorithm with a controllable reader: blanks,
 * duplicates, unknown SKUs, ambiguity, inactive items, non-tracked items,
 * stock-basis failures, and transient errors.
 */

import { describe, expect, it, vi } from 'vitest';
import { validateImportRows, type SourceRow } from '../../netlify/shared/validation/importValidator';
import type { BooksReader, SkuLookupOutcome } from '../../netlify/shared/zoho/books';
import {
  ZohoAuthenticationError,
  ZohoRateLimitedError,
  ZohoUnavailableError,
} from '../../netlify/shared/errors';
import { ORGANIZATION_WIDE_BASIS, type StockBasis } from '../../src/domain/stockBasis';
import type { ZohoItemDetail } from '../../netlify/shared/zoho/types';

/* --------------------------------------------------------------- fixtures */

function activeItem(overrides: Partial<ZohoItemDetail> = {}): ZohoItemDetail {
  return {
    item_id: '1001',
    name: 'Hex Bolt M8',
    sku: 'SKU-0001',
    status: 'active',
    product_type: 'goods',
    item_type: 'inventory',
    track_inventory: true,
    stock_on_hand: 120,
    unit: 'pcs',
    vendor_name: 'Metro Supplies',
    ...overrides,
  };
}

interface ReaderScript {
  [normalizedSku: string]: SkuLookupOutcome | (() => never);
}

function createReader(script: ReaderScript) {
  const lookupBySku = vi.fn(async (sku: string): Promise<SkuLookupOutcome> => {
    const entry = script[sku];
    if (entry === undefined) return { kind: 'not_found' };
    if (typeof entry === 'function') entry();
    return entry as SkuLookupOutcome;
  });

  // Delegates so the scripted outcomes — and thrown errors — reach the
  // validator exactly as they did through the per-SKU path.
  const lookupManyBySku = vi.fn(
    async (skus: readonly string[]): Promise<Map<string, SkuLookupOutcome>> => {
      const results = new Map<string, SkuLookupOutcome>();
      for (const sku of skus) {
        try {
          results.set(sku, await lookupBySku(sku));
        } catch (error) {
          // Mirrors LiveBooksReader: auth breaks the whole run, anything else
          // is isolated to the SKU that raised it.
          if (error instanceof ZohoAuthenticationError) throw error;
          results.set(sku, { kind: 'error', error });
        }
      }
      return results;
    },
  );

  const reader: BooksReader = {
    lookupBySku,
    lookupManyBySku,
    listOrganizations: vi.fn(async () => []),
    listLocations: vi.fn(async () => ({ locations: [], warehouses: [] })),
    testConnection: vi.fn(async () => ({ organizationName: 'Test Org', responseMs: 1 })),
    isMock: true,
  };

  return { reader, lookupBySku };
}

function rows(values: string[]): SourceRow[] {
  return values.map((value, index) => ({
    sourceRowNumber: index + 1,
    rawSku: value,
    displaySku: value.trim(),
    normalizedSku: value.trim().toUpperCase(),
  }));
}

const CONTEXT_BASE = {
  stockBasis: ORGANIZATION_WIDE_BASIS as StockBasis,
  organizationId: '60000000001',
  organizationName: 'Test Org',
  caseSensitive: false,
  correlationId: 'test',
};

/* ------------------------------------------------------------------ tests */

describe('happy path', () => {
  it('passes a valid SKU and builds the full snapshot', async () => {
    const { reader } = createReader({ 'SKU-0001': { kind: 'found', item: activeItem() } });

    const summary = await validateImportRows(rows(['SKU-0001']), { reader, ...CONTEXT_BASE });

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(0);

    const snapshot = summary.results[0]?.snapshot;
    expect(snapshot).toMatchObject({
      zohoItemId: '1001',
      itemName: 'Hex Bolt M8',
      sku: 'SKU-0001',
      stockInHand: 120,
      vendorName: 'Metro Supplies',
      unit: 'pcs',
      organizationId: '60000000001',
      stockBasisType: 'organization',
    });
    // Section 2.6: the snapshot carries its own timestamp.
    expect(snapshot?.snapshotAt).toBeTruthy();
  });
});

describe('blank rows (section 16 step 2)', () => {
  it('marks a blank as ignored rather than failed, so counts reconcile', async () => {
    const { reader, lookupBySku } = createReader({});
    const summary = await validateImportRows(
      [{ sourceRowNumber: 1, rawSku: '   ', displaySku: '', normalizedSku: '' }],
      { reader, ...CONTEXT_BASE },
    );

    expect(summary.ignoredBlanks).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.results[0]?.status).toBe('ignored_blank');
    expect(summary.results[0]?.failureCode).toBe('EMPTY_SKU');
    // A blank never reaches Zoho.
    expect(lookupBySku).not.toHaveBeenCalled();
  });

  it('reconciles passed + failed + blanks with the source row count', async () => {
    const { reader } = createReader({ 'SKU-0001': { kind: 'found', item: activeItem() } });
    const summary = await validateImportRows(
      [
        { sourceRowNumber: 1, rawSku: 'SKU-0001', displaySku: 'SKU-0001', normalizedSku: 'SKU-0001' },
        { sourceRowNumber: 2, rawSku: '', displaySku: '', normalizedSku: '' },
        { sourceRowNumber: 3, rawSku: 'NOPE', displaySku: 'NOPE', normalizedSku: 'NOPE' },
      ],
      { reader, ...CONTEXT_BASE },
    );

    expect(summary.passed + summary.failed + summary.ignoredBlanks).toBe(summary.totalSourceRows);
    expect(summary.totalSourceRows).toBe(3);
  });
});

describe('duplicates (section 3.2)', () => {
  it('accepts the first occurrence and fails later ones with the accepted row', async () => {
    const { reader, lookupBySku } = createReader({
      'SKU-0001': { kind: 'found', item: activeItem() },
    });

    const summary = await validateImportRows(rows(['SKU-0001', 'sku-0001', 'SKU-0001']), {
      reader,
      ...CONTEXT_BASE,
    });

    expect(summary.passed).toBe(1);
    expect(summary.duplicates).toBe(2);

    expect(summary.results[0]?.status).toBe('passed');
    expect(summary.results[1]?.failureCode).toBe('DUPLICATE_IN_IMPORT');
    expect(summary.results[1]?.duplicateOfRowNumber).toBe(1);
    expect(summary.results[1]?.failureReason).toBe('This SKU already appeared on row 1.');
    expect(summary.results[2]?.duplicateOfRowNumber).toBe(1);

    // Section 15: one Zoho lookup per UNIQUE SKU, not per row.
    expect(lookupBySku).toHaveBeenCalledTimes(1);
  });
});

describe('Zoho match failures', () => {
  it('fails an unknown SKU with SKU_NOT_FOUND', async () => {
    const { reader } = createReader({});
    const summary = await validateImportRows(rows(['MISSING']), { reader, ...CONTEXT_BASE });
    expect(summary.results[0]?.failureCode).toBe('SKU_NOT_FOUND');
  });

  it('fails an ambiguous SKU', async () => {
    const { reader } = createReader({ AMBIG: { kind: 'ambiguous', matchCount: 2 } });
    const summary = await validateImportRows(rows(['AMBIG']), { reader, ...CONTEXT_BASE });
    expect(summary.results[0]?.failureCode).toBe('AMBIGUOUS_SKU');
  });

  it('fails an inactive item', async () => {
    const { reader } = createReader({
      INACTIVE: { kind: 'found', item: activeItem({ sku: 'INACTIVE', status: 'inactive' }) },
    });
    const summary = await validateImportRows(rows(['INACTIVE']), { reader, ...CONTEXT_BASE });
    expect(summary.results[0]?.failureCode).toBe('INACTIVE_ITEM');
  });

  it('fails a non-inventory item', async () => {
    const { reader } = createReader({
      SERVICE: {
        kind: 'found',
        item: activeItem({
          sku: 'SERVICE',
          product_type: 'service',
          item_type: 'sales',
          track_inventory: false,
        }),
      },
    });
    const summary = await validateImportRows(rows(['SERVICE']), { reader, ...CONTEXT_BASE });
    expect(summary.results[0]?.failureCode).toBe('NOT_INVENTORY_TRACKED');
  });

  it('fails when the configured location is absent from the item', async () => {
    const { reader } = createReader({
      'SKU-0001': {
        kind: 'found',
        item: activeItem({ locations: [{ location_id: 'OTHER', location_stock_on_hand: 5 }] }),
      },
    });

    const summary = await validateImportRows(rows(['SKU-0001']), {
      reader,
      ...CONTEXT_BASE,
      stockBasis: {
        type: 'location',
        locationId: 'LOC-MAIN',
        locationName: 'Main',
        warehouseId: null,
        warehouseName: null,
      },
    });

    expect(summary.results[0]?.failureCode).toBe('STOCK_BASIS_NOT_FOUND');
  });

  it('fails when no stock figure can be resolved', async () => {
    const { reader } = createReader({
      'SKU-0001': { kind: 'found', item: activeItem({ stock_on_hand: undefined, item_type: 'inventory' }) },
    });
    const summary = await validateImportRows(rows(['SKU-0001']), { reader, ...CONTEXT_BASE });
    expect(summary.results[0]?.failureCode).toBe('STOCK_QUANTITY_UNAVAILABLE');
  });
});

describe('optional fields never fail a row (section 16)', () => {
  it('passes an item with no vendor, brand, manufacturer or unit', async () => {
    const { reader } = createReader({
      'SKU-0001': {
        kind: 'found',
        item: activeItem({
          vendor_name: undefined,
          preferred_vendors: [],
          unit: undefined,
        }),
      },
    });

    const summary = await validateImportRows(rows(['SKU-0001']), { reader, ...CONTEXT_BASE });

    expect(summary.passed).toBe(1);
    expect(summary.results[0]?.snapshot?.vendorName).toBeNull();
    expect(summary.results[0]?.snapshot?.unit).toBeNull();
  });
});

describe('transient Zoho errors', () => {
  it('maps a rate-limit error to a retryable code', async () => {
    const { reader } = createReader({
      LIMITED: () => {
        throw new ZohoRateLimitedError(30);
      },
    });
    const summary = await validateImportRows(rows(['LIMITED']), { reader, ...CONTEXT_BASE });
    expect(summary.results[0]?.failureCode).toBe('ZOHO_RATE_LIMITED');
  });

  it('maps an unavailable error to a retryable code', async () => {
    const { reader } = createReader({
      DOWN: () => {
        throw new ZohoUnavailableError();
      },
    });
    const summary = await validateImportRows(rows(['DOWN']), { reader, ...CONTEXT_BASE });
    expect(summary.results[0]?.failureCode).toBe('ZOHO_TEMPORARILY_UNAVAILABLE');
  });

  it('does NOT fail the whole import because one SKU failed (section 15)', async () => {
    const { reader } = createReader({
      'SKU-0001': { kind: 'found', item: activeItem() },
      BROKEN: () => {
        throw new ZohoUnavailableError();
      },
    });

    const summary = await validateImportRows(rows(['SKU-0001', 'BROKEN']), {
      reader,
      ...CONTEXT_BASE,
    });

    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it('stops validation once authentication is broken', async () => {
    const { reader } = createReader({
      A: () => {
        throw new ZohoAuthenticationError();
      },
    });

    const summary = await validateImportRows(rows(['A']), { reader, ...CONTEXT_BASE });
    expect(summary.results[0]?.failureCode).toBe('ZOHO_AUTHENTICATION_FAILED');
    expect(summary.abortedReason).toBe('zoho_authentication');
  });
});

describe('case sensitivity', () => {
  it('treats case-different SKUs as distinct when configured', async () => {
    const { reader, lookupBySku } = createReader({
      'SKU-0001': { kind: 'found', item: activeItem() },
      'sku-0001': { kind: 'found', item: activeItem({ item_id: '2', sku: 'sku-0001' }) },
    });

    const summary = await validateImportRows(
      [
        { sourceRowNumber: 1, rawSku: 'SKU-0001', displaySku: 'SKU-0001', normalizedSku: 'SKU-0001' },
        { sourceRowNumber: 2, rawSku: 'sku-0001', displaySku: 'sku-0001', normalizedSku: 'sku-0001' },
      ],
      { reader, ...CONTEXT_BASE, caseSensitive: true },
    );

    expect(summary.duplicates).toBe(0);
    expect(lookupBySku).toHaveBeenCalledTimes(2);
  });
});
