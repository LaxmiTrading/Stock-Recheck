/**
 * Application settings — specification section 28.
 * Shared between the admin settings screens and the serverless functions that
 * enforce the limits.
 */

import { DEFAULT_CLAIM_LEASE_SECONDS, DEFAULT_HEARTBEAT_SECONDS, DEFAULT_STALE_GRACE_SECONDS } from './claims';
import { DEFAULT_BUSINESS_TIMEZONE, DEFAULT_RECHECK_PREFIX } from './recheckNumber';
import type { StockBasisType } from './stockBasis';

export interface AppSettings {
  /* 28.1 General */
  businessName: string;
  businessTimezone: string;
  dateFormat: string;
  recheckPrefix: string;
  maxImportRows: number;
  maxFileSizeBytes: number;
  /** false → case-insensitive matching (the default, section 14 rule 10). */
  skuCaseSensitive: boolean;
  defaultSort: string;
  scannerSoundEnabled: boolean;

  /* 28.3 Stock basis defaults (applied to NEW rechecks only) */
  defaultStockBasisType: StockBasisType;
  defaultLocationId: string | null;
  defaultLocationName: string | null;
  defaultWarehouseId: string | null;
  defaultWarehouseName: string | null;

  /* 28.4 Claim rules */
  claimLeaseSeconds: number;
  heartbeatSeconds: number;
  staleClaimGraceSeconds: number;
  countersMayReleaseOwnClaims: boolean;
  adminsMayForceRelease: boolean;

  /* 28.5 Scanner */
  blindCountEnabled: boolean;
  scannerSuccessSound: boolean;
  scannerErrorSound: boolean;
  scannerSuccessFlash: boolean;
  scannerErrorFlash: boolean;
  scannerRequireEnter: boolean;
  scannerAutoSelectInvalid: boolean;
  scannerPreventSleep: boolean;
}

export const DEFAULT_MAX_IMPORT_ROWS = 20_000;
export const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const DEFAULT_SETTINGS: AppSettings = {
  businessName: 'Stock Recheck',
  businessTimezone: DEFAULT_BUSINESS_TIMEZONE,
  dateFormat: 'dd MMM yyyy',
  recheckPrefix: DEFAULT_RECHECK_PREFIX,
  maxImportRows: DEFAULT_MAX_IMPORT_ROWS,
  maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
  skuCaseSensitive: false,
  defaultSort: 'item_name',
  scannerSoundEnabled: true,

  defaultStockBasisType: 'organization',
  defaultLocationId: null,
  defaultLocationName: null,
  defaultWarehouseId: null,
  defaultWarehouseName: null,

  claimLeaseSeconds: DEFAULT_CLAIM_LEASE_SECONDS,
  heartbeatSeconds: DEFAULT_HEARTBEAT_SECONDS,
  staleClaimGraceSeconds: DEFAULT_STALE_GRACE_SECONDS,
  countersMayReleaseOwnClaims: true,
  adminsMayForceRelease: true,

  blindCountEnabled: false,
  scannerSuccessSound: true,
  scannerErrorSound: true,
  scannerSuccessFlash: true,
  scannerErrorFlash: true,
  scannerRequireEnter: true,
  scannerAutoSelectInvalid: true,
  scannerPreventSleep: true,
};

/** Accepted file extensions for the Excel importer — section 12.1. */
export const ACCEPTED_IMPORT_EXTENSIONS = ['.xlsx', '.xls', '.csv'] as const;

