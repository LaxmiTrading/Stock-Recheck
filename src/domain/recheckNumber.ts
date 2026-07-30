/**
 * Stock Recheck identifiers and business-date handling — specification
 * sections 3.1 and 28.1.
 *
 *   Number:       SR-20260723-001
 *   Display name: Stock Recheck — 23 Jul 2026 — 001
 *
 * All dates are interpreted in the configured business timezone, defaulting to
 * Asia/Kolkata. Never use the server's local timezone.
 */

export const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_RECHECK_PREFIX = 'SR';

/** Number of digits in the per-day sequence. `1` → `001`. */
const SEQUENCE_DIGITS = 3;

/**
 * Extracts the Y/M/D parts of an instant as observed in `timeZone`.
 * `Intl.DateTimeFormat` is the only correct way to do this in JS — manual
 * offset arithmetic breaks across DST and around the date line.
 */
function partsInTimeZone(
  instant: Date,
  timeZone: string,
): { year: string; month: string; day: string } {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const lookup = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';

  return { year: lookup('year'), month: lookup('month'), day: lookup('day') };
}

/** Returns the business date as `YYYY-MM-DD` in the configured timezone. */
export function businessDateInTimeZone(
  instant: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): string {
  const { year, month, day } = partsInTimeZone(instant, timeZone);
  return `${year}-${month}-${day}`;
}

/** Compacts `YYYY-MM-DD` to `YYYYMMDD` for the identifier. */
export function compactBusinessDate(businessDate: string): string {
  return businessDate.slice(0, 10).replace(/-/g, '');
}

export function formatSequence(sequence: number): string {
  return String(Math.max(1, Math.trunc(sequence))).padStart(SEQUENCE_DIGITS, '0');
}

/** `SR-20260723-001` */
export function formatRecheckNumber(
  businessDate: string,
  sequence: number,
  prefix: string = DEFAULT_RECHECK_PREFIX,
): string {
  return `${prefix}-${compactBusinessDate(businessDate)}-${formatSequence(sequence)}`;
}

/**
 * Parses an identifier back into its parts. Returns null when the value does
 * not match the expected shape.
 */
export function parseRecheckNumber(
  recheckNumber: string,
): { prefix: string; businessDate: string; sequence: number } | null {
  const match = /^([A-Za-z0-9]+)-(\d{4})(\d{2})(\d{2})-(\d+)$/.exec(recheckNumber);
  if (!match) return null;
  const [, prefix, year, month, day, sequence] = match;
  return {
    prefix: prefix as string,
    businessDate: `${year}-${month}-${day}`,
    sequence: Number.parseInt(sequence as string, 10),
  };
}

/** `23 Jul 2026` — the human-readable date used inside display names. */
export function formatBusinessDateLong(
  businessDate: string,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): string {
  // Interpret the plain date at midday UTC so that no timezone shift can move
  // it onto an adjacent calendar day.
  const instant = new Date(`${businessDate.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(instant.getTime())) return businessDate;

  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(instant);
}

/** `Stock Recheck — 23 Jul 2026 — 001` (em dashes, per section 3.1). */
export function formatRecheckDisplayName(
  businessDate: string,
  sequence: number,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): string {
  return `Stock Recheck — ${formatBusinessDateLong(businessDate, timeZone)} — ${formatSequence(sequence)}`;
}

/** Section 18 — the name field is required and capped at 100 characters. */
export const MAX_RECHECK_NAME_LENGTH = 100;

export function isValidRecheckName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_RECHECK_NAME_LENGTH;
}

/** Validates a `YYYY-MM-DD` business date. */
export function isValidBusinessDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(`${value}T12:00:00Z`);
  if (Number.isNaN(instant.getTime())) return false;
  // Round-trip guards against 2026-02-31 style values.
  return instant.toISOString().slice(0, 10) === value;
}

/** Formats an instant for display using the business timezone. */
export function formatDateTime(
  value: string | Date | null | undefined,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): string {
  if (value === null || value === undefined) return '—';
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return '—';

  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant);
}

/** Short relative label such as "4 min ago", used for claim ages. */
export function formatRelativeTime(value: string | Date | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined) return '—';
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return '—';

  const deltaSeconds = Math.round((instant.getTime() - now) / 1000);
  const absolute = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  if (absolute < 60) return formatter.format(Math.round(deltaSeconds), 'second');
  if (absolute < 3600) return formatter.format(Math.round(deltaSeconds / 60), 'minute');
  if (absolute < 86_400) return formatter.format(Math.round(deltaSeconds / 3600), 'hour');
  return formatter.format(Math.round(deltaSeconds / 86_400), 'day');
}
