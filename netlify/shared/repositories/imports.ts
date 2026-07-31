/**
 * Import batch / row repository — specification sections 12-17, 30.4-30.5.
 */

import type {
  ImportBatchStatus,
  ImportRowStatus,
  ImportSourceType,
} from '../../../src/domain/failureCodes';
import type { StockBasis, StockBasisType } from '../../../src/domain/stockBasis';
import { query, queryMany, queryOne, type TransactionClient } from '../database/client';

export interface ImportBatchRow {
  id: string;
  source_type: ImportSourceType;
  source_file_name: string | null;
  worksheet_name: string | null;
  mapped_sku_column: string | null;
  header_row_number: number | null;
  status: ImportBatchStatus;
  total_source_rows: number;
  passed_rows: number;
  failed_rows: number;
  duplicate_rows: number;
  ignored_blank_rows: number;
  stock_basis_type: StockBasisType | null;
  stock_location_id: string | null;
  stock_location_name: string | null;
  stock_warehouse_id: string | null;
  stock_warehouse_name: string | null;
  zoho_organization_id: string | null;
  zoho_organization_name: string | null;
  created_by: string;
  created_at: string;
  validation_started_at: string | null;
  validation_finished_at: string | null;
}

export interface ImportRowRecord {
  id: string;
  import_batch_id: string;
  source_row_number: number;
  raw_sku: string;
  display_sku: string;
  normalized_sku: string;
  validation_status: ImportRowStatus;
  failure_code: string | null;
  failure_reason: string | null;
  duplicate_of_row_number: number | null;
  zoho_item_id: string | null;
  resolved_snapshot_json: ResolvedSnapshot | null;
}

/** The immutable Zoho snapshot captured for a passed row — section 2.6. */
export interface ResolvedSnapshot {
  zohoItemId: string;
  itemName: string;
  sku: string;
  normalizedSku: string;
  stockInHand: number;
  vendorName: string | null;
  unit: string | null;
  organizationId: string | null;
  organizationName: string | null;
  stockBasisType: StockBasisType;
  stockLocationId: string | null;
  stockLocationName: string | null;
  stockWarehouseId: string | null;
  stockWarehouseName: string | null;
  snapshotAt: string;
}

