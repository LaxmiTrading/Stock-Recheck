/**
 * Multi-item counting session — sections 2.5, 3.3 and 21.
 */

import { describe, expect, it } from 'vitest';
import {
  countRowState,
  countTotals,
  countVariance,
  resolveSessionScan,
  varianceTone,
  visibleCountRows,
  type CountRow,
} from '@/domain/multiCount';

function row(partial: Partial<CountRow> & { itemId: string; counted: number; expected: number }): CountRow {
  const state = countRowState(partial.counted, partial.expected);
  return {
    itemName: partial.itemName ?? `Item ${partial.itemId}`,
    sku: partial.sku ?? partial.itemId,
    normalizedSku: partial.normalizedSku ?? partial.itemId.toUpperCase(),
    state,
    variance: countVariance(partial.counted, partial.expected),
    ...partial,
  } as CountRow;
}

describe('countRowState', () => {
  it('is untouched when nothing counted but something expected', () => {
    expect(countRowState(0, 30)).toBe('untouched');
  });

  it('is matched when the count equals the snapshot', () => {
    expect(countRowState(30, 30)).toBe('matched');
  });

  it('treats a genuine zero-vs-zero as matched, not untouched', () => {
    // Counting nothing where nothing is expected IS the correct answer, and
    // must not sit in the "still to do" bucket forever.
    expect(countRowState(0, 0)).toBe('matched');
  });

  it('is a discrepancy in both directions', () => {
    expect(countRowState(31, 30)).toBe('discrepancy');
    expect(countRowState(29, 30)).toBe('discrepancy');
  });
});

describe('countVariance — section 2.5', () => {
  it('is counted minus the Zoho snapshot', () => {
    expect(countVariance(88, 90)).toBe(-2);
    expect(countVariance(92, 90)).toBe(2);
    expect(countVariance(0, 30)).toBe(-30);
  });
});

describe('varianceTone', () => {
  it('flags a surplus more severely than a shortfall', () => {
    expect(varianceTone(5)).toBe('danger');
    expect(varianceTone(-5)).toBe('warning');
    expect(varianceTone(0)).toBe('neutral');
  });
});

describe('visibleCountRows', () => {
  const rows = [
    row({ itemId: 'a', itemName: 'Alpha', counted: 30, expected: 30 }), // matched
    row({ itemId: 'b', itemName: 'Bravo', counted: 0, expected: 10 }), // untouched
    row({ itemId: 'c', itemName: 'Charlie', counted: 45, expected: 40 }), // +5
    row({ itemId: 'd', itemName: 'Delta', counted: 5, expected: 100 }), // -95
  ];

  it('puts discrepancies first, then untouched, then matched', () => {
    const order = visibleCountRows(rows, 'all').map((r) => r.itemId);
    expect(order).toEqual(['d', 'c', 'b', 'a']);
  });

  it('orders discrepancies by absolute variance, largest first', () => {
    const order = visibleCountRows(rows, 'discrepancy').map((r) => r.itemId);
    expect(order).toEqual(['d', 'c']);
  });

  it('filters to a single bucket', () => {
    expect(visibleCountRows(rows, 'matched').map((r) => r.itemId)).toEqual(['a']);
    expect(visibleCountRows(rows, 'untouched').map((r) => r.itemId)).toEqual(['b']);
  });

  it('breaks ties on name so polling does not reshuffle the table', () => {
    const tied = [
      row({ itemId: 'z', itemName: 'Zulu', counted: 11, expected: 10 }),
      row({ itemId: 'y', itemName: 'Alpha', counted: 9, expected: 10 }),
    ];
    expect(visibleCountRows(tied, 'all').map((r) => r.itemName)).toEqual(['Alpha', 'Zulu']);
  });

  it('does not mutate the input array', () => {
    const original = rows.map((r) => r.itemId);
    visibleCountRows(rows, 'all');
    expect(rows.map((r) => r.itemId)).toEqual(original);
  });
});

describe('countTotals', () => {
  it('sums counted and expected and buckets the rows', () => {
    const totals = countTotals([
      row({ itemId: 'a', counted: 30, expected: 30 }),
      row({ itemId: 'b', counted: 0, expected: 10 }),
      row({ itemId: 'c', counted: 45, expected: 40 }),
    ]);
    expect(totals).toMatchObject({
      items: 3,
      counted: 75,
      expected: 80,
      matched: 1,
      untouched: 1,
      discrepancy: 1,
    });
  });

  it('clamps the progress percentage when over-counted', () => {
    // Otherwise the bar renders past the end of its track.
    expect(countTotals([row({ itemId: 'a', counted: 200, expected: 100 })]).percentage).toBe(100);
  });

  it('reports 0% rather than NaN when nothing is expected', () => {
    expect(countTotals([row({ itemId: 'a', counted: 0, expected: 0 })]).percentage).toBe(0);
    expect(countTotals([]).percentage).toBe(0);
  });
});

describe('resolveSessionScan', () => {
  const session = new Map([['AB-001', { itemId: 'item-1' }]]);
  const recheck = new Map([
    ['AB-001', { itemName: 'Anchor Bolt' }],
    ['CD-002', { itemName: 'Cable Tie' }],
  ]);

  it('resolves a SKU in the session to its row', () => {
    expect(resolveSessionScan('AB-001', session, recheck)).toEqual({
      kind: 'valid',
      itemId: 'item-1',
      normalizedSku: 'AB-001',
    });
  });

  it('separates "in the recheck but unclaimed" from "unknown"', () => {
    // The first is recoverable by claiming it; the second means wrong shelf.
    expect(resolveSessionScan('CD-002', session, recheck)).toEqual({
      kind: 'not_in_session',
      normalizedSku: 'CD-002',
      itemName: 'Cable Tie',
    });
    expect(resolveSessionScan('ZZ-999', session, recheck)).toEqual({
      kind: 'unknown',
      normalizedSku: 'ZZ-999',
    });
  });

  it('ignores an empty scan — section 21', () => {
    expect(resolveSessionScan('', session, recheck)).toEqual({ kind: 'empty' });
  });
});
