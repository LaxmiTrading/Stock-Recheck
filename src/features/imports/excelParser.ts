/**
 * Client-side workbook parsing — specification section 12.
 *
 * Parsing happens in the browser so the operator can choose a worksheet,
 * header row and SKU column before anything is sent to the server. Only the
 * mapped SKU column is ever uploaded — the rest of the spreadsheet never
 * leaves the device.
 *
 * Cell values pass through the SHARED normalization helpers so an Excel import
 * and a pasted list produce byte-identical SKUs.
 */

import ExcelJS from 'exceljs';
import { toDisplaySku, toDisplayString } from '@/domain/sku';

export interface ParsedWorksheet {
  name: string;
  rowCount: number;
  columnCount: number;
  /** Row-major cell text. Index 0 is spreadsheet row 1. */
  rows: string[][];
}

export interface ParsedWorkbook {
  fileName: string;
  fileSize: number;
  worksheets: ParsedWorksheet[];
}

export class WorkbookParseError extends Error {
  readonly reason:
    | 'unsupported_extension'
    | 'empty_file'
    | 'too_large'
    | 'password_protected'
    | 'corrupt'
    | 'no_readable_worksheet'
    | 'too_many_rows';

  constructor(reason: WorkbookParseError['reason'], message: string) {
    super(message);
    this.name = 'WorkbookParseError';
    this.reason = reason;
  }
}

const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

/** Cheap structural validation before the expensive parse — section 12.1. */
export function validateFile(
  file: File,
  limits: { maxFileSizeBytes: number },
): WorkbookParseError | null {
  const lowerName = file.name.toLowerCase();

  if (!ACCEPTED_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    return new WorkbookParseError(
      'unsupported_extension',
      `"${file.name}" is not a supported format. Upload an .xlsx, .xls or .csv file.`,
    );
  }
  if (file.size === 0) {
    return new WorkbookParseError('empty_file', 'This file is empty.');
  }
  if (file.size > limits.maxFileSizeBytes) {
    const limitMb = Math.round(limits.maxFileSizeBytes / (1024 * 1024));
    return new WorkbookParseError(
      'too_large',
      `This file is ${formatBytes(file.size)}, which exceeds the ${limitMb} MB limit.`,
    );
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Parses a CSV that respects quoted fields containing commas and newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] as string;

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads a file into worksheets.
 *
 * @throws WorkbookParseError with a specific reason so the UI can show a
 *         precise message rather than "invalid file" (section 12.1).
 */
export async function parseWorkbook(
  file: File,
  limits: { maxFileSizeBytes: number; maxRows: number },
): Promise<ParsedWorkbook> {
  const structuralError = validateFile(file, limits);
  if (structuralError !== null) throw structuralError;

  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith('.csv')) {
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length === 0) {
      throw new WorkbookParseError('no_readable_worksheet', 'This file contains no rows.');
    }
    return {
      fileName: file.name,
      fileSize: file.size,
      worksheets: [
        {
          name: 'CSV',
          rowCount: rows.length,
          columnCount: Math.max(...rows.map((row) => row.length)),
          rows,
        },
      ],
    };
  }

  const buffer = await file.arrayBuffer();
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    // ExcelJS cannot open an encrypted workbook; the message mentions it.
    if (message.includes('encrypt') || message.includes('password')) {
      throw new WorkbookParseError(
        'password_protected',
        'This workbook is password-protected. Remove the password and upload it again.',
      );
    }
    throw new WorkbookParseError(
      'corrupt',
      'This file could not be read. It may be corrupted or saved in an unsupported format.',
    );
  }

  const worksheets: ParsedWorksheet[] = [];

  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    let maxColumn = 0;

    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const values: string[] = [];
      // `row.cellCount` is the last populated column in this row.
      const cellCount = Math.max(row.cellCount, row.actualCellCount);
      for (let column = 1; column <= cellCount; column += 1) {
        values.push(toDisplayString(row.getCell(column).value));
      }
      maxColumn = Math.max(maxColumn, values.length);
      // rowNumber is 1-based; keep positions aligned with the spreadsheet.
      rows[rowNumber - 1] = values;
    });

    // Fill any holes left by entirely empty rows.
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index] === undefined) rows[index] = [];
    }

    worksheets.push({
      name: sheet.name,
      rowCount: rows.length,
      columnCount: maxColumn,
      rows,
    });
  });

  if (worksheets.length === 0) {
    throw new WorkbookParseError(
      'no_readable_worksheet',
      'This workbook contains no readable worksheets.',
    );
  }

  const largestSheet = Math.max(...worksheets.map((sheet) => sheet.rowCount));
  if (largestSheet > limits.maxRows) {
    throw new WorkbookParseError(
      'too_many_rows',
      `This worksheet has ${largestSheet.toLocaleString()} rows, which exceeds the ${limits.maxRows.toLocaleString()} row limit.`,
    );
  }

  return { fileName: file.name, fileSize: file.size, worksheets };
}

