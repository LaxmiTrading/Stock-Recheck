/**
 * Export contract and formula-injection protection — specification
 * sections 25 and 34.
 */

import { describe, expect, it } from 'vitest';
import {
  buildExportFileName,
  buildExportRows,
  escapeSpreadsheetText,
  exportButtonLabel,
  EXPORT_COLUMN_HEADERS,
  needsFormulaEscaping,
  sanitizeExportRow,
  type ExportableItem,
} from '@/domain/exportContract';

const ITEMS: ExportableItem[] = [
  {
    itemName: 'Hex Bolt M8',
    sku: 'SKU-0001',
    quantityDifference: 0,
    resultStatus: 'matched',
    submittedAt: '2026-07-25T10:00:00Z',
  },
  {
    itemName: 'Hex Nut M8',
    sku: 'SKU-0002',
    quantityDifference: 2,
    resultStatus: 'mismatched',
    submittedAt: '2026-07-25T10:05:00Z',
  },
  {
    itemName: 'Washer M8',
    sku: 'SKU-0003',
    quantityDifference: -3,
    resultStatus: 'mismatched',
    submittedAt: '2026-07-25T10:10:00Z',
  },
  {
    // Never submitted: must be excluded from every filter.
    itemName: 'Uncounted Item',
    sku: 'SKU-9999',
    quantityDifference: null,
    resultStatus: 'pending',
    submittedAt: null,
  },
];

describe('EXPORT_COLUMN_HEADERS', () => {
  it('is exactly the three required columns in order', () => {
    expect(EXPORT_COLUMN_HEADERS).toEqual(['Item Name', 'SKU', 'Qty Difference']);
    expect(EXPORT_COLUMN_HEADERS).toHaveLength(3);
  });
});

describe('buildExportRows', () => {
  it('includes every submitted item by default', () => {
    const rows = buildExportRows(ITEMS);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.sku)).toEqual(['SKU-0001', 'SKU-0002', 'SKU-0003']);
  });

  it('excludes items that were never submitted', () => {
    const rows = buildExportRows(ITEMS);
    expect(rows.some((row) => row.sku === 'SKU-9999')).toBe(false);
  });

  it('applies the mismatched-only filter', () => {
    const rows = buildExportRows(ITEMS, 'mismatched_only');
    expect(rows.map((row) => row.qtyDifference)).toEqual([2, -3]);
  });

  it('applies the matched-only filter', () => {
    const rows = buildExportRows(ITEMS, 'matched_only');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qtyDifference).toBe(0);
  });

  it('keeps differences signed and numeric', () => {
    const rows = buildExportRows(ITEMS);
    expect(rows.map((row) => row.qtyDifference)).toEqual([0, 2, -3]);
    for (const row of rows) expect(typeof row.qtyDifference).toBe('number');
  });
});

describe('escapeSpreadsheetText', () => {
  it('neutralizes every formula trigger character', () => {
    expect(escapeSpreadsheetText('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(escapeSpreadsheetText('+1234')).toBe("'+1234");
    expect(escapeSpreadsheetText('-1+2')).toBe("'-1+2");
    expect(escapeSpreadsheetText('@import')).toBe("'@import");
  });

  it('neutralizes leading tab and carriage return', () => {
    expect(escapeSpreadsheetText('\t=1+1')).toBe("'\t=1+1");
    expect(escapeSpreadsheetText('\r=1+1')).toBe("'\r=1+1");
  });

  it('leaves ordinary values untouched', () => {
    expect(escapeSpreadsheetText('SKU-0001')).toBe('SKU-0001');
    expect(escapeSpreadsheetText('0012345')).toBe('0012345');
    expect(escapeSpreadsheetText('PART 500 X')).toBe('PART 500 X');
    expect(escapeSpreadsheetText('')).toBe('');
  });

  it('does not escape a trigger character that is not leading', () => {
    expect(escapeSpreadsheetText('A=B')).toBe('A=B');
    expect(escapeSpreadsheetText('SKU-1-2')).toBe('SKU-1-2');
  });
});

describe('needsFormulaEscaping', () => {
  it('identifies dangerous values without altering them', () => {
    expect(needsFormulaEscaping('=cmd')).toBe(true);
    expect(needsFormulaEscaping('SKU-1')).toBe(false);
    expect(needsFormulaEscaping('')).toBe(false);
  });
});

describe('sanitizeExportRow', () => {
  it('escapes text columns but leaves the numeric difference alone', () => {
    const sanitized = sanitizeExportRow({
      itemName: '=HYPERLINK("http://evil","click")',
      sku: '-SKU-1',
      // A negative difference is a legitimate NUMBER and must not be escaped
      // (section 34).
      qtyDifference: -3,
    });

    expect(sanitized.itemName).toBe("'=HYPERLINK(\"http://evil\",\"click\")");
    expect(sanitized.sku).toBe("'-SKU-1");
    expect(sanitized.qtyDifference).toBe(-3);
    expect(typeof sanitized.qtyDifference).toBe('number');
  });
});

describe('buildExportFileName', () => {
  it('follows the documented naming pattern', () => {
    expect(buildExportFileName('SR-20260723-001', '2026-07-23')).toBe(
      'Stock_Recheck_SR-20260723-001_2026-07-23.xlsx',
    );
  });

  it('strips characters that are unsafe in a filename', () => {
    expect(buildExportFileName('SR/2026\\001', '2026-07-23')).toBe(
      'Stock_Recheck_SR_2026_001_2026-07-23.xlsx',
    );
  });

  it('truncates a full timestamp to the date', () => {
    expect(buildExportFileName('SR-1', '2026-07-23T10:00:00Z')).toContain('_2026-07-23.xlsx');
  });

  it('accepts a Date, which is what some drivers return for a DATE column', () => {
    // Regression: node-postgres maps DATE to a JS Date unless a type parser is
    // registered, and the export endpoint crashed on `businessDate.slice`.
    expect(buildExportFileName('SR-1', new Date('2026-07-23T00:00:00Z'))).toBe(
      'Stock_Recheck_SR-1_2026-07-23.xlsx',
    );
  });
});

describe('exportButtonLabel', () => {
  it('distinguishes a current summary from a final one (section 25)', () => {
    expect(exportButtonLabel(true)).toBe('Download Difference Excel');
    expect(exportButtonLabel(false)).toBe('Download Current Difference Excel');
  });
});
