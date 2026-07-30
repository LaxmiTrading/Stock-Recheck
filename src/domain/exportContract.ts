/**
 * Difference-workbook contract — specification section 25.
 *
 * The exported workbook must contain EXACTLY these columns, in this order,
 * with these exact headings, no title row, no merged cells, no extra columns.
 * Both the server generator and any client-side preview read this module so
 * the contract cannot drift.
 */

import type { ResultStatus } from './status';

export const EXPORT_COLUMN_HEADERS = ['Item Name', 'SKU', 'Qty Difference'] as const;
export type ExportColumnHeader = (typeof EXPORT_COLUMN_HEADERS)[number];

/** Header row is row 1. There is deliberately no title row above it. */
export const EXPORT_HEADER_ROW_INDEX = 1;

export interface ExportRow {
  /** Text cell. */
  itemName: string;
  /** Text cell — must stay text so leading zeros survive. */
  sku: string;
  /** Numeric cell — signed, never escaped. */
  qtyDifference: number;
}

export interface ExportableItem {
  itemName: string;
  sku: string;
  quantityDifference: number | null;
  resultStatus: ResultStatus;
  submittedAt: string | Date | null;
}

/** Section 25 — export filter. The workbook FORMAT never changes with the filter. */
export const EXPORT_FILTERS = ['all_submitted', 'mismatched_only', 'matched_only'] as const;
export type ExportFilter = (typeof EXPORT_FILTERS)[number];

export const EXPORT_FILTER_LABEL: Record<ExportFilter, string> = {
  all_submitted: 'All Submitted Items',
  mismatched_only: 'Mismatched Only',
  matched_only: 'Matched Only',
};

export function isExportFilter(value: string): value is ExportFilter {
  return (EXPORT_FILTERS as readonly string[]).includes(value);
}

/**
 * Selects and shapes the rows for export.
 *
 * Only submitted items are exportable — an item with no submission has no
 * difference to report. The default filter includes every submitted item.
 */
export function buildExportRows(
  items: readonly ExportableItem[],
  filter: ExportFilter = 'all_submitted',
): ExportRow[] {
  return items
    .filter((item) => item.submittedAt !== null && item.quantityDifference !== null)
    .filter((item) => {
      switch (filter) {
        case 'mismatched_only':
          return item.resultStatus === 'mismatched';
        case 'matched_only':
          return item.resultStatus === 'matched';
        case 'all_submitted':
          return true;
      }
    })
    .map((item) => ({
      itemName: item.itemName,
      sku: item.sku,
      qtyDifference: item.quantityDifference as number,
    }));
}

/* --------------------------------------------------- formula-injection guard */

/**
 * Characters that make a spreadsheet application treat a TEXT cell as a
 * formula — specification section 34.
 */
const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Neutralizes spreadsheet formula injection in a TEXT value.
 *
 * Prefixing with an apostrophe is the OWASP-recommended mitigation: Excel,
 * LibreOffice and Google Sheets all treat the remainder as a literal string,
 * and the apostrophe itself is not displayed in the cell.
 *
 * IMPORTANT: only ever call this on text cells (Item Name, SKU, failure
 * reasons). Numeric cells such as Qty Difference must pass through untouched
 * so that `-3` stays the number minus three (section 34).
 */
export function escapeSpreadsheetText(value: string): string {
  if (value.length === 0) return value;
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** True when the value would be interpreted as a formula if written raw. */
export function needsFormulaEscaping(value: string): boolean {
  return value.length > 0 && FORMULA_TRIGGER.test(value);
}

/**
 * Applies text escaping to the text columns only, leaving the numeric
 * difference untouched.
 */
export function sanitizeExportRow(row: ExportRow): ExportRow {
  return {
    itemName: escapeSpreadsheetText(row.itemName),
    sku: escapeSpreadsheetText(row.sku),
    qtyDifference: row.qtyDifference,
  };
}

/* ------------------------------------------------------------- file naming */

/**
 * `Stock_Recheck_[RecheckNumber]_[YYYY-MM-DD].xlsx` — section 25.
 *
 * Accepts a Date as well as a string: this is a shared contract helper and a
 * caller may hand it a value straight from a database driver that maps DATE
 * columns to Date objects.
 */
export function buildExportFileName(
  recheckNumber: string,
  businessDate: string | Date,
): string {
  const safeNumber = recheckNumber.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeDate =
    businessDate instanceof Date
      ? businessDate.toISOString().slice(0, 10)
      : String(businessDate).slice(0, 10);
  return `Stock_Recheck_${safeNumber}_${safeDate}.xlsx`;
}

/** Label changes while the recheck is incomplete — section 25. */
export function exportButtonLabel(isComplete: boolean): string {
  return isComplete ? 'Download Difference Excel' : 'Download Current Difference Excel';
}

/* ------------------------------------------- failed-rows workbook (section 17) */

export const FAILED_ROWS_COLUMN_HEADERS = [
  'Source Row',
  'Raw Value',
  'Normalized SKU',
  'Failure Code',
  'Failure Reason',
] as const;

export interface FailedRowExport {
  sourceRow: number;
  rawValue: string;
  normalizedSku: string;
  failureCode: string;
  failureReason: string;
}

export function buildFailedRowsFileName(importBatchId: string): string {
  const shortId = importBatchId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return `Import_Failed_Rows_${shortId}.xlsx`;
}
