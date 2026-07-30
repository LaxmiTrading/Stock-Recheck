/**
 * Quantity difference — specification section 2.5.
 *
 *   Qty Difference = Counted Quantity - Zoho Stock Snapshot
 *
 *    0  → matched
 *   +n  → physical excess
 *   -n  → physical shortage
 */

import type { ResultStatus } from './status';

/**
 * Zoho reports stock as a decimal (items may be sold in fractional units).
 * The counted quantity is always an integer number of scanned units, so the
 * difference can be fractional. We round to 4 decimal places to eliminate
 * IEEE-754 artifacts such as 10.1 - 10 = 0.09999999999999964.
 */
const DIFFERENCE_PRECISION = 4;

function roundToPrecision(value: number, decimals = DIFFERENCE_PRECISION): number {
  const factor = 10 ** decimals;
  // `Number.EPSILON` nudge keeps values such as 1.005 rounding upward.
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function calculateQuantityDifference(
  countedQuantity: number,
  zohoStockQuantity: number,
): number {
  if (!Number.isFinite(countedQuantity) || !Number.isFinite(zohoStockQuantity)) {
    throw new TypeError('Quantity difference requires two finite numbers');
  }
  return roundToPrecision(countedQuantity - zohoStockQuantity);
}

/** Section 6.3 — a difference of exactly zero is `matched`, anything else is `mismatched`. */
export function determineResultStatus(quantityDifference: number): ResultStatus {
  return quantityDifference === 0 ? 'matched' : 'mismatched';
}

/** Convenience wrapper returning both derived values together. */
export function evaluateCount(
  countedQuantity: number,
  zohoStockQuantity: number,
): { quantityDifference: number; resultStatus: ResultStatus } {
  const quantityDifference = calculateQuantityDifference(countedQuantity, zohoStockQuantity);
  return { quantityDifference, resultStatus: determineResultStatus(quantityDifference) };
}

/**
 * A counted quantity is a non-negative integer. Zero is explicitly valid
 * (section 21, "Zero count") — a shelf really can be empty.
 */
export function isValidCountedQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Upper bound guarding against a scanner stuck in auto-repeat. */
export const MAX_COUNTED_QUANTITY = 1_000_000;

export function isCountedQuantityInRange(value: number): boolean {
  return isValidCountedQuantity(value) && value <= MAX_COUNTED_QUANTITY;
}

/**
 * Result sentence for the submitted-item screen — section 24.
 * Uses the absolute quantity in prose while the numeric field keeps the sign.
 */
export function describeQuantityDifference(quantityDifference: number): string {
  if (quantityDifference === 0) return 'Physical count matches the Zoho stock snapshot.';
  const magnitude = formatQuantity(Math.abs(quantityDifference));
  const direction = quantityDifference > 0 ? 'higher' : 'lower';
  const unitWord = Math.abs(quantityDifference) === 1 ? 'unit' : 'units';
  return `Physical stock is ${magnitude} ${unitWord} ${direction} than the Zoho stock snapshot.`;
}

/** Renders a quantity without trailing zeros: 10 → "10", 10.5 → "10.5". */
export function formatQuantity(value: number): string {
  if (Number.isInteger(value)) return value.toFixed(0);
  return String(roundToPrecision(value));
}

/** Renders a difference with an explicit sign: 2 → "+2", -3 → "-3", 0 → "0". */
export function formatSignedQuantity(value: number): string {
  if (value === 0) return '0';
  const formatted = formatQuantity(Math.abs(value));
  return value > 0 ? `+${formatted}` : `-${formatted}`;
}

export interface DifferenceTotals {
  totalPositiveDifference: number;
  totalNegativeDifference: number;
}

/**
 * Summary totals — section 25.
 * Positive total is the sum of positive differences; the negative total is the
 * sum of negative differences and REMAINS NEGATIVE.
 */
export function sumDifferences(differences: readonly number[]): DifferenceTotals {
  let totalPositiveDifference = 0;
  let totalNegativeDifference = 0;
  for (const difference of differences) {
    if (difference > 0) totalPositiveDifference += difference;
    else if (difference < 0) totalNegativeDifference += difference;
  }
  return {
    totalPositiveDifference: roundToPrecision(totalPositiveDifference),
    totalNegativeDifference: roundToPrecision(totalNegativeDifference),
  };
}
