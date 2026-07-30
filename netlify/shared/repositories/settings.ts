/**
 * Settings repository — specification section 28.
 * Maps the single `app_settings` row to the shared `AppSettings` domain type.
 */

import { DEFAULT_SETTINGS, type AppSettings } from '../../../src/domain/settings';
import type { StockBasis, StockBasisType } from '../../../src/domain/stockBasis';
import { query, queryOne, type TransactionClient } from '../database/client';

interface SettingsRow {
  business_name: string;
  business_timezone: string;
  date_format: string;
  recheck_prefix: string;
  sku_case_sensitive: boolean;
  default_sort: string;
  default_stock_basis_type: StockBasisType;
  default_location_id: string | null;
  default_location_name: string | null;
  default_warehouse_id: string | null;
  default_warehouse_name: string | null;
  claim_lease_seconds: number;
  heartbeat_seconds: number;
  stale_claim_grace_seconds: number;
  counters_may_release_own: boolean;
  admins_may_force_release: boolean;
  blind_count_enabled: boolean;
  scanner_sound_enabled: boolean;
  scanner_success_sound: boolean;
  scanner_error_sound: boolean;
  scanner_success_flash: boolean;
  scanner_error_flash: boolean;
  scanner_require_enter: boolean;
  scanner_auto_select_invalid: boolean;
  scanner_prevent_sleep: boolean;
  max_import_rows: number;
  max_file_size_bytes: number;
}

const SELECT_SQL = `
  SELECT business_name, business_timezone, date_format, recheck_prefix,
         sku_case_sensitive, default_sort,
         default_stock_basis_type, default_location_id, default_location_name,
         default_warehouse_id, default_warehouse_name,
         claim_lease_seconds, heartbeat_seconds, stale_claim_grace_seconds,
         counters_may_release_own, admins_may_force_release,
         blind_count_enabled, scanner_sound_enabled,
         scanner_success_sound, scanner_error_sound,
         scanner_success_flash, scanner_error_flash,
         scanner_require_enter, scanner_auto_select_invalid, scanner_prevent_sleep,
         max_import_rows, max_file_size_bytes
    FROM app_settings
   WHERE singleton
   LIMIT 1
`;

function mapRow(row: SettingsRow): AppSettings {
  return {
    businessName: row.business_name,
    businessTimezone: row.business_timezone,
    dateFormat: row.date_format,
    recheckPrefix: row.recheck_prefix,
    maxImportRows: row.max_import_rows,
    maxFileSizeBytes: Number(row.max_file_size_bytes),
    skuCaseSensitive: row.sku_case_sensitive,
    defaultSort: row.default_sort,
    scannerSoundEnabled: row.scanner_sound_enabled,

    defaultStockBasisType: row.default_stock_basis_type,
    defaultLocationId: row.default_location_id,
    defaultLocationName: row.default_location_name,
    defaultWarehouseId: row.default_warehouse_id,
    defaultWarehouseName: row.default_warehouse_name,

    claimLeaseSeconds: row.claim_lease_seconds,
    heartbeatSeconds: row.heartbeat_seconds,
    staleClaimGraceSeconds: row.stale_claim_grace_seconds,
    countersMayReleaseOwnClaims: row.counters_may_release_own,
    adminsMayForceRelease: row.admins_may_force_release,

    blindCountEnabled: row.blind_count_enabled,
    scannerSuccessSound: row.scanner_success_sound,
    scannerErrorSound: row.scanner_error_sound,
    scannerSuccessFlash: row.scanner_success_flash,
    scannerErrorFlash: row.scanner_error_flash,
    scannerRequireEnter: row.scanner_require_enter,
    scannerAutoSelectInvalid: row.scanner_auto_select_invalid,
    scannerPreventSleep: row.scanner_prevent_sleep,
  };
}

/**
 * Reads settings. Falls back to the documented defaults if the singleton row
 * is somehow missing, so a settings problem never blocks counting work.
 */
export async function getSettings(): Promise<AppSettings> {
  const row = await queryOne<SettingsRow>(SELECT_SQL);
  return row === null ? { ...DEFAULT_SETTINGS } : mapRow(row);
}

export async function getSettingsInTransaction(client: TransactionClient): Promise<AppSettings> {
  const row = await client.queryOne<SettingsRow>(SELECT_SQL);
  return row === null ? { ...DEFAULT_SETTINGS } : mapRow(row);
}

/** The default stock basis applied to NEWLY created rechecks (section 28.3). */
export function defaultStockBasis(settings: AppSettings): StockBasis {
  return {
    type: settings.defaultStockBasisType,
    locationId: settings.defaultLocationId,
    locationName: settings.defaultLocationName,
    warehouseId: settings.defaultWarehouseId,
    warehouseName: settings.defaultWarehouseName,
  };
}

/** Maps camelCase domain keys to their database columns for partial updates. */
const COLUMN_BY_FIELD: Partial<Record<keyof AppSettings, string>> = {
  businessName: 'business_name',
  businessTimezone: 'business_timezone',
  dateFormat: 'date_format',
  recheckPrefix: 'recheck_prefix',
  maxImportRows: 'max_import_rows',
  maxFileSizeBytes: 'max_file_size_bytes',
  skuCaseSensitive: 'sku_case_sensitive',
  defaultSort: 'default_sort',
  scannerSoundEnabled: 'scanner_sound_enabled',
  defaultStockBasisType: 'default_stock_basis_type',
  defaultLocationId: 'default_location_id',
  defaultLocationName: 'default_location_name',
  defaultWarehouseId: 'default_warehouse_id',
  defaultWarehouseName: 'default_warehouse_name',
  claimLeaseSeconds: 'claim_lease_seconds',
  heartbeatSeconds: 'heartbeat_seconds',
  staleClaimGraceSeconds: 'stale_claim_grace_seconds',
  countersMayReleaseOwnClaims: 'counters_may_release_own',
  adminsMayForceRelease: 'admins_may_force_release',
  blindCountEnabled: 'blind_count_enabled',
  scannerSuccessSound: 'scanner_success_sound',
  scannerErrorSound: 'scanner_error_sound',
  scannerSuccessFlash: 'scanner_success_flash',
  scannerErrorFlash: 'scanner_error_flash',
  scannerRequireEnter: 'scanner_require_enter',
  scannerAutoSelectInvalid: 'scanner_auto_select_invalid',
  scannerPreventSleep: 'scanner_prevent_sleep',
};

/**
 * Applies a partial settings update.
 *
 * Column names come from the fixed allow-list above — never from caller input —
 * so this cannot become a SQL-injection vector. Values are parameterized.
 */
export async function updateSettings(
  patch: Partial<AppSettings>,
  updatedBy: string,
): Promise<AppSettings> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [field, value] of Object.entries(patch)) {
    const column = COLUMN_BY_FIELD[field as keyof AppSettings];
    if (column === undefined) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  if (assignments.length === 0) return getSettings();

  values.push(updatedBy);
  assignments.push(`updated_by = $${values.length}`);

  await query(`UPDATE app_settings SET ${assignments.join(', ')} WHERE singleton`, values);
  return getSettings();
}