/** Converts a zero-based column index to its spreadsheet letter (0 → A). */
export function columnLetter(index: number): string {
  let result = '';
  let current = index;
  while (current >= 0) {
    result = String.fromCharCode((current % 26) + 65) + result;
    current = Math.floor(current / 26) - 1;
  }
  return result;
}

export interface ColumnOption {
  index: number;
  letter: string;
  header: string;
  samples: string[];
  /** `B — Item SKU — SK123, SK124, SK125` (section 12.4). */
  label: string;
}

/**
 * Builds the mapping dropdown options: column letter, header value and a few
 * example values from the first data rows (section 12.4).
 */
export function buildColumnOptions(
  worksheet: ParsedWorksheet,
  headerRowNumber: number,
  firstRowIsHeading: boolean,
): ColumnOption[] {
  const headerRow = firstRowIsHeading ? (worksheet.rows[headerRowNumber - 1] ?? []) : [];
  const firstDataRow = firstRowIsHeading ? headerRowNumber : headerRowNumber - 1;

  const options: ColumnOption[] = [];
  for (let index = 0; index < worksheet.columnCount; index += 1) {
    const header = (headerRow[index] ?? '').trim();
    const samples: string[] = [];

    for (
      let rowIndex = firstDataRow;
      rowIndex < worksheet.rows.length && samples.length < 3;
      rowIndex += 1
    ) {
      const value = toDisplaySku(worksheet.rows[rowIndex]?.[index]);
      if (value !== '') samples.push(value);
    }

    const letter = columnLetter(index);
    const labelParts = [letter];
    if (header !== '') labelParts.push(header);
    if (samples.length > 0) labelParts.push(samples.join(', '));

    options.push({ index, letter, header, samples, label: labelParts.join(' — ') });
  }
  return options;
}

/** Heading patterns that should auto-select a column — section 12.4. */
const AUTO_DETECT_PATTERNS = [
  'sku',
  'itemsku',
  'stockkeepingunit',
  'itemcode',
  'productsku',
  'productcode',
];

export function autoDetectSkuColumn(options: readonly ColumnOption[]): number | null {
  const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const option of options) {
    if (AUTO_DETECT_PATTERNS.includes(normalize(option.header))) return option.index;
  }
  // Weaker fallback: a heading that merely contains "sku".
  for (const option of options) {
    if (normalize(option.header).includes('sku')) return option.index;
  }
  return null;
}

export interface ExtractedRow {
  sourceRowNumber: number;
  rawValue: string;
}

/**
 * Pulls the mapped column out of the worksheet.
 *
 * `sourceRowNumber` is the SPREADSHEET row number, so failure messages point
 * the operator at the row they can actually see in Excel.
 */
export function extractSkuColumn(
  worksheet: ParsedWorksheet,
  columnIndex: number,
  headerRowNumber: number,
  firstRowIsHeading: boolean,
): ExtractedRow[] {
  const firstDataRowIndex = firstRowIsHeading ? headerRowNumber : headerRowNumber - 1;
  const extracted: ExtractedRow[] = [];

  for (let index = firstDataRowIndex; index < worksheet.rows.length; index += 1) {
    const rawValue = toDisplayString(worksheet.rows[index]?.[columnIndex]);
    extracted.push({ sourceRowNumber: index + 1, rawValue });
  }

  // Trailing blank rows are an artefact of how Excel stores a sheet, not data
  // the operator typed; drop them so the reconciliation totals make sense.
  while (extracted.length > 0 && (extracted[extracted.length - 1] as ExtractedRow).rawValue.trim() === '') {
    extracted.pop();
  }

  return extracted;
}
