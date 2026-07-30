/**
 * Quantity difference and result status — specification sections 2.5 and 6.3.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateQuantityDifference,
  describeQuantityDifference,
  determineResultStatus,
  evaluateCount,
  formatSignedQuantity,
  isCountedQuantityInRange,
  isValidCountedQuantity,
  MAX_COUNTED_QUANTITY,
  sumDifferences,
} from '@/domain/quantity';

describe('calculateQuantityDifference', () => {
  it('matches the three worked examples in section 2.5', () => {
    expect(calculateQuantityDifference(10, 10)).toBe(0);
    expect(calculateQuantityDifference(12, 10)).toBe(2);
    expect(calculateQuantityDifference(7, 10)).toBe(-3);
  });

  it('is counted minus Zoho, never the reverse', () => {
    expect(calculateQuantityDifference(0, 5)).toBe(-5);
    expect(calculateQuantityDifference(5, 0)).toBe(5);
  });

  it('eliminates IEEE-754 artifacts on fractional Zoho stock', () => {
    // 10 - 10.1 is -0.09999999999999964 in raw floating point.
    expect(calculateQuantityDifference(10, 10.1)).toBe(-0.1);
    expect(calculateQuantityDifference(3, 0.3)).toBe(2.7);
  });

  it('rejects non-finite input', () => {
    expect(() => calculateQuantityDifference(Number.NaN, 1)).toThrow(TypeError);
    expect(() => calculateQuantityDifference(1, Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('determineResultStatus', () => {
  it('treats exactly zero as matched', () => {
    expect(determineResultStatus(0)).toBe('matched');
  });

  it('treats any non-zero difference as mismatched', () => {
    expect(determineResultStatus(1)).toBe('mismatched');
    expect(determineResultStatus(-1)).toBe('mismatched');
    expect(determineResultStatus(0.1)).toBe('mismatched');
  });
});

describe('evaluateCount', () => {
  it('returns both derived values together', () => {
    expect(evaluateCount(10, 10)).toEqual({ quantityDifference: 0, resultStatus: 'matched' });
    expect(evaluateCount(7, 10)).toEqual({ quantityDifference: -3, resultStatus: 'mismatched' });
  });

  it('handles a zero count against zero stock as matched', () => {
    // A genuinely empty shelf that Zoho also reports as empty.
    expect(evaluateCount(0, 0)).toEqual({ quantityDifference: 0, resultStatus: 'matched' });
  });
});

describe('isValidCountedQuantity', () => {
  it('accepts zero — a valid physical count (section 21)', () => {
    expect(isValidCountedQuantity(0)).toBe(true);
  });

  it('rejects negatives and non-integers', () => {
    expect(isValidCountedQuantity(-1)).toBe(false);
    expect(isValidCountedQuantity(1.5)).toBe(false);
    expect(isValidCountedQuantity('5')).toBe(false);
    expect(isValidCountedQuantity(Number.NaN)).toBe(false);
  });

  it('bounds the count against a stuck scanner', () => {
    expect(isCountedQuantityInRange(MAX_COUNTED_QUANTITY)).toBe(true);
    expect(isCountedQuantityInRange(MAX_COUNTED_QUANTITY + 1)).toBe(false);
  });
});

describe('describeQuantityDifference', () => {
  it('uses the absolute value in prose (section 24)', () => {
    expect(describeQuantityDifference(0)).toBe('Physical count matches the Zoho stock snapshot.');
    expect(describeQuantityDifference(2)).toBe(
      'Physical stock is 2 units higher than the Zoho stock snapshot.',
    );
    expect(describeQuantityDifference(-3)).toBe(
      'Physical stock is 3 units lower than the Zoho stock snapshot.',
    );
  });

  it('uses the singular for a difference of one', () => {
    expect(describeQuantityDifference(1)).toContain('1 unit higher');
    expect(describeQuantityDifference(-1)).toContain('1 unit lower');
  });
});

describe('formatSignedQuantity', () => {
  it('renders the signed values the export requires', () => {
    expect(formatSignedQuantity(0)).toBe('0');
    expect(formatSignedQuantity(2)).toBe('+2');
    expect(formatSignedQuantity(-3)).toBe('-3');
  });
});

describe('sumDifferences', () => {
  it('keeps the negative total negative (section 25)', () => {
    const totals = sumDifferences([5, -3, 2, -4, 0]);
    expect(totals.totalPositiveDifference).toBe(7);
    expect(totals.totalNegativeDifference).toBe(-7);
  });

  it('returns zeros for an empty set', () => {
    expect(sumDifferences([])).toEqual({
      totalPositiveDifference: 0,
      totalNegativeDifference: 0,
    });
  });

  it('excludes zeros from both totals', () => {
    const totals = sumDifferences([0, 0, 0]);
    expect(totals.totalPositiveDifference).toBe(0);
    expect(totals.totalNegativeDifference).toBe(0);
  });
});
