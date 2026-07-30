/**
 * SKU normalization — specification section 14.
 *
 * THIS IS THE SINGLE SOURCE OF TRUTH. It is imported by:
 *   - Excel import       (src/features/imports)
 *   - Text import        (src/features/imports)
 *   - Scanner input      (src/features/counting)
 *   - Database comparison(netlify/shared/database)
 *   - Zoho matching      (netlify/shared/zoho)
 *
 * Do not re-implement any part of this in a feature module.
 */

/** The three representations that must be stored for every imported SKU. */
export interface SkuTriple {
  /** Exactly what the source produced, untouched. Used for error reporting. */
  readonly raw: string;
  /** Human-facing value: trimmed, control characters removed, case preserved. */
  readonly display: string;
  /** Comparison key. Case-folded unless case-sensitive matching is configured. */
  readonly normalized: string;
}

export interface NormalizeOptions {
  /**
   * When true, `normalized` preserves case. Default false (case-insensitive
   * matching), per section 14 rule 10.
   */
  readonly caseSensitive?: boolean;
}

/**
 * Rule 1: "Convert any non-string cell value to its displayed string
 * representation."
 *
 * Handles the shapes ExcelJS produces for a cell value in addition to
 * primitives. Deliberately avoids `parseFloat`/`Number()` round-trips so that
 * leading zeros and long digit strings survive (rules 5-7).
 */
export function toDisplayString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    // `String(1e21)` yields "1e+21"; render plain digits for integers instead.
    if (Number.isInteger(value) && Math.abs(value) < 1e21) return value.toFixed(0);
    return String(value);
  }

  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;

    // ExcelJS rich text: { richText: [{ text: 'AB' }, { text: '-001' }] }
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((run) => toDisplayString((run as Record<string, unknown>)?.text))
        .join('');
    }
    // ExcelJS formula cell: { formula: 'A1&B1', result: 'AB-001' }
    if ('result' in obj) return toDisplayString(obj.result);
    // ExcelJS hyperlink cell: { text: 'AB-001', hyperlink: '...' }
    if ('text' in obj) return toDisplayString(obj.text);
    // ExcelJS error cell: { error: '#REF!' } — surface it so the row fails loudly.
    if ('error' in obj) return toDisplayString(obj.error);

    return '';
  }

  return '';
}

/**
 * Strips leading/trailing whitespace and trailing CR/LF (rules 2-3) while
 * preserving every internal character — hyphens, slashes, periods, internal
 * spaces and leading zeros all survive (rules 4-5, 8).
 *
 * Also removes zero-width characters, which barcode scanners and spreadsheet
 * copy-paste occasionally inject and which are invisible to the operator.
 */
export function toDisplaySku(value: unknown): string {
  const asString = toDisplayString(value);
  return asString
    .replace(ZERO_WIDTH_CHARACTERS, '')
    .replace(/[\r\n]+$/g, '')
    .trim();
}

/**
 * U+200B zero-width space, U+200C/U+200D joiners, U+2060 word joiner and
 * U+FEFF byte-order mark. Written as escapes so the characters are visible in
 * source review — they are invisible in an editor and in the operator's UI.
 */
/**
 * U+200B zero-width space, U+200C/U+200D joiners, U+2060 word joiner and
 * U+FEFF byte-order mark.
 *
 * Built from explicit code points rather than written literally: these
 * characters are invisible in an editor, so a literal regex is unreviewable
 * and easy to corrupt. An alternation is used rather than a character class
 * because U+200D is a JOINER and can combine adjacent code points inside one.
 */
const ZERO_WIDTH_CODE_POINTS = [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff] as const;

const ZERO_WIDTH_CHARACTERS = new RegExp(
  ZERO_WIDTH_CODE_POINTS.map((codePoint) => `\\u${codePoint.toString(16).padStart(4, '0')}`).join(
    '|',
  ),
  'g',
);

/**
 * Produces the comparison key. Case folding uses `toUpperCase()` on the
 * invariant locale so that e.g. Turkish locales cannot change `i` → `İ`.
 */
export function toNormalizedSku(value: unknown, options: NormalizeOptions = {}): string {
  const display = toDisplaySku(value);
  return options.caseSensitive === true ? display : display.toUpperCase();
}

/** Builds the full raw/display/normalized triple for storage. */
export function normalizeSku(value: unknown, options: NormalizeOptions = {}): SkuTriple {
  return {
    raw: toDisplayString(value),
    display: toDisplaySku(value),
    normalized: toNormalizedSku(value, options),
  };
}

