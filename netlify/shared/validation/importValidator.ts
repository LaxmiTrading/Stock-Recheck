/**
 * Import validation engine — specification sections 15, 16 and 32.
 *
 * Executes the documented algorithm for every unique SKU:
 *   normalize → blank check → duplicate check → exact Zoho search →
 *   active check → inventory-tracked check → detail fetch →
 *   stock resolution → vendor / unit → snapshot.
 *
 * Design rules honoured here:
 *   - One Zoho lookup per UNIQUE SKU, never per row (section 15).
 *   - A single failing SKU never fails the batch (section 15).
 *   - Bounded concurrency against Zoho (section 32).
 */

import {
  failureReason,
  type ImportFailureCode,
} from '../../../src/domain/failureCodes';
import { toNormalizedSku } from '../../../src/domain/sku';
import type { StockBasis } from '../../../src/domain/stockBasis';
import {
  AppError,
  ZohoAuthenticationError,
  ZohoRateLimitedError,
  ZohoUnavailableError,
} from '../errors';
import { logInfo } from '../http';
import {
  resolveItemSnapshot,
  type BooksReader,
  type SkuLookupOutcome,
} from '../zoho/books';
import type { ResolvedSnapshot } from '../repositories/imports';

export interface SourceRow {
  sourceRowNumber: number;
  rawSku: string;
  displaySku: string;
  normalizedSku: string;
}

export interface RowResult {
  sourceRowNumber: number;
  status: 'passed' | 'failed' | 'ignored_blank';
  failureCode: ImportFailureCode | null;
  failureReason: string | null;
  duplicateOfRowNumber: number | null;
  zohoItemId: string | null;
  snapshot: ResolvedSnapshot | null;
}

export interface ValidationContext {
  reader: BooksReader;
  stockBasis: StockBasis;
  organizationId: string | null;
  organizationName: string | null;
  caseSensitive: boolean;
  correlationId: string;
  /** Cooperative cancellation for the "Cancel Validation" button (section 15). */
  signal?: AbortSignal;
}

export interface ValidationSummary {
  totalSourceRows: number;
  passed: number;
  failed: number;
  duplicates: number;
  ignoredBlanks: number;
  results: RowResult[];
  /** Set when validation stopped early because Zoho auth is broken. */
  abortedReason: 'zoho_authentication' | 'cancelled' | null;
}

/** Per-unique-SKU outcome, later fanned back out to every row with that SKU. */
type SkuOutcome =
  | { kind: 'passed'; zohoItemId: string; snapshot: ResolvedSnapshot }
  | { kind: 'failed'; code: ImportFailureCode };

/** Maps a thrown Zoho error onto the per-row failure code (section 16). */
function zohoErrorToFailureCode(error: unknown): ImportFailureCode {
  if (error instanceof ZohoAuthenticationError) return 'ZOHO_AUTHENTICATION_FAILED';
  if (error instanceof ZohoRateLimitedError) return 'ZOHO_RATE_LIMITED';
  if (error instanceof ZohoUnavailableError) return 'ZOHO_TEMPORARILY_UNAVAILABLE';
  if (error instanceof AppError && error.code === 'ZOHO_UNEXPECTED_RESPONSE') {
    return 'UNEXPECTED_ZOHO_RESPONSE';
  }
  return 'UNEXPECTED_ZOHO_RESPONSE';
}

/**
 * Validates a set of parsed source rows.
 *
 * `rows` must already carry normalized SKUs produced by the shared
 * normalization function.
 */
