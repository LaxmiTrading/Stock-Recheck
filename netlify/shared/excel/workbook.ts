/**
 * Server-side Excel generation — specification sections 17, 25 and 34.
 *
 * The difference workbook has a strict contract: exactly three columns, in
 * order, with those exact headings, no title row and no merged cells. The
 * column definitions come from the shared `exportContract` module so the
 * contract cannot drift between the generator and its tests.
 */

import ExcelJS from 'exceljs';
import {
  EXPORT_COLUMN_HEADERS,
  FAILED_ROWS_COLUMN_HEADERS,
  escapeSpreadsheetText,
  type ExportRow,
  type FailedRowExport,
} from '../../../src/domain/exportContract';
import { ExportFailedError } from '../errors';

/**
 * Excel's "Text" number format. Applied to the SKU column so that values such
 * as `0012345` keep their leading zeros instead of being coerced to 12345
 * (section 25).
 */
const TEXT_FORMAT = '@';

function createWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Stock Recheck';
  workbook.created = new Date();
  return workbook;
}

/**
 * Builds the difference workbook.
 *
 * Row 1 is the header row — deliberately NOT preceded by a title row.
 * Text cells are escaped against formula injection; the numeric difference
 * cell is written as a real number and left untouched (section 34).
 */
export async function buildDifferenceWorkbook(rows: readonly ExportRow[]): Promise<Uint8Array> {
  try {
    const workbook = createWorkbook();
    const sheet = workbook.addWorksheet('Stock Recheck');

    sheet.columns = [
      { header: EXPORT_COLUMN_HEADERS[0], key: 'itemName', width: 46 },
      { header: EXPORT_COLUMN_HEADERS[1], key: 'sku', width: 24 },
      { header: EXPORT_COLUMN_HEADERS[2], key: 'qtyDifference', width: 16 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true };
    // No merged cells, no title row: the header row is row 1 exactly.

    for (const row of rows) {
      const added = sheet.addRow({
        itemName: escapeSpreadsheetText(row.itemName),
        sku: escapeSpreadsheetText(row.sku),
        qtyDifference: row.qtyDifference,
      });

      // Force the SKU cell to text so leading zeros survive a round trip.
      added.getCell('sku').numFmt = TEXT_FORMAT;
      // Signed integer display: 0, 2, -3.
      added.getCell('qtyDifference').numFmt = '0';
    }

    sheet.getColumn('sku').numFmt = TEXT_FORMAT;
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buffer as ArrayBuffer);
  } catch (error) {
    throw new ExportFailedError(
      error instanceof Error ? `The export could not be generated: ${error.message}` : undefined,
    );
  }
}

/**
 * Failed-import-rows workbook — section 17.
 * Explicitly NOT the final stock-difference export.
 */
export async function buildFailedRowsWorkbook(
  rows: readonly FailedRowExport[],
): Promise<Uint8Array> {
  try {
    const workbook = createWorkbook();
    const sheet = workbook.addWorksheet('Failed Rows');

    sheet.columns = [
      { header: FAILED_ROWS_COLUMN_HEADERS[0], key: 'sourceRow', width: 12 },
      { header: FAILED_ROWS_COLUMN_HEADERS[1], key: 'rawValue', width: 30 },
      { header: FAILED_ROWS_COLUMN_HEADERS[2], key: 'normalizedSku', width: 30 },
      { header: FAILED_ROWS_COLUMN_HEADERS[3], key: 'failureCode', width: 30 },
      { header: FAILED_ROWS_COLUMN_HEADERS[4], key: 'failureReason', width: 60 },
    ];
    sheet.getRow(1).font = { bold: true };

    for (const row of rows) {
      const added = sheet.addRow({
        sourceRow: row.sourceRow,
        rawValue: escapeSpreadsheetText(row.rawValue),
        normalizedSku: escapeSpreadsheetText(row.normalizedSku),
        failureCode: escapeSpreadsheetText(row.failureCode),
        failureReason: escapeSpreadsheetText(row.failureReason),
      });
      added.getCell('rawValue').numFmt = TEXT_FORMAT;
      added.getCell('normalizedSku').numFmt = TEXT_FORMAT;
    }

    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();
    return new Uint8Array(buffer as ArrayBuffer);
  } catch (error) {
    throw new ExportFailedError(
      error instanceof Error ? `The export could not be generated: ${error.message}` : undefined,
    );
  }
}

/**
 * Reads a generated workbook back into rows.
 * Used by the export tests to assert the contract on the real bytes rather
 * than on the in-memory model.
 */
export async function readWorkbookRows(
  bytes: Uint8Array,
): Promise<{ headers: string[]; rows: (string | number | null)[][] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);

  const sheet = workbook.worksheets[0];
  if (sheet === undefined) return { headers: [], rows: [] };

  const headers: string[] = [];
  const rows: (string | number | null)[][] = [];

  sheet.eachRow((row, rowNumber) => {
    const values: (string | number | null)[] = [];
    row.eachCell({ includeEmpty: true }, (cell) => {
      const value = cell.value;
      if (value === null || value === undefined) values.push(null);
      else if (typeof value === 'number' || typeof value === 'string') values.push(value);
      else if (typeof value === 'object' && 'result' in value) {
        values.push((value as { result: string | number }).result);
      } else values.push(String(value));
    });

    if (rowNumber === 1) headers.push(...values.map((value) => String(value ?? '')));
    else rows.push(values);
  });

  return { headers, rows };
}
