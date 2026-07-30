/**
 * Stock Recheck repository — specification sections 18, 19, 25, 26.
 */

import type { RecheckStatus } from '../../../src/domain/status';
import type { ImportSourceType } from '../../../src/domain/failureCodes';
import type { StockBasis, StockBasisType } from '../../../src/domain/stockBasis';
import { formatRecheckNumber } from '../../../src/domain/recheckNumber';
import {
  query,
  queryMany,
  queryOne,
  withTransaction,
  type TransactionClient,
} from '../database/client';

export interface RecheckRow {
  id: string;
  recheck_number: string;
  name: string;
  business_date: string;
  status: RecheckStatus;
  import_batch_id: string | null;
  import_source_type: ImportSourceType | null;
  zoho_organization_id: string | null;
  zoho_organization_name: string | null;
  stock_basis_type: StockBasisType;
  stock_location_id: string | null;
  stock_location_name: string | null;
  stock_warehouse_id: string | null;
  stock_warehouse_name: string | null;
  zoho_snapshot_at: string;
  total_items: number;
  available_items: number;
  in_progress_items: number;
  submitted_items: number;
  matched_items: number;
  mismatched_items: number;
  created_by: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  version: number;
}

export interface RecheckWithNames extends RecheckRow {
  created_by_name: string | null;
  cancelled_by_name: string | null;
}

const RECHECK_SELECT = `
  SELECT r.*, creator.display_name AS created_by_name,
         canceller.display_name AS cancelled_by_name
    FROM stock_rechecks r
    LEFT JOIN profiles creator   ON creator.id   = r.created_by
    LEFT JOIN profiles canceller ON canceller.id = r.cancelled_by
`;

export async function findRecheckById(id: string): Promise<RecheckWithNames | null> {
  return queryOne<RecheckWithNames>(`${RECHECK_SELECT} WHERE r.id = $1`, [id]);
}

/**
 * Allocates the next per-day sequence and formats the identifier.
 *
 * Runs inside the creating transaction and takes a transaction-scoped advisory
 * lock keyed on the business date, so two administrators creating rechecks on
 * the same day cannot be assigned the same sequence. The unique constraint on
 * `recheck_number` is the final backstop.
 */
export async function allocateRecheckNumber(
  client: TransactionClient,
  businessDate: string,
  prefix: string,
): Promise<{ recheckNumber: string; sequence: number }> {
  // hashtext() maps the date to a stable 32-bit key for the advisory lock.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`recheck:${businessDate}`]);

  const result = await client.queryOne<{ next_sequence: number }>(
    `SELECT COUNT(*)::int + 1 AS next_sequence
       FROM stock_rechecks
      WHERE business_date = $1::date`,
    [businessDate],
  );

  const sequence = result?.next_sequence ?? 1;
  return { recheckNumber: formatRecheckNumber(businessDate, sequence, prefix), sequence };
}

export interface CreateRecheckInput {
  recheckNumber: string;
  name: string;
  businessDate: string;
  importBatchId: string;
  importSourceType: ImportSourceType;
  zohoOrganizationId: string | null;
  zohoOrganizationName: string | null;
  stockBasis: StockBasis;
  zohoSnapshotAt: string;
  createdBy: string;
}