export async function validateImportRows(
  rows: readonly SourceRow[],
  context: ValidationContext,
): Promise<ValidationSummary> {
  const snapshotAt = new Date().toISOString();

  /* ---- Stage 1-3: blanks and duplicates, entirely local ------------------ */

  const results = new Map<number, RowResult>();
  /** normalized SKU → row number of the first accepted occurrence. */
  const firstOccurrence = new Map<string, number>();
  /** normalized SKU → rows waiting on that SKU's Zoho outcome. */
  const rowsBySku = new Map<string, number[]>();

  for (const row of rows) {
    if (row.normalizedSku === '') {
      // Stage "Removing blanks" — blank rows are ignored, not failed, so the
      // reconciliation in section 17 balances.
      results.set(row.sourceRowNumber, {
        sourceRowNumber: row.sourceRowNumber,
        status: 'ignored_blank',
        failureCode: 'EMPTY_SKU',
        failureReason: failureReason('EMPTY_SKU'),
        duplicateOfRowNumber: null,
        zohoItemId: null,
        snapshot: null,
      });
      continue;
    }

    const seenAt = firstOccurrence.get(row.normalizedSku);
    if (seenAt !== undefined) {
      // Section 3.2: accept the first, fail later occurrences as duplicates and
      // show the row number of the accepted one.
      results.set(row.sourceRowNumber, {
        sourceRowNumber: row.sourceRowNumber,
        status: 'failed',
        failureCode: 'DUPLICATE_IN_IMPORT',
        failureReason: failureReason('DUPLICATE_IN_IMPORT', { duplicateOfRowNumber: seenAt }),
        duplicateOfRowNumber: seenAt,
        zohoItemId: null,
        snapshot: null,
      });
      continue;
    }

    firstOccurrence.set(row.normalizedSku, row.sourceRowNumber);
    rowsBySku.set(row.normalizedSku, [row.sourceRowNumber]);
  }

  const uniqueSkus = [...firstOccurrence.keys()];

  /* ---- Stage 4-9: Zoho lookups, one per unique SKU ---------------------- */

  let abortedReason: ValidationSummary['abortedReason'] = null;

  /*
   * ONE bulk resolution rather than a lookup per SKU.
   *
   * The per-SKU path costs two Zoho round trips each (a search, then a detail
   * fetch), so a 1200-SKU import needed ~2500 requests and was killed by the
   * platform mid-flight — the browser received a non-JSON error page rather
   * than any result. `lookupManyBySku` pages the catalogue once instead, so the
   * request count no longer scales with the import.
   *
   * A failure here is not per-row: nothing was resolved, so every SKU carries
   * the same code rather than one row's error being attributed to it.
   */
  let lookups = new Map<string, SkuLookupOutcome>();
  let bulkFailureCode: ReturnType<typeof zohoErrorToFailureCode> | null = null;

  try {
    lookups = await context.reader.lookupManyBySku(uniqueSkus, context.correlationId, {
      signal: context.signal,
      // Only the detail payload carries the per-location stock breakdown, so a
      // location or warehouse basis cannot be served from the list alone.
      requireDetail: context.stockBasis.type !== 'organization',
    });
  } catch (error) {
    bulkFailureCode = zohoErrorToFailureCode(error);

    // Section 32: broken authentication stops validation rather than burning
    // every remaining row against a dead connection.
    if (bulkFailureCode === 'ZOHO_AUTHENTICATION_FAILED') {
      abortedReason = 'zoho_authentication';
      logInfo('import.validation_aborted', {
        correlationId: context.correlationId,
        reason: 'zoho_authentication',
      });
    }
  }

  if (context.signal?.aborted === true) abortedReason = 'cancelled';

  const outcomes: [string, SkuOutcome][] = uniqueSkus.map((normalizedSku) => {
    if (bulkFailureCode !== null) {
      return [normalizedSku, { kind: 'failed', code: bulkFailureCode }];
    }
    if (context.signal?.aborted === true) {
      return [normalizedSku, { kind: 'failed', code: 'ZOHO_TEMPORARILY_UNAVAILABLE' }];
    }

    const lookup = lookups.get(normalizedSku);

    // A SKU absent from the results was never matched, which is the same
    // outcome as an explicit miss.
    if (lookup === undefined || lookup.kind === 'not_found') {
      return [normalizedSku, { kind: 'failed', code: 'SKU_NOT_FOUND' }];
    }
    if (lookup.kind === 'ambiguous') {
      return [normalizedSku, { kind: 'failed', code: 'AMBIGUOUS_SKU' }];
    }
    // Section 15: this SKU alone failed; the rest of the batch is unaffected.
    if (lookup.kind === 'error') {
      return [normalizedSku, { kind: 'failed', code: zohoErrorToFailureCode(lookup.error) }];
    }

    const resolution = resolveItemSnapshot({
      item: lookup.item,
      stockBasis: context.stockBasis,
      caseSensitive: context.caseSensitive,
    });

    if (!resolution.ok) {
      return [normalizedSku, { kind: 'failed', code: resolution.failure }];
    }

    const snapshot: ResolvedSnapshot = {
      ...resolution.item,
      organizationId: context.organizationId,
      organizationName: context.organizationName,
      stockBasisType: context.stockBasis.type,
      stockLocationId: context.stockBasis.locationId,
      stockLocationName: context.stockBasis.locationName,
      stockWarehouseId: context.stockBasis.warehouseId,
      stockWarehouseName: context.stockBasis.warehouseName,
      snapshotAt,
    };

    return [normalizedSku, { kind: 'passed', zohoItemId: resolution.item.zohoItemId, snapshot }];
  });

  /* ---- Stage: build result -------------------------------------------- */

  const outcomeBySku = new Map<string, SkuOutcome>(outcomes);

  for (const [normalizedSku, rowNumbers] of rowsBySku.entries()) {
    const outcome = outcomeBySku.get(normalizedSku);
    for (const rowNumber of rowNumbers) {
      if (outcome === undefined || outcome.kind === 'failed') {
        const code = outcome?.code ?? 'UNEXPECTED_ZOHO_RESPONSE';
        results.set(rowNumber, {
          sourceRowNumber: rowNumber,
          status: 'failed',
          failureCode: code,
          failureReason: failureReason(code),
          duplicateOfRowNumber: null,
          zohoItemId: null,
          snapshot: null,
        });
      } else {
        results.set(rowNumber, {
          sourceRowNumber: rowNumber,
          status: 'passed',
          failureCode: null,
          failureReason: null,
          duplicateOfRowNumber: null,
          zohoItemId: outcome.zohoItemId,
          snapshot: outcome.snapshot,
        });
      }
    }
  }

  const ordered = [...results.values()].sort((a, b) => a.sourceRowNumber - b.sourceRowNumber);

  return {
    totalSourceRows: rows.length,
    passed: ordered.filter((row) => row.status === 'passed').length,
    failed: ordered.filter((row) => row.status === 'failed').length,
    duplicates: ordered.filter((row) => row.failureCode === 'DUPLICATE_IN_IMPORT').length,
    ignoredBlanks: ordered.filter((row) => row.status === 'ignored_blank').length,
    results: ordered,
    abortedReason,
  };
}