/** True when the value contains nothing usable as a SKU. */
export function isBlankSku(value: unknown): boolean {
  return toDisplaySku(value).length === 0;
}

/**
 * Compares two SKUs using the configured matching mode. Always route
 * comparisons through this helper rather than using `===` on raw values.
 */
export function skusMatch(a: unknown, b: unknown, options: NormalizeOptions = {}): boolean {
  const left = toNormalizedSku(a, options);
  if (left.length === 0) return false;
  return left === toNormalizedSku(b, options);
}

/**
 * Cleans a hardware-scanner submission — section 3.5.
 *
 * Scanners emulate a keyboard and append Enter; some models append CR, LF or
 * CRLF instead, and some prepend whitespace. Internal characters are never
 * split or altered.
 */
export function normalizeScannerInput(value: string, options: NormalizeOptions = {}): SkuTriple {
  return normalizeSku(value, options);
}

/**
 * Delimiters accepted by the paste-a-list importer — section 13.
 *
 * Deliberately NOT `+`: a blank line between two SKUs is a real blank fragment
 * that the import-result screen counts and ignores. CRLF is collapsed to LF
 * before splitting so a Windows line ending is one delimiter, not two.
 */
const TEXT_DELIMITERS = /[\n\t,;]/;

/** Trailing newline/whitespace is a universal copy-paste artifact, not a row. */
const TRAILING_SEPARATORS = /[\s,;]+$/;

export interface ParsedTextEntry {
  /** 1-based position in the pasted text, used as the source row number. */
  readonly sequence: number;
  readonly raw: string;
  readonly display: string;
  readonly normalized: string;
  readonly isBlank: boolean;
}

/**
 * Splits pasted text into candidate SKUs — section 13.
 *
 * Splits on newlines, tabs, commas and semicolons. Deliberately does NOT split
 * on spaces, because a SKU may contain an internal space.
 *
 * Blank fragments are retained and flagged `isBlank` so the import-result
 * screen can reconcile: passed + failed + ignored blanks equals the source row
 * count (section 17).
 *
 * Two normalizations happen first, because both are formatting rather than
 * data: a CRLF line ending becomes one separator, and a trailing
 * newline/comma at the very end of the paste is dropped. Without those, every
 * ordinary Windows paste would report phantom blank rows.
 */
export function parseSkuText(text: string, options: NormalizeOptions = {}): ParsedTextEntry[] {
  const prepared = text
    // A Windows line ending is ONE separator.
    .replace(/\r\n?/g, '\n')
    .replace(TRAILING_SEPARATORS, '');

  if (prepared.length === 0) return [];

  return prepared.split(TEXT_DELIMITERS).map((fragment, index) => {
    const triple = normalizeSku(fragment, options);
    return {
      sequence: index + 1,
      raw: triple.raw,
      display: triple.display,
      normalized: triple.normalized,
      isBlank: triple.display.length === 0,
    };
  });
}

/** Preliminary (pre-Zoho) status shown on the text preview screen — section 13. */
export type PreliminaryStatus =
  | 'ready_for_validation'
  | 'blank'
  | 'duplicate_in_list'
  | 'invalid_format';

export const PRELIMINARY_STATUS_LABEL: Record<PreliminaryStatus, string> = {
  ready_for_validation: 'Ready for validation',
  blank: 'Blank',
  duplicate_in_list: 'Duplicate within pasted list',
  invalid_format: 'Invalid format',
};

/** Practical upper bound; anything longer is a paste accident, not a SKU. */
export const MAX_SKU_LENGTH = 200;

/**
 * Assigns a preliminary status to each parsed entry. The first occurrence of a
 * normalized SKU is accepted; later occurrences are marked duplicates
 * (section 3.2).
 */
export function assignPreliminaryStatuses(
  entries: readonly ParsedTextEntry[],
): (ParsedTextEntry & { preliminaryStatus: PreliminaryStatus; duplicateOfSequence?: number })[] {
  const firstSeen = new Map<string, number>();

  return entries.map((entry) => {
    if (entry.isBlank) {
      return { ...entry, preliminaryStatus: 'blank' as const };
    }
    if (entry.display.length > MAX_SKU_LENGTH) {
      return { ...entry, preliminaryStatus: 'invalid_format' as const };
    }
    const seenAt = firstSeen.get(entry.normalized);
    if (seenAt !== undefined) {
      return {
        ...entry,
        preliminaryStatus: 'duplicate_in_list' as const,
        duplicateOfSequence: seenAt,
      };
    }
    firstSeen.set(entry.normalized, entry.sequence);
    return { ...entry, preliminaryStatus: 'ready_for_validation' as const };
  });
}
