/**
 * Scan evaluation — specification sections 3.3, 3.4 and 3.5.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateScan,
  indexItemsByNormalizedSku,
  isScanSubmitKey,
  NOT_IN_RECHECK_MESSAGE,
  scanSuccessAnnouncement,
  type ScannableItem,
} from '@/domain/scanning';

const CURRENT: ScannableItem = {
  id: 'item-1',
  itemName: 'Cyanoacrylate Adhesive 20g',
  sku: 'ABC-001',
  normalizedSku: 'ABC-001',
};

const OTHER: ScannableItem = {
  id: 'item-2',
  itemName: 'Epoxy Resin Kit 500ml',
  sku: 'XYZ-002',
  normalizedSku: 'XYZ-002',
};

const INDEX = indexItemsByNormalizedSku([CURRENT, OTHER]);

describe('evaluateScan — valid scans (section 3.4)', () => {
  it('accepts an exact match', () => {
    expect(evaluateScan('ABC-001', CURRENT, INDEX).kind).toBe('valid');
  });

  it('accepts a match differing only by case', () => {
    expect(evaluateScan('abc-001', CURRENT, INDEX).kind).toBe('valid');
  });

  it('accepts trailing CR/LF appended by a hardware scanner (section 3.5)', () => {
    expect(evaluateScan('ABC-001\r\n', CURRENT, INDEX).kind).toBe('valid');
    expect(evaluateScan('ABC-001\n', CURRENT, INDEX).kind).toBe('valid');
    expect(evaluateScan('ABC-001\r', CURRENT, INDEX).kind).toBe('valid');
  });

  it('accepts leading and trailing whitespace', () => {
    expect(evaluateScan('  ABC-001  ', CURRENT, INDEX).kind).toBe('valid');
  });

  it('rejects a case-different scan when case-sensitive matching is on', () => {
    const outcome = evaluateScan('abc-001', CURRENT, INDEX, { caseSensitive: true });
    expect(outcome.kind).not.toBe('valid');
  });
});

describe('evaluateScan — wrong item (section 3.3)', () => {
  it('identifies the other item and uses the exact required wording', () => {
    const outcome = evaluateScan('XYZ-002', CURRENT, INDEX);
    expect(outcome.kind).toBe('wrong_item');

    if (outcome.kind !== 'wrong_item') throw new Error('expected wrong_item');
    expect(outcome.otherItem.id).toBe('item-2');
    expect(outcome.message).toBe(
      'This scan belongs to Epoxy Resin Kit 500ml — XYZ-002. You are currently counting Cyanoacrylate Adhesive 20g — ABC-001.',
    );
  });
});

describe('evaluateScan — unknown value (section 3.3)', () => {
  it('reports the documented message', () => {
    const outcome = evaluateScan('NOT-A-REAL-SKU', CURRENT, INDEX);
    expect(outcome.kind).toBe('not_in_recheck');
    if (outcome.kind !== 'not_in_recheck') throw new Error('expected not_in_recheck');
    expect(outcome.message).toBe(NOT_IN_RECHECK_MESSAGE);
  });
});

describe('evaluateScan — empty input (section 21)', () => {
  it('ignores an empty Enter press', () => {
    expect(evaluateScan('', CURRENT, INDEX).kind).toBe('empty');
    expect(evaluateScan('   ', CURRENT, INDEX).kind).toBe('empty');
    expect(evaluateScan('\r\n', CURRENT, INDEX).kind).toBe('empty');
  });
});

describe('indexItemsByNormalizedSku', () => {
  it('keys items by their normalized SKU', () => {
    expect(INDEX.get('ABC-001')?.id).toBe('item-1');
    expect(INDEX.get('XYZ-002')?.id).toBe('item-2');
    expect(INDEX.size).toBe(2);
  });

  it('keeps the first occurrence if a duplicate somehow appears', () => {
    const index = indexItemsByNormalizedSku([
      CURRENT,
      { ...OTHER, normalizedSku: 'ABC-001', id: 'item-3' },
    ]);
    expect(index.get('ABC-001')?.id).toBe('item-1');
  });
});

describe('isScanSubmitKey (section 3.5)', () => {
  it('accepts Enter and Numpad Enter', () => {
    expect(isScanSubmitKey({ key: 'Enter' })).toBe(true);
    expect(isScanSubmitKey({ key: 'Enter', code: 'NumpadEnter' })).toBe(true);
    expect(isScanSubmitKey({ key: 'Unidentified', code: 'NumpadEnter' })).toBe(true);
  });

  it('ignores other keys', () => {
    expect(isScanSubmitKey({ key: 'a' })).toBe(false);
    expect(isScanSubmitKey({ key: 'Tab' })).toBe(false);
  });
});

describe('scanSuccessAnnouncement (section 36)', () => {
  it('is concise', () => {
    expect(scanSuccessAnnouncement(14)).toBe('Count 14.');
  });
});
