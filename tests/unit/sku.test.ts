/**
 * SKU normalization — specification section 14.
 */

import { describe, expect, it } from 'vitest';
import {
  assignPreliminaryStatuses,
  isBlankSku,
  MAX_SKU_LENGTH,
  normalizeSku,
  parseSkuText,
  skusMatch,
  toDisplaySku,
  toDisplayString,
  toNormalizedSku,
} from '@/domain/sku';

describe('toDisplayString', () => {
  it('renders integers without exponent notation or decimals', () => {
    expect(toDisplayString(1001)).toBe('1001');
    expect(toDisplayString(0)).toBe('0');
    expect(toDisplayString(-42)).toBe('-42');
  });

  it('does not use floating-point parsing on strings (rule 7)', () => {
    // The critical case: a numeric-looking string keeps its leading zeros.
    expect(toDisplayString('0012345')).toBe('0012345');
    expect(toDisplayString('1.10')).toBe('1.10');
  });

  it('flattens ExcelJS rich text', () => {
    expect(toDisplayString({ richText: [{ text: 'AB' }, { text: '-001' }] })).toBe('AB-001');
  });

  it('uses the result of a formula cell', () => {
    expect(toDisplayString({ formula: 'A1&B1', result: 'AB-001' })).toBe('AB-001');
  });

  it('uses the text of a hyperlink cell', () => {
    expect(toDisplayString({ text: 'AB-001', hyperlink: 'https://example.com' })).toBe('AB-001');
  });

  it('returns an empty string for null and undefined', () => {
    expect(toDisplayString(null)).toBe('');
    expect(toDisplayString(undefined)).toBe('');
  });
});

describe('toDisplaySku', () => {
  it('trims surrounding whitespace and trailing CR/LF (rules 2-3)', () => {
    expect(toDisplaySku('  ab-001\r\n')).toBe('ab-001');
    expect(toDisplaySku('\tab-001\n')).toBe('ab-001');
  });

  it('preserves internal characters (rules 4, 8)', () => {
    expect(toDisplaySku(' PART 500 X ')).toBe('PART 500 X');
    expect(toDisplaySku('A/B-C.D_E')).toBe('A/B-C.D_E');
  });

  it('preserves leading zeros (rule 5)', () => {
    expect(toDisplaySku('0012345')).toBe('0012345');
  });

  it('strips invisible zero-width characters', () => {
    expect(toDisplaySku('AB​-001')).toBe('AB-001');
    expect(toDisplaySku('﻿AB-001')).toBe('AB-001');
  });
});

describe('normalizeSku', () => {
  it('produces the documented raw/display/normalized triple', () => {
    // The worked example from section 14.
    const triple = normalizeSku('  ab-001\r\n');
    expect(triple.raw).toBe('  ab-001\r\n');
    expect(triple.display).toBe('ab-001');
    expect(triple.normalized).toBe('AB-001');
  });

  it('preserves case when case-sensitive matching is configured (rule 10)', () => {
    expect(normalizeSku('ab-001', { caseSensitive: true }).normalized).toBe('ab-001');
    expect(normalizeSku('ab-001', { caseSensitive: false }).normalized).toBe('AB-001');
  });

  it('never converts the SKU to a number (rule 6)', () => {
    expect(normalizeSku('0012345').normalized).toBe('0012345');
    expect(normalizeSku(12345).normalized).toBe('12345');
  });
});

describe('skusMatch', () => {
  it('matches case-insensitively by default', () => {
    expect(skusMatch('ab-001', 'AB-001')).toBe(true);
  });

  it('respects case-sensitive mode', () => {
    expect(skusMatch('ab-001', 'AB-001', { caseSensitive: true })).toBe(false);
  });

  it('never matches two blanks', () => {
    expect(skusMatch('', '')).toBe(false);
    expect(skusMatch('   ', null)).toBe(false);
  });

  it('ignores surrounding whitespace on both sides', () => {
    expect(skusMatch('  AB-001  ', 'ab-001\r\n')).toBe(true);
  });
});

describe('isBlankSku', () => {
  it('treats whitespace-only values as blank', () => {
    expect(isBlankSku('')).toBe(true);
    expect(isBlankSku('   \r\n')).toBe(true);
    expect(isBlankSku(null)).toBe(true);
    expect(isBlankSku('A')).toBe(false);
  });
});