export function hasAcceptedExtension(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ACCEPTED_IMPORT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Sort keys offered in the workspace — section 19. */
export const SORT_KEYS = [
  'item_name',
  'sku',
  'zoho_stock',
  'status',
  'claimed_at',
  'submitted_at',
  'quantity_difference',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const SORT_KEY_LABEL: Record<SortKey, string> = {
  item_name: 'Item name',
  sku: 'SKU',
  zoho_stock: 'Zoho stock',
  status: 'Status',
  claimed_at: 'Claimed time',
  submitted_at: 'Submitted time',
  quantity_difference: 'Qty difference',
};

export function isSortKey(value: string): value is SortKey {
  return (SORT_KEYS as readonly string[]).includes(value);
}

/** Pagination defaults — section 40. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;
export const DEFAULT_PAGE_SIZE = 50;

export function clampPageSize(value: number): number {
  const allowed = PAGE_SIZE_OPTIONS as readonly number[];
  return allowed.includes(value) ? value : DEFAULT_PAGE_SIZE;
}

/** Hard ceilings the server enforces regardless of configured settings. */
export const ABSOLUTE_MAX_IMPORT_ROWS = 100_000;
export const ABSOLUTE_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export interface SettingsValidationIssue {
  field: keyof AppSettings;
  message: string;
}

/** Server-side settings validation; also drives inline form errors. */
export function validateSettings(settings: Partial<AppSettings>): SettingsValidationIssue[] {
  const issues: SettingsValidationIssue[] = [];

  if (settings.businessName !== undefined && settings.businessName.trim().length === 0) {
    issues.push({ field: 'businessName', message: 'Business name is required.' });
  }

  if (settings.businessTimezone !== undefined && !isValidTimeZone(settings.businessTimezone)) {
    issues.push({ field: 'businessTimezone', message: 'Unknown IANA timezone identifier.' });
  }

  if (settings.recheckPrefix !== undefined && !/^[A-Za-z0-9]{1,10}$/.test(settings.recheckPrefix)) {
    issues.push({
      field: 'recheckPrefix',
      message: 'Prefix must be 1-10 letters or digits.',
    });
  }

  if (settings.maxImportRows !== undefined) {
    if (
      !Number.isInteger(settings.maxImportRows) ||
      settings.maxImportRows < 1 ||
      settings.maxImportRows > ABSOLUTE_MAX_IMPORT_ROWS
    ) {
      issues.push({
        field: 'maxImportRows',
        message: `Must be between 1 and ${ABSOLUTE_MAX_IMPORT_ROWS}.`,
      });
    }
  }

  if (settings.maxFileSizeBytes !== undefined) {
    if (
      !Number.isInteger(settings.maxFileSizeBytes) ||
      settings.maxFileSizeBytes < 1024 ||
      settings.maxFileSizeBytes > ABSOLUTE_MAX_FILE_SIZE_BYTES
    ) {
      issues.push({
        field: 'maxFileSizeBytes',
        message: `Must be between 1 KB and ${ABSOLUTE_MAX_FILE_SIZE_BYTES / (1024 * 1024)} MB.`,
      });
    }
  }

  const lease = settings.claimLeaseSeconds;
  const heartbeat = settings.heartbeatSeconds;
  if (lease !== undefined && (!Number.isInteger(lease) || lease < 60 || lease > 24 * 3600)) {
    issues.push({
      field: 'claimLeaseSeconds',
      message: 'Claim lease must be between 60 seconds and 24 hours.',
    });
  }
  if (heartbeat !== undefined && (!Number.isInteger(heartbeat) || heartbeat < 5)) {
    issues.push({ field: 'heartbeatSeconds', message: 'Heartbeat must be at least 5 seconds.' });
  }
  if (lease !== undefined && heartbeat !== undefined) {
    // Section 28.4: heartbeat must be meaningfully shorter than the lease.
    if (heartbeat * 3 > lease) {
      issues.push({
        field: 'heartbeatSeconds',
        message: `Heartbeat must be at most ${Math.floor(lease / 3)}s for a ${lease}s lease.`,
      });
    }
  }

  return issues;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Settings a counter is allowed to read (section 4.5 forbids integration detail). */
export function publicSettings(settings: AppSettings): Omit<
  AppSettings,
  'defaultLocationId' | 'defaultWarehouseId'
> & { defaultLocationId: null; defaultWarehouseId: null } {
  return {
    ...settings,
    defaultLocationId: null,
    defaultWarehouseId: null,
  };
}
