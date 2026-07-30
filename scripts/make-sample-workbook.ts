/**
 * Generates `samples/demo-stock-list.xlsx` for local import testing —
 * specification section 42 ("Provide a sample Excel import file").
 *
 *   npx tsx scripts/make-sample-workbook.ts
 *
 * The sheet deliberately contains the awkward rows the import-result screen
 * must report: a blank cell, a duplicate, an unknown SKU, an inactive item, a
 * non-inventory item, an ambiguous SKU, a leading-zero SKU (stored as TEXT so
 * the zeros survive) and a SKU with an internal space.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const OUTPUT_FILE = join(OUTPUT_DIR, 'demo-stock-list.xlsx');

interface SampleRow {
  sku: string;
  note: string;
}

const ROWS: SampleRow[] = [
  { sku: 'SKU-0001', note: 'Valid — matches the mock catalogue' },
  { sku: 'SKU-0002', note: 'Valid' },
  { sku: 'SKU-0003', note: 'Valid — zero stock in Zoho' },
  { sku: 'ABC-001', note: 'Valid' },
  { sku: 'XYZ-002', note: 'Valid' },
  { sku: '', note: 'Blank — reported as an ignored blank row' },
  { sku: 'sku-0001', note: 'Duplicate of row 2 under case-insensitive matching' },
  { sku: 'DOES-NOT-EXIST', note: 'Unknown — SKU_NOT_FOUND' },
  { sku: 'INACTIVE-001', note: 'Inactive item — INACTIVE_ITEM' },
  { sku: 'SERVICE-001', note: 'Not stock-tracked — NOT_INVENTORY_TRACKED' },
  { sku: 'AMBIG-001', note: 'Two Zoho items share this SKU — AMBIGUOUS_SKU' },
  { sku: 'NOLOC-001', note: 'No stock at the configured location — STOCK_BASIS_NOT_FOUND' },
  { sku: '0012345', note: 'Leading zeros — must survive as text' },
  { sku: 'PART 500 X', note: 'Internal spaces — must not be split' },
  { sku: '  SKU-0007  ', note: 'Surrounding whitespace — trimmed by normalization' },
  { sku: 'SKU-0008', note: 'Valid' },
  { sku: 'SKU-0009', note: 'Valid' },
  { sku: 'SKU-0010', note: 'Valid' },
];

async function main(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Stock Recheck sample generator';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Stock List');

  // Column B holds the SKU so the mapping step has a real decision to make
  // rather than defaulting to the first column.
  sheet.columns = [
    { header: 'Line', key: 'line', width: 8 },
    { header: 'Item SKU', key: 'sku', width: 24 },
    { header: 'Notes', key: 'note', width: 60 },
  ];
  sheet.getRow(1).font = { bold: true };

  ROWS.forEach((row, index) => {
    const added = sheet.addRow({ line: index + 1, sku: row.sku, note: row.note });
    // Text format keeps 0012345 from becoming 12345.
    added.getCell('sku').numFmt = '@';
  });

  // A second worksheet so the worksheet-selection step is exercised too.
  const other = workbook.addWorksheet('Notes');
  other.addRow(['This second sheet exists so the worksheet picker has a choice.']);
  other.addRow(['Select "Stock List" and map column B (Item SKU).']);

  await mkdir(OUTPUT_DIR, { recursive: true });
  await workbook.xlsx.writeFile(OUTPUT_FILE);

  console.log(`Wrote ${OUTPUT_FILE}`);
  console.log(`  ${ROWS.length} rows across 2 worksheets`);
  console.log('  Map column B ("Item SKU") during the import wizard.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