export async function insertRecheck(
  client: TransactionClient,
  input: CreateRecheckInput,
): Promise<RecheckRow> {
  const row = await client.queryOne<RecheckRow>(
    `INSERT INTO stock_rechecks (
       recheck_number, name, business_date, status,
       import_batch_id, import_source_type,
       zoho_organization_id, zoho_organization_name,
       stock_basis_type, stock_location_id, stock_location_name,
       stock_warehouse_id, stock_warehouse_name,
       zoho_snapshot_at, created_by
     ) VALUES ($1, $2, $3::date, 'ready', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      input.recheckNumber,
      input.name,
      input.businessDate,
      input.importBatchId,
      input.importSourceType,
      input.zohoOrganizationId,
      input.zohoOrganizationName,
      input.stockBasis.type,
      input.stockBasis.locationId,
      input.stockBasis.locationName,
      input.stockBasis.warehouseId,
      input.stockBasis.warehouseName,
      input.zohoSnapshotAt,
      input.createdBy,
    ],
  );
  if (row === null) throw new Error('Stock Recheck insert returned no row');
  return row;
}

export interface RecheckListFilters {
  statuses?: RecheckStatus[];
  fromDate?: string;
  toDate?: string;
  createdBy?: string;
  stockBasisType?: StockBasisType;
  hasMismatch?: boolean;
  recheckNumber?: string;
  name?: string;
  limit: number;
  offset: number;
}

export async function listRechecks(
  filters: RecheckListFilters,
): Promise<{ rechecks: RecheckWithNames[]; total: number }> {
  const conditions: string[] = ['TRUE'];
  const values: unknown[] = [];

  const add = (sql: string, value: unknown): void => {
    values.push(value);
    conditions.push(sql.replace('$?', `$${values.length}`));
  };

  if (filters.statuses !== undefined && filters.statuses.length > 0) {
    add('r.status = ANY($?::recheck_status[])', filters.statuses);
  }
  if (filters.fromDate !== undefined) add('r.business_date >= $?::date', filters.fromDate);
  if (filters.toDate !== undefined) add('r.business_date <= $?::date', filters.toDate);
  if (filters.createdBy !== undefined) add('r.created_by = $?', filters.createdBy);
  if (filters.stockBasisType !== undefined) add('r.stock_basis_type = $?', filters.stockBasisType);
  if (filters.hasMismatch === true) conditions.push('r.mismatched_items > 0');
  if (filters.hasMismatch === false) conditions.push('r.mismatched_items = 0');
  if (filters.recheckNumber !== undefined) {
    add('r.recheck_number ILIKE $?', `%${filters.recheckNumber}%`);
  }
  if (filters.name !== undefined) add('r.name ILIKE $?', `%${filters.name}%`);

  const whereClause = conditions.join(' AND ');

  const countRow = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM stock_rechecks r WHERE ${whereClause}`,
    values,
  );

  values.push(filters.limit, filters.offset);
  const rechecks = await queryMany<RecheckWithNames>(
    `${RECHECK_SELECT} WHERE ${whereClause}
      ORDER BY r.business_date DESC, r.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return { rechecks, total: countRow?.total ?? 0 };
}

/** Active rechecks for the dashboard. */
export async function listActiveRechecks(limit = 20): Promise<RecheckWithNames[]> {
  return queryMany<RecheckWithNames>(
    `${RECHECK_SELECT}
      WHERE r.status IN ('ready', 'in_progress')
      ORDER BY r.business_date DESC, r.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

/** A claim that cancellation returned to the pool. */
export interface ReleasedClaim {
  id: string;
  sku: string;
  previous_owner: string | null;
}

/**
 * Cancels a recheck — section 19.
 * Submitted historical data is never deleted; only the status changes.
 */
export async function cancelRecheck(params: {
  recheckId: string;
  actorId: string;
  reason: string;
}): Promise<{ recheck: RecheckRow; releasedClaims: ReleasedClaim[] } | null> {
  return withTransaction(async (client) => {
    const recheck = await client.queryOne<RecheckRow>(
      `UPDATE stock_rechecks
          SET status = 'cancelled',
              cancelled_at = NOW(),
              cancelled_by = $2,
              cancellation_reason = $3,
              version = version + 1
        WHERE id = $1
          AND status NOT IN ('completed', 'cancelled')
        RETURNING *`,
      [params.recheckId, params.actorId, params.reason],
    );
    if (recheck === null) return null;

    /*
     * Release every claim still open on the cancelled recheck.
     *
     * A cancelled recheck can never be counted again, so leaving rows in
     * `counting_in_progress` left them reading "You are counting" forever —
     * an invitation to carry on with work that can no longer be submitted.
     * The lease would eventually expire, but only after the full lease window
     * and only if a sweep happened to run.
     *
     * Submitted rows are untouched: their counted quantity, submitter and
     * result are permanent (section 2.2), and section 19 requires cancellation
     * to preserve them.
     */
    /*
     * The previous owner is captured in a CTE before the write. `RETURNING`
     * reports the NEW row, where `claimed_by` is already NULL, so it cannot
     * name who held the claim — and the audit entry needs exactly that.
     */
    const released = await client.query<ReleasedClaim>(
      `WITH target AS (
         SELECT id, sku, claimed_by AS previous_owner
           FROM stock_recheck_items
          WHERE stock_recheck_id = $1
            AND workflow_status = 'counting_in_progress'
          FOR UPDATE
       ), released AS (
         UPDATE stock_recheck_items i
            SET workflow_status  = 'available',
                claimed_by       = NULL,
                claimed_at       = NULL,
                claim_expires_at = NULL,
                row_version      = i.row_version + 1
           FROM target t
          WHERE i.id = t.id
         RETURNING i.id
       )
       SELECT t.id, t.sku, t.previous_owner FROM target t`,
      [params.recheckId],
    );

    // Counters must follow: those items are Available now, not counting.
    await client.query(
      `UPDATE stock_rechecks r
          SET available_items = (
                SELECT COUNT(*)::int FROM stock_recheck_items i
                 WHERE i.stock_recheck_id = r.id AND i.workflow_status = 'available'),
              in_progress_items = (
                SELECT COUNT(*)::int FROM stock_recheck_items i
                 WHERE i.stock_recheck_id = r.id AND i.workflow_status = 'counting_in_progress')
        WHERE r.id = $1`,
      [params.recheckId],
    );

    return { recheck, releasedClaims: released.rows };
  });
}

/** Aggregates for the summary screen — section 25. */
export interface SummaryTotals {
  total_items: number;
  submitted_items: number;
  remaining_items: number;
  in_progress_items: number;
  matched_items: number;
  mismatched_items: number;
  total_positive_difference: number;
  total_negative_difference: number;
}

export async function getSummaryTotals(recheckId: string): Promise<SummaryTotals> {
  const row = await queryOne<SummaryTotals>(
    `SELECT COUNT(*)::int                                                         AS total_items,
            COUNT(*) FILTER (WHERE workflow_status = 'submitted')::int            AS submitted_items,
            COUNT(*) FILTER (WHERE workflow_status <> 'submitted')::int           AS remaining_items,
            COUNT(*) FILTER (WHERE workflow_status = 'counting_in_progress')::int AS in_progress_items,
            COUNT(*) FILTER (WHERE result_status = 'matched')::int                AS matched_items,
            COUNT(*) FILTER (WHERE result_status = 'mismatched')::int             AS mismatched_items,
            COALESCE(SUM(quantity_difference) FILTER (WHERE quantity_difference > 0), 0)
              AS total_positive_difference,
            COALESCE(SUM(quantity_difference) FILTER (WHERE quantity_difference < 0), 0)
              AS total_negative_difference
       FROM stock_recheck_items
      WHERE stock_recheck_id = $1`,
    [recheckId],
  );

  return (
    row ?? {
      total_items: 0,
      submitted_items: 0,
      remaining_items: 0,
      in_progress_items: 0,
      matched_items: 0,
      mismatched_items: 0,
      total_positive_difference: 0,
      total_negative_difference: 0,
    }
  );
}

/** Dashboard counters — section 10. */
export async function getDashboardCounts(params: {
  userId: string;
  timezone: string;
}): Promise<{
  activeRechecks: number;
  itemsAvailable: number;
  itemsCountingInProgress: number;
  itemsSubmittedToday: number;
  mismatchedItemsToday: number;
  completedRechecksToday: number;
  myAvailableItems: number;
  mySubmittedItemsToday: number;
}> {
  const row = await queryOne<{
    active_rechecks: number;
    items_available: number;
    items_in_progress: number;
    items_submitted_today: number;
    mismatched_items_today: number;
    completed_rechecks_today: number;
    my_submitted_items_today: number;
  }>(
    `WITH active AS (
       SELECT id FROM stock_rechecks WHERE status IN ('ready', 'in_progress')
     )
     SELECT
       (SELECT COUNT(*)::int FROM active) AS active_rechecks,
       (SELECT COUNT(*)::int FROM stock_recheck_items
         WHERE stock_recheck_id IN (SELECT id FROM active)
           AND workflow_status = 'available') AS items_available,
       (SELECT COUNT(*)::int FROM stock_recheck_items
         WHERE stock_recheck_id IN (SELECT id FROM active)
           AND workflow_status = 'counting_in_progress') AS items_in_progress,
       (SELECT COUNT(*)::int FROM stock_recheck_items
         WHERE submitted_at IS NOT NULL
           AND (submitted_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date)
         AS items_submitted_today,
       (SELECT COUNT(*)::int FROM stock_recheck_items
         WHERE result_status = 'mismatched'
           AND submitted_at IS NOT NULL
           AND (submitted_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date)
         AS mismatched_items_today,
       (SELECT COUNT(*)::int FROM stock_rechecks
         WHERE status = 'completed'
           AND completed_at IS NOT NULL
           AND (completed_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date)
         AS completed_rechecks_today,
       (SELECT COUNT(*)::int FROM stock_recheck_items
         WHERE submitted_by = $1
           AND submitted_at IS NOT NULL
           AND (submitted_at AT TIME ZONE $2)::date = (NOW() AT TIME ZONE $2)::date)
         AS my_submitted_items_today`,
    [params.userId, params.timezone],
  );

  return {
    activeRechecks: row?.active_rechecks ?? 0,
    itemsAvailable: row?.items_available ?? 0,
    itemsCountingInProgress: row?.items_in_progress ?? 0,
    itemsSubmittedToday: row?.items_submitted_today ?? 0,
    mismatchedItemsToday: row?.mismatched_items_today ?? 0,
    completedRechecksToday: row?.completed_rechecks_today ?? 0,
    myAvailableItems: row?.items_available ?? 0,
    mySubmittedItemsToday: row?.my_submitted_items_today ?? 0,
  };
}

/** Marks the import batch consumed so it cannot create a second recheck. */
export async function markImportConsumed(
  client: TransactionClient,
  importBatchId: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE import_batches SET status = 'consumed'
      WHERE id = $1 AND status = 'validated'`,
    [importBatchId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function pruneExpiredCache(): Promise<void> {
  await query('DELETE FROM zoho_item_cache WHERE expires_at < NOW()');
}