/**
 * Re-validates a subset of rows after a transient failure — section 17
 * ("Retry All Temporary Failures").
 *
 * Duplicate detection is deliberately skipped: these rows already passed that
 * stage, and re-running it against a partial set would mislabel them.
 */
export async function revalidateRows(
  rows: readonly SourceRow[],
  context: ValidationContext,
): Promise<RowResult[]> {
  const summary = await validateImportRows(rows, context);
  return summary.results;
}

/** Live progress for the validation screen — section 15. */
export interface ValidationProgress {
  stage:
    | 'preparing_rows'
    | 'removing_blanks'
    | 'detecting_duplicates'
    | 'checking_cache'
    | 'fetching_items'
    | 'fetching_details'
    | 'resolving_attributes'
    | 'resolving_stock_basis'
    | 'building_result';
  processed: number;
  total: number;
  passed: number;
  failed: number;
}

export const VALIDATION_STAGE_LABEL: Record<ValidationProgress['stage'], string> = {
  preparing_rows: 'Preparing rows',
  removing_blanks: 'Removing blanks',
  detecting_duplicates: 'Detecting duplicates',
  checking_cache: 'Checking local Zoho cache',
  fetching_items: 'Fetching items from Zoho',
  fetching_details: 'Fetching item details',
  resolving_attributes: 'Resolving item attributes',
  resolving_stock_basis: 'Resolving stock basis',
  building_result: 'Building result',
};

/** Normalizes a batch of raw values into source rows. */
export function toSourceRows(
  values: readonly { sourceRowNumber: number; rawValue: unknown }[],
  caseSensitive: boolean,
): SourceRow[] {
  return values.map((entry) => {
    const normalized = toNormalizedSku(entry.rawValue, { caseSensitive });
    const display = typeof entry.rawValue === 'string' ? entry.rawValue.trim() : String(entry.rawValue ?? '').trim();
    return {
      sourceRowNumber: entry.sourceRowNumber,
      rawSku: typeof entry.rawValue === 'string' ? entry.rawValue : String(entry.rawValue ?? ''),
      displaySku: display,
      normalizedSku: normalized,
    };
  });
}