describe('parseSkuText', () => {
  it('splits on newlines, tabs, commas and semicolons', () => {
    const entries = parseSkuText('A-1\nB-2\tC-3,D-4;E-5');
    expect(entries.map((entry) => entry.normalized)).toEqual([
      'A-1',
      'B-2',
      'C-3',
      'D-4',
      'E-5',
    ]);
  });

  it('does NOT split on plain spaces, because a SKU may contain one', () => {
    const entries = parseSkuText('PART 500 X');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.normalized).toBe('PART 500 X');
  });

  it('handles CRLF line endings', () => {
    const entries = parseSkuText('A-1\r\nB-2');
    expect(entries.map((entry) => entry.normalized)).toEqual(['A-1', 'B-2']);
  });

  it('retains an internal blank fragment so counts can reconcile', () => {
    const entries = parseSkuText('A-1\n\nB-2');
    expect(entries).toHaveLength(3);
    expect(entries[1]?.isBlank).toBe(true);
  });

  it('retains a leading blank fragment', () => {
    const entries = parseSkuText('\nA-1');
    expect(entries).toHaveLength(2);
    expect(entries[0]?.isBlank).toBe(true);
    expect(entries[1]?.normalized).toBe('A-1');
  });

  it('drops the trailing newline that every paste ends with', () => {
    expect(parseSkuText('A-1\nB-2\n')).toHaveLength(2);
    expect(parseSkuText('A-1\r\nB-2\r\n')).toHaveLength(2);
    expect(parseSkuText('A-1,B-2,')).toHaveLength(2);
  });

  it('treats a CRLF line ending as ONE separator', () => {
    // Splitting on \r and \n independently would invent a blank row between
    // every pair of lines on Windows.
    const entries = parseSkuText('A-1\r\nB-2\r\nC-3');
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => !entry.isBlank)).toBe(true);
  });

  it('returns nothing for whitespace-only input', () => {
    expect(parseSkuText('\n\n  \n')).toEqual([]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseSkuText('')).toEqual([]);
  });
});

describe('assignPreliminaryStatuses', () => {
  it('accepts the first occurrence and flags later duplicates with its row', () => {
    const entries = assignPreliminaryStatuses(parseSkuText('AB-001\nCD-002\nab-001'));
    expect(entries[0]?.preliminaryStatus).toBe('ready_for_validation');
    expect(entries[1]?.preliminaryStatus).toBe('ready_for_validation');
    expect(entries[2]?.preliminaryStatus).toBe('duplicate_in_list');
    // Section 3.2: show the row number of the first accepted occurrence.
    expect(entries[2]?.duplicateOfSequence).toBe(1);
  });

  it('marks blanks separately from duplicates', () => {
    const entries = assignPreliminaryStatuses(parseSkuText('AB-001\n\nAB-001'));
    expect(entries[1]?.preliminaryStatus).toBe('blank');
    expect(entries[2]?.preliminaryStatus).toBe('duplicate_in_list');
  });

  it('flags implausibly long values as invalid format', () => {
    const entries = assignPreliminaryStatuses(parseSkuText('X'.repeat(MAX_SKU_LENGTH + 1)));
    expect(entries[0]?.preliminaryStatus).toBe('invalid_format');
  });

  it('treats case-different duplicates as distinct when case-sensitive', () => {
    const entries = assignPreliminaryStatuses(
      parseSkuText('AB-001\nab-001', { caseSensitive: true }),
    );
    expect(entries[1]?.preliminaryStatus).toBe('ready_for_validation');
  });
});

describe('toNormalizedSku', () => {
  it('is stable across the four call sites that must agree', () => {
    // Excel cell (number), pasted text, scanner input and database value must
    // all normalize identically.
    const fromExcelNumber = toNormalizedSku(12345);
    const fromPastedText = toNormalizedSku('12345\n');
    const fromScanner = toNormalizedSku('  12345\r');
    const fromDatabase = toNormalizedSku('12345');
    expect(new Set([fromExcelNumber, fromPastedText, fromScanner, fromDatabase]).size).toBe(1);
  });
});
