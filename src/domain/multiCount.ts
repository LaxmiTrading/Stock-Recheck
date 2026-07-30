/**
 * Multi-item counting session — the arithmetic and ordering behind the count
 * screen, kept pure so it can be tested without a DOM.
 *
 * A counter claims several items and counts them all on one screen: scanning a
 * barcode adds one to whichever row owns that SKU, rather than the operator
 * opening one item, counting it, submitting, and going back for the next.
 */

import type { StatusTone } from './status';

/**
 * Where a row sits relative to its Zoho snapshot.
 *
 * `untouched` means nothing has been counted yet AND something was expected —
 * an item whose snapshot is genuinely 0 and which has been counted 0 is
 * `matched`, not untouched, because that IS the correct answer.
 */
export type CountRowState = 'untouched' | 'matched' | 'discrepancy';

export function countRowState(counted: number, expected: number): CountRowState {
  if (counted === 0 && expected !== 0) return 'untouched';
  if (counted === expected) return 'matched';
  return 'discrepancy';
}

/** Section 2.5: Qty Difference = Counted Quantity − Zoho Stock Snapshot. */
export function countVariance(counted: number, expected: number): number {
  return counted - expected;
}

/**
 * Tone for a variance pill.
 *
 * A surplus is the more alarming direction — physical stock exceeding the
 * system usually means an unrecorded receipt or a miscount, whereas a shortfall
 * is the routine shrinkage case the recheck exists to find.
 */
export function varianceTone(variance: number): StatusTone {
  if (variance === 0) return 'neutral';
  return variance > 0 ? 'danger' : 'warning';
}

export interface CountRow {
  itemId: string;
  itemName: string;
  sku: string;
  normalizedSku: string;
  expected: number;
  counted: number;
  state: CountRowState;
  variance: number;
}

export type CountFilter = 'all' | CountRowState;

/** Display order: the rows that need attention first. */
const STATE_RANK: Record<CountRowState, number> = {
  discrepancy: 0,
  untouched: 1,
  matched: 2,
};

/**
 * Filters then orders rows: discrepancies first, largest absolute variance at
 * the top, so the biggest problem is never below the fold. Ties break on item
 * name so the order is stable across the 4-second refetch rather than jumping
 * around while the operator is reading it.
 */
export function visibleCountRows(rows: readonly CountRow[], filter: CountFilter): CountRow[] {
  const filtered = filter === 'all' ? [...rows] : rows.filter((row) => row.state === filter);
  return filtered.sort((a, b) => {
    if (STATE_RANK[a.state] !== STATE_RANK[b.state]) {
      return STATE_RANK[a.state] - STATE_RANK[b.state];
    }
    const byVariance = Math.abs(b.variance) - Math.abs(a.variance);
    if (byVariance !== 0) return byVariance;
    return a.itemName.localeCompare(b.itemName);
  });
}

export interface CountTotals {
  items: number;
  counted: number;
  expected: number;
  matched: number;
  discrepancy: number;
  untouched: number;
  /** 0–100, clamped: over-counting must not overflow the progress bar. */
  percentage: number;
}

export function countTotals(rows: readonly CountRow[]): CountTotals {
  let counted = 0;
  let expected = 0;
  let matched = 0;
  let discrepancy = 0;
  let untouched = 0;

  for (const row of rows) {
    counted += row.counted;
    expected += row.expected;
    if (row.state === 'matched') matched += 1;
    else if (row.state === 'discrepancy') discrepancy += 1;
    else untouched += 1;
  }

  return {
    items: rows.length,
    counted,
    expected,
    matched,
    discrepancy,
    untouched,
    percentage: expected === 0 ? 0 : Math.min(100, Math.round((counted / expected) * 100)),
  };
}

/**
 * A scanned value resolved against the rows in this session.
 *
 * Distinguishing "in this Stock Recheck but not in your session" from "unknown
 * entirely" matters: the first is a claim the operator has not made yet and is
 * recoverable, the second is a wrong shelf or a mis-keyed barcode.
 */
export type SessionScanOutcome =
  | { kind: 'empty' }
  | { kind: 'valid'; itemId: string; normalizedSku: string }
  | { kind: 'not_in_session'; normalizedSku: string; itemName: string }
  | { kind: 'unknown'; normalizedSku: string };

export function resolveSessionScan(
  normalizedSku: string,
  sessionByNormalizedSku: ReadonlyMap<string, { itemId: string }>,
  recheckByNormalizedSku: ReadonlyMap<string, { itemName: string }>,
): SessionScanOutcome {
  if (normalizedSku.length === 0) return { kind: 'empty' };

  const inSession = sessionByNormalizedSku.get(normalizedSku);
  if (inSession !== undefined) {
    return { kind: 'valid', itemId: inSession.itemId, normalizedSku };
  }

  const elsewhere = recheckByNormalizedSku.get(normalizedSku);
  if (elsewhere !== undefined) {
    return { kind: 'not_in_session', normalizedSku, itemName: elsewhere.itemName };
  }

  return { kind: 'unknown', normalizedSku };
}

export const SCAN_NOT_IN_SESSION_MESSAGE =
  'is in this Stock Recheck but not in your count. Claim it first to scan it here.';
export const SCAN_UNKNOWN_MESSAGE = 'is not part of this Stock Recheck — nothing was added.';