export async function createImportBatch(input: {
  sourceType: ImportSourceType;
  sourceFileName: string | null;
  worksheetName: string | null;
  mappedSkuColumn: string | null;
  headerRowNumber: number | null;
  createdBy: string;
}): Promise<ImportBatchRow> {
  const row = await queryOne<ImportBatchRow>(
    `INSERT INTO import_batches (
       source_type, source_file_name, worksheet_name,
       mapped_sku_column, header_row_number, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.sourceType,
      input.sourceFileName,
      input.worksheetName,
      input.mappedSkuColumn,
      input.headerRowNumber,
      input.createdBy,
    ],
  );
  if (row === null) throw new Error('Import batch insert returned no row');
  return row;
}

export async function findImportBatch(
  id: string,
  createdBy?: string,
): Promise<ImportBatchRow | null> {
  if (createdBy === undefined) {
    return queryOne<ImportBatchRow>('SELECT * FROM import_batches WHERE id = $1', [id]);
  }
  return queryOne<ImportBatchRow>(
    'SELECT * FROM import_batches WHERE id = $1 AND created_by = $2',
    [id, createdBy],
  );
}

/**
 * Bulk-inserts the parsed source rows.
 *
 * Uses `UNNEST` so all rows go in one round trip regardless of count — a
 * 20,000-row import must not become 20,000 statements (section 40).
 */
export async function insertImportRows(
  batchId: string,
  rows: readonly {
    sourceRowNumber: number;
    rawSku: string;
    displaySku: string;
    normalizedSku: string;
  }[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const result = await query(
    `INSERT INTO import_rows
       (import_batch_id, source_row_number, raw_sku, display_sku, normalized_sku)
     SELECT $1, * FROM UNNEST($2::int[], $3::text[], $4::text[], $5::text[])
     ON CONFLICT (import_batch_id, source_row_number) DO NOTHING`,
    [
      batchId,
      rows.map((row) => row.sourceRowNumber),
      rows.map((row) => row.rawSku),
      rows.map((row) => row.displaySku),
      rows.map((row) => row.normalizedSku),
    ],
  );
  return result.rowCount ?? 0;
}

export async function listImportRows(
  batchId: string,
  status?: ImportRowStatus,
): Promise<ImportRowRecord[]> {
  if (status === undefined) {
    return queryMany<ImportRowRecord>(
      'SELECT * FROM import_rows WHERE import_batch_id = $1 ORDER BY source_row_number',
      [batchId],
    );
  }
  return queryMany<ImportRowRecord>(
    `SELECT * FROM import_rows
      WHERE import_batch_id = $1 AND validation_status = $2
      ORDER BY source_row_number`,
    [batchId, status],
  );
}

/** Distinct non-blank SKUs awaiting validation, with their first row number. */
export async function listUniqueSkusToValidate(
  batchId: string,
): Promise<{ normalized_sku: string; first_row: number; display_sku: string }[]> {
  return queryMany(
    `SELECT normalized_sku,
            MIN(source_row_number)::int AS first_row,
            (ARRAY_AGG(display_sku ORDER BY source_row_number))[1] AS display_sku
       FROM import_rows
      WHERE import_batch_id = $1 AND normalized_sku <> ''
      GROUP BY normalized_sku
      ORDER BY first_row`,
    [batchId],
  );
}

export interface RowOutcome {
  sourceRowNumber: number;
  status: ImportRowStatus;
  failureCode: string | null;
  failureReason: string | null;
  duplicateOfRowNumber: number | null;
  zohoItemId: string | null;
  snapshot: ResolvedSnapshot | null;
}

/** Applies validation outcomes in a single statement via UNNEST. */
export async function applyRowOutcomes(
  client: TransactionClient,
  batchId: string,
  outcomes: readonly RowOutcome[],
): Promise<void> {
  if (outcomes.length === 0) return;

  await client.query(
    `UPDATE import_rows r
        SET validation_status       = u.status::import_row_status,
            failure_code            = u.failure_code,
            failure_reason          = u.failure_reason,
            duplicate_of_row_number = u.duplicate_of_row_number,
            zoho_item_id            = u.zoho_item_id,
            resolved_snapshot_json  = u.snapshot
       FROM UNNEST(
              $2::int[], $3::text[], $4::text[], $5::text[],
              $6::int[], $7::text[], $8::jsonb[]
            ) AS u(source_row_number, status, failure_code, failure_reason,
                   duplicate_of_row_number, zoho_item_id, snapshot)
      WHERE r.import_batch_id = $1
        AND r.source_row_number = u.source_row_number`,
    [
      batchId,
      outcomes.map((outcome) => outcome.sourceRowNumber),
      outcomes.map((outcome) => outcome.status),
      outcomes.map((outcome) => outcome.failureCode),
      outcomes.map((outcome) => outcome.failureReason),
      outcomes.map((outcome) => outcome.duplicateOfRowNumber),
      outcomes.map((outcome) => outcome.zohoItemId),
      outcomes.map((outcome) =>
        outcome.snapshot === null ? null : JSON.stringify(outcome.snapshot),
      ),
    ],
  );
}

export async function setBatchStatus(
  batchId: string,
  status: ImportBatchStatus,
  timestamps: { started?: boolean; finished?: boolean } = {},
): Promise<void> {
  const assignments = ['status = $2'];
  if (timestamps.started === true) assignments.push('validation_started_at = NOW()');
  if (timestamps.finished === true) assignments.push('validation_finished_at = NOW()');

  await query(`UPDATE import_batches SET ${assignments.join(', ')} WHERE id = $1`, [
    batchId,
    status,
  ]);
}

/** Recomputes the summary counters from the rows themselves. */
export async function refreshBatchCounters(
  client: TransactionClient,
  batchId: string,
): Promise<void> {
  await client.query(
    `UPDATE import_batches b
        SET total_source_rows  = c.total,
            passed_rows        = c.passed,
            failed_rows        = c.failed,
            duplicate_rows     = c.duplicates,
            ignored_blank_rows = c.blanks
       FROM (
         SELECT COUNT(*)::int                                                        AS total,
                COUNT(*) FILTER (WHERE validation_status = 'passed')::int            AS passed,
                COUNT(*) FILTER (WHERE validation_status = 'failed')::int            AS failed,
                COUNT(*) FILTER (WHERE failure_code = 'DUPLICATE_IN_IMPORT')::int    AS duplicates,
                COUNT(*) FILTER (WHERE validation_status = 'ignored_blank')::int     AS blanks
           FROM import_rows WHERE import_batch_id = $1
       ) c
      WHERE b.id = $1`,
    [batchId],
  );
}

/** Records the stock basis used for the validation run. */
export async function setBatchStockBasis(
  batchId: string,
  basis: StockBasis,
  organization: { id: string | null; name: string | null },
): Promise<void> {
  await query(
    `UPDATE import_batches
        SET stock_basis_type = $2, stock_location_id = $3, stock_location_name = $4,
            stock_warehouse_id = $5, stock_warehouse_name = $6,
            zoho_organization_id = $7, zoho_organization_name = $8
      WHERE id = $1`,
    [
      batchId,
      basis.type,
      basis.locationId,
      basis.locationName,
      basis.warehouseId,
      basis.warehouseName,
      organization.id,
      organization.name,
    ],
  );
}

/**
 * Creates one item per passed row — section 18.
 *
 * `ON CONFLICT DO NOTHING` on (recheck, normalized_sku) is a belt-and-braces
 * guard: the validator already collapses duplicates, but the unique index is
 * the real invariant (section 3.2).
 */
export async function createItemsFromPassedRows(
  client: TransactionClient,
  params: { recheckId: string; importBatchId: string },
): Promise<number> {
  const result = await client.query(
    `INSERT INTO stock_recheck_items (
       stock_recheck_id, zoho_item_id, item_name, sku, normalized_sku,
       zoho_stock_quantity, vendor_name, unit,
       zoho_snapshot_json
     )
     SELECT $1,
            r.zoho_item_id,
            r.resolved_snapshot_json ->> 'itemName',
            r.resolved_snapshot_json ->> 'sku',
            r.resolved_snapshot_json ->> 'normalizedSku',
            (r.resolved_snapshot_json ->> 'stockInHand')::numeric,
            r.resolved_snapshot_json ->> 'vendorName',
            r.resolved_snapshot_json ->> 'unit',
            r.resolved_snapshot_json
       FROM import_rows r
      WHERE r.import_batch_id = $2
        AND r.validation_status = 'passed'
        AND r.resolved_snapshot_json IS NOT NULL
      ON CONFLICT (stock_recheck_id, normalized_sku) DO NOTHING`,
    [params.recheckId, params.importBatchId],
  );
  return result.rowCount ?? 0;
}

/** Rows eligible for a retry — only transient Zoho failures (section 17). */
export async function listRetryableRows(
  batchId: string,
  retryableCodes: readonly string[],
): Promise<ImportRowRecord[]> {
  return queryMany<ImportRowRecord>(
    `SELECT * FROM import_rows
      WHERE import_batch_id = $1
        AND validation_status = 'failed'
        AND failure_code = ANY($2::text[])
      ORDER BY source_row_number`,
    [batchId, retryableCodes],
  );
}
