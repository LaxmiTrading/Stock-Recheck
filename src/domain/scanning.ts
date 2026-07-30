/**
 * Scan evaluation — specification sections 3.3 and 3.4.
 *
 * PURE function shared by the counting screen and its tests. It decides only
 * what a scan MEANS; the caller performs the side effects (increment, focus,
 * sound, local-storage write).
 */

import { toNormalizedSku, type NormalizeOptions } from './sku';

/** Minimal item shape needed to resolve a scan against the recheck. */
export interface ScannableItem {
  id: string;
  itemName: string;
  sku: string;
  normalizedSku: string;
}

export type ScanOutcome =
  /** Matches the claimed item — increment by exactly one. */
  | { kind: 'valid'; normalizedSku: string }
  /** Empty input; an empty Enter press is ignored entirely (section 21). */
  | { kind: 'empty' }
  /** Belongs to a different item in THIS recheck. */
  | { kind: 'wrong_item'; otherItem: ScannableItem; message: string }
  /** Not part of this Stock Recheck at all. */
  | { kind: 'not_in_recheck'; message: string };

/**
 * Section 3.3 — the exact wording required when a scan belongs to another item.
 */
export function wrongItemMessage(otherItem: ScannableItem, currentItem: ScannableItem): string {
  return `This scan belongs to ${otherItem.itemName} — ${otherItem.sku}. You are currently counting ${currentItem.itemName} — ${currentItem.sku}.`;
}

/** Section 3.3 — the exact wording when the value is not in the recheck. */
export const NOT_IN_RECHECK_MESSAGE = 'SKU not found in this Stock Recheck.';

/**
 * Classifies a raw scanner submission.
 *
 * `recheckItems` should be an index of every item in the current Stock Recheck
 * keyed by normalized SKU, so that a scan for a sibling item can be named in
 * the error message rather than reported as unknown.
 */
export function evaluateScan(
  rawInput: string,
  currentItem: ScannableItem,
  recheckItems: ReadonlyMap<string, ScannableItem>,
  options: NormalizeOptions = {},
): ScanOutcome {
  const normalized = toNormalizedSku(rawInput, options);

  if (normalized.length === 0) {
    return { kind: 'empty' };
  }

  if (normalized === currentItem.normalizedSku) {
    return { kind: 'valid', normalizedSku: normalized };
  }

  const otherItem = recheckItems.get(normalized);
  if (otherItem !== undefined && otherItem.id !== currentItem.id) {
    return {
      kind: 'wrong_item',
      otherItem,
      message: wrongItemMessage(otherItem, currentItem),
    };
  }

  return { kind: 'not_in_recheck', message: NOT_IN_RECHECK_MESSAGE };
}

/** Builds the normalized-SKU index the evaluator expects. */
export function indexItemsByNormalizedSku(
  items: readonly ScannableItem[],
): Map<string, ScannableItem> {
  const index = new Map<string, ScannableItem>();
  for (const item of items) {
    // First occurrence wins; a recheck cannot legally contain duplicates
    // anyway (unique constraint on stock_recheck_id + normalized_sku).
    if (!index.has(item.normalizedSku)) index.set(item.normalizedSku, item);
  }
  return index;
}

/**
 * Keys that a hardware scanner may send to terminate a scan — section 3.5.
 * `key` is compared, not `keyCode`, so numpad Enter is covered by 'Enter'
 * plus the explicit code check the caller performs.
 */
export function isScanSubmitKey(event: { key: string; code?: string }): boolean {
  return event.key === 'Enter' || event.code === 'NumpadEnter';
}

/** Concise ARIA live announcement for a good scan — section 36 ("Count 14."). */
export function scanSuccessAnnouncement(newCount: number): string {
  return `Count ${newCount}.`;
}

export function scanErrorAnnouncement(outcome: ScanOutcome): string {
  switch (outcome.kind) {
    case 'wrong_item':
      return `Wrong item. ${outcome.otherItem.sku}.`;
    case 'not_in_recheck':
      return NOT_IN_RECHECK_MESSAGE;
    case 'empty':
    case 'valid':
      return '';
  }
}
