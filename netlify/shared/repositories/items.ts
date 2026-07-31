/**
 * Stock Recheck items repository — specification sections 20, 21, 23, 39.
 *
 * ============================ CONCURRENCY NOTES ============================
 * This module owns every operation where two users can collide. The rules:
 *
 *  1. Claim ownership is decided by a CONDITIONAL UPDATE whose WHERE clause
 *     encodes the precondition. Postgres serializes concurrent updates to the
 *     same row, so exactly one caller can observe `rowCount === 1`. We never
 *     read-then-write, because that races.
 *
 *  2. `claim_version` increments on every successful claim. A local draft
 *     count carries the version it was written under, so a draft can never be
 *     submitted against a newer claim — even by the same user on the same item.
 *
 *  3. Submission runs inside a transaction with `SELECT ... FOR UPDATE`, so
 *     the validity checks and the write cannot be interleaved.
 *
 *  4. An expired lease makes an item reclaimable WITHOUT a background job:
 *     the claim query itself treats a stale claim as claimable.
 * ==========================================================================
 */

import {
  evaluateCount,
  type ItemWorkflowStatus,
  type ResultStatus,
} from '../../../src/domain';
import { deriveRecheckStatus } from '../../../src/domain/status';
import {
  ClaimExpiredError,
  ClaimNotOwnedError,
  ItemAlreadySubmittedError,
  NotFoundError,
} from '../errors';
import { query, queryMany, queryOne, withTransaction, type TransactionClient } from '../database/client';
import { recordAuditEventInTransaction } from '../audit';

/* ------------------------------------------------------------------ types */

export interface ItemRow {
  id: string;
  stock_recheck_id: string;
  zoho_item_id: string;
  item_name: string;
  sku: string;
  normalized_sku: string;
  zoho_stock_quantity: number;
  vendor_name: string | null;
  unit: string | null;
  workflow_status: ItemWorkflowStatus;
  result_status: ResultStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires_at: string | null;
  claim_version: number;
  counted_quantity: number | null;
  quantity_difference: number | null;
  submitted_by: string | null;
  submitted_at: string | null;
  created_at: string;
  updated_at: string;
  row_version: number;
}

export interface ItemWithNames extends ItemRow {
  claimed_by_name: string | null;
  submitted_by_name: string | null;
}

/** Single source for the item projection, used prefixed and unprefixed. */
const ITEM_COLUMN_NAMES = [
  'id',
  'stock_recheck_id',
  'zoho_item_id',
  'item_name',
  'sku',
  'normalized_sku',
  'zoho_stock_quantity',
  'vendor_name',
  'unit',
  'workflow_status',
  'result_status',
  'claimed_by',
  'claimed_at',
  'claim_expires_at',
  'claim_version',
  'counted_quantity',
  'quantity_difference',
  'submitted_by',
  'submitted_at',
  'created_at',
  'updated_at',
  'row_version',
] as const;

/** `i.id, i.stock_recheck_id, …` for queries that join `profiles`. */
const ITEM_COLUMNS = ITEM_COLUMN_NAMES.map((name) => `i.${name}`).join(', ');
/** `id, stock_recheck_id, …` for single-table queries. */
const ITEM_COLUMNS_BARE = ITEM_COLUMN_NAMES.join(', ');

/* ------------------------------------------------------------------ reads */

export async function findItemById(
  recheckId: string,
  itemId: string,
): Promise<ItemWithNames | null> {
  return queryOne<ItemWithNames>(
    `SELECT ${ITEM_COLUMNS},
            claimer.display_name  AS claimed_by_name,
            submitter.display_name AS submitted_by_name
       FROM stock_recheck_items i
       LEFT JOIN profiles claimer   ON claimer.id   = i.claimed_by
       LEFT JOIN profiles submitter ON submitter.id = i.submitted_by
      WHERE i.id = $1 AND i.stock_recheck_id = $2`,
    [itemId, recheckId],
  );
}

/**
 * Every item in a recheck, reduced to the fields the scanner needs.
 * Used by the counting screen to name a sibling item in a wrong-scan error
 * (section 3.3) without leaking counts or claim details.
 */
export async function listScannableItems(
  recheckId: string,
): Promise<{ id: string; item_name: string; sku: string; normalized_sku: string }[]> {
  return queryMany(
    `SELECT id, item_name, sku, normalized_sku
       FROM stock_recheck_items
      WHERE stock_recheck_id = $1`,
    [recheckId],
  );
}

export interface ItemListFilters {
  recheckId: string;
  search?: string;
  workflowStatus?: ItemWorkflowStatus;
  resultStatus?: ResultStatus;
  vendor?: string;
  claimedBy?: string;
  onlyMine?: string;
  sortKey?: string;
  sortDirection?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/** Whitelisted sort expressions — the key never reaches SQL as free text. */
const SORT_EXPRESSIONS: Record<string, string> = {
  item_name: 'i.item_name',
  sku: 'i.sku',
  zoho_stock: 'i.zoho_stock_quantity',
  status: 'i.workflow_status',
  claimed_at: 'i.claimed_at',
  submitted_at: 'i.submitted_at',
  quantity_difference: 'i.quantity_difference',
};

export async function listItems(
  filters: ItemListFilters,
): Promise<{ items: ItemWithNames[]; total: number }> {
  const conditions: string[] = ['i.stock_recheck_id = $1'];
  const values: unknown[] = [filters.recheckId];

  const addCondition = (sql: string, value: unknown): void => {
    values.push(value);
    conditions.push(sql.replace('$?', `$${values.length}`));
  };

  if (filters.search !== undefined && filters.search.trim() !== '') {
    // ILIKE across the searchable columns; the GIN index backs the common case.
    values.push(`%${filters.search.trim()}%`);
    const placeholder = `$${values.length}`;
    conditions.push(
      `(i.item_name ILIKE ${placeholder} OR i.sku ILIKE ${placeholder}
        OR i.vendor_name ILIKE ${placeholder})`,
    );
  }
  if (filters.workflowStatus !== undefined) {
    addCondition('i.workflow_status = $?', filters.workflowStatus);
  }
  if (filters.resultStatus !== undefined) addCondition('i.result_status = $?', filters.resultStatus);
  if (filters.vendor !== undefined) addCondition('i.vendor_name = $?', filters.vendor);
  if (filters.claimedBy !== undefined) addCondition('i.claimed_by = $?', filters.claimedBy);
  if (filters.onlyMine !== undefined) {
    values.push(filters.onlyMine);
    const placeholder = `$${values.length}`;
    conditions.push(`(i.claimed_by = ${placeholder} OR i.submitted_by = ${placeholder})`);
  }

  const whereClause = conditions.join(' AND ');
  const sortExpression = SORT_EXPRESSIONS[filters.sortKey ?? 'item_name'] ?? 'i.item_name';
  const direction = filters.sortDirection === 'desc' ? 'DESC' : 'ASC';

  const countResult = await queryOne<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM stock_recheck_items i WHERE ${whereClause}`,
    values,
  );

  values.push(filters.limit, filters.offset);
  const items = await queryMany<ItemWithNames>(
    `SELECT ${ITEM_COLUMNS},
            claimer.display_name   AS claimed_by_name,
            submitter.display_name AS submitted_by_name
       FROM stock_recheck_items i
       LEFT JOIN profiles claimer   ON claimer.id   = i.claimed_by
       LEFT JOIN profiles submitter ON submitter.id = i.submitted_by
      WHERE ${whereClause}
      ORDER BY ${sortExpression} ${direction} NULLS LAST, i.id ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return { items, total: countResult?.total ?? 0 };
}

/** Distinct values powering the workspace filter dropdowns. */
export async function listFilterFacets(recheckId: string): Promise<{
  vendors: string[];
  claimants: { id: string; name: string }[];
}> {
  const [vendors, claimants] = await Promise.all([
    queryMany<{ value: string }>(
      `SELECT DISTINCT vendor_name AS value FROM stock_recheck_items
        WHERE stock_recheck_id = $1 AND vendor_name IS NOT NULL ORDER BY value`,
      [recheckId],
    ),
    queryMany<{ id: string; name: string }>(
      `SELECT DISTINCT p.id, p.display_name AS name
         FROM stock_recheck_items i
         JOIN profiles p ON p.id = COALESCE(i.claimed_by, i.submitted_by)
        WHERE i.stock_recheck_id = $1
        ORDER BY name`,
      [recheckId],
    ),
  ]);

  return {
    vendors: vendors.map((row) => row.value),
    claimants,
  };
}

/* ------------------------------------------------------------- claiming -- */

export interface ClaimResult {
  item: ItemRow;
  claimVersion: number;
  claimExpiresAt: string;
}

/**
 * Atomically claims an item — section 20.
 *
 * The precondition lives entirely in the WHERE clause, so two simultaneous
 * callers cannot both succeed: Postgres applies the second update only after
 * the first commits, at which point the row no longer satisfies the predicate.
 *
 * A stale claim (lease elapsed plus the grace period) is treated as claimable,
 * which is what makes expired claims recoverable without a background worker.
 *
 * Returns null when the claim failed; the caller turns that into a 409.
 */
export async function claimItemAtomically(params: {
  recheckId: string;
  itemId: string;
  userId: string;
  leaseSeconds: number;
  graceSeconds: number;
}): Promise<ClaimResult | null> {
  const result = await query<ItemRow>(
    `UPDATE stock_recheck_items
        SET workflow_status  = 'counting_in_progress',
            claimed_by       = $3,
            claimed_at       = NOW(),
            claim_expires_at = NOW() + make_interval(secs => $4),
            claim_version    = claim_version + 1,
            row_version      = row_version + 1
      WHERE id = $1
        AND stock_recheck_id = $2
        AND submitted_at IS NULL
        AND (
              workflow_status = 'available'
              OR (
                   workflow_status = 'counting_in_progress'
                   AND claim_expires_at IS NOT NULL
                   AND claim_expires_at <= NOW() - make_interval(secs => $5)
                 )
            )
        AND EXISTS (
              SELECT 1 FROM stock_rechecks r
               WHERE r.id = $2 AND r.status IN ('ready', 'in_progress')
            )
      RETURNING id, stock_recheck_id, zoho_item_id, item_name, sku, normalized_sku,
                zoho_stock_quantity, vendor_name, unit,
                workflow_status, result_status,
                claimed_by, claimed_at, claim_expires_at, claim_version,
                counted_quantity, quantity_difference, submitted_by, submitted_at,
                created_at, updated_at, row_version`,
    [params.itemId, params.recheckId, params.userId, params.leaseSeconds, params.graceSeconds],
  );

  const item = result.rows[0];
  if (item === undefined) return null;

  return {
    item,
    claimVersion: item.claim_version,
    claimExpiresAt: item.claim_expires_at as string,
  };
}

/**
 * Extends the lease — section 20 "Claim lease".
 * Only the owner of a still-live claim can extend it; an already-expired claim
 * must be re-claimed rather than silently resurrected.
 */
export async function heartbeatClaim(params: {
  recheckId: string;
  itemId: string;
  userId: string;
  claimVersion: number;
  leaseSeconds: number;
}): Promise<{ claimExpiresAt: string; claimVersion: number } | null> {
  const result = await query<{ claim_expires_at: string; claim_version: number }>(
    `UPDATE stock_recheck_items
        SET claim_expires_at = NOW() + make_interval(secs => $5),
            row_version      = row_version + 1
      WHERE id = $1
        AND stock_recheck_id = $2
        AND claimed_by = $3
        AND claim_version = $4
        AND workflow_status = 'counting_in_progress'
        AND submitted_at IS NULL
        AND claim_expires_at > NOW()
      RETURNING claim_expires_at, claim_version`,
    [params.itemId, params.recheckId, params.userId, params.claimVersion, params.leaseSeconds],
  );

  const row = result.rows[0];
  return row === undefined
    ? null
    : { claimExpiresAt: row.claim_expires_at, claimVersion: row.claim_version };
}

/**
 * Releases a claim and returns the item to `available` — section 21.
 * `force` skips the ownership predicate and is reserved for administrators.
 */
export async function releaseClaim(params: {
  recheckId: string;
  itemId: string;
  userId: string;
  force: boolean;
}): Promise<{ previousOwnerId: string | null } | null> {
  const ownershipClause = params.force ? '' : 'AND claimed_by = $3';

  const result = await query<{ previous_owner: string | null }>(
    `WITH target AS (
       SELECT id, claimed_by AS previous_owner
         FROM stock_recheck_items
        WHERE id = $1
          AND stock_recheck_id = $2
          AND workflow_status = 'counting_in_progress'
          AND submitted_at IS NULL
          ${ownershipClause}
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
     SELECT t.previous_owner FROM target t`,
    params.force
      ? [params.itemId, params.recheckId]
      : [params.itemId, params.recheckId, params.userId],
  );

  const row = result.rows[0];
  return row === undefined ? null : { previousOwnerId: row.previous_owner };
}

/**
 * Sweeps claims whose lease elapsed — section 20 "Stale claim".
 *
 * Returns the affected rows so the caller can write `item.claim_expired` audit
 * events. `SKIP LOCKED` keeps concurrent sweepers from blocking each other.
 * The previous user's local count is never read or published.
 */
export async function expireStaleClaims(
  graceSeconds: number,
  limit = 500,
): Promise<{ id: string; stock_recheck_id: string; previous_owner: string | null }[]> {
  return queryMany<{ id: string; stock_recheck_id: string; previous_owner: string | null }>(
    `WITH stale AS (
       SELECT id, stock_recheck_id, claimed_by AS previous_owner
         FROM stock_recheck_items
        WHERE workflow_status = 'counting_in_progress'
          AND submitted_at IS NULL
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at <= NOW() - make_interval(secs => $1)
        ORDER BY claim_expires_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), expired AS (
       UPDATE stock_recheck_items i
          SET workflow_status  = 'available',
              claimed_by       = NULL,
              claimed_at       = NULL,
              claim_expires_at = NULL,
              row_version      = i.row_version + 1
         FROM stale s
        WHERE i.id = s.id
       RETURNING i.id
     )
     SELECT s.id, s.stock_recheck_id, s.previous_owner FROM stale s`,
    [graceSeconds, limit],
  );
}

/* ----------------------------------------------------------- submission -- */

export interface SubmitCountParams {
  recheckId: string;
  itemId: string;
  userId: string;
  userDisplayName: string;
  countedQuantity: number;
  claimVersion: number;
  correlationId: string;
  requestIp: string | null;
}

export interface SubmitCountResult {
  item: ItemRow;
  quantityDifference: number;
  resultStatus: ResultStatus;
  recheckCompleted: boolean;
}

/**
 * Records the final counted quantity — section 23.
 *
 * Runs the full check-then-write sequence inside one transaction with the row
 * locked, so nothing can change between validation and the update.
 */
export async function submitCount(params: SubmitCountParams): Promise<SubmitCountResult> {
  return withTransaction(async (client) => {
    // Lock the item for the duration of the transaction.
    const item = await client.queryOne<ItemRow>(
      `SELECT ${ITEM_COLUMNS_BARE}
         FROM stock_recheck_items
        WHERE id = $1 AND stock_recheck_id = $2
        FOR UPDATE`,
      [params.itemId, params.recheckId],
    );

    if (item === null) throw new NotFoundError('item');

    // 4. Confirm the item is not already submitted.
    if (item.workflow_status === 'submitted' || item.submitted_at !== null) {
      throw new ItemAlreadySubmittedError();
    }
    // 2. Confirm the user owns the active claim.
    if (item.claimed_by !== params.userId) {
      throw new ClaimNotOwnedError(
        'This item is no longer claimed by you. The local count cannot be submitted.',
      );
    }
    // The claim version pins the submission to the exact claim the count was
    // taken under (section 22).
    if (item.claim_version !== params.claimVersion) {
      throw new ClaimExpiredError();
    }
    // 3. Confirm the claim has not expired.
    const expiresAt = item.claim_expires_at === null ? null : new Date(item.claim_expires_at);
    if (expiresAt === null || expiresAt.getTime() <= Date.now()) {
      throw new ClaimExpiredError();
    }

    // 6-7. Difference and result come from the stored snapshot, never from a
    // fresh Zoho read (section 2.6).
    const { quantityDifference, resultStatus } = evaluateCount(
      params.countedQuantity,
      item.zoho_stock_quantity,
    );

    // 8-14. Persist the result and clear the claim fields.
    const updated = await client.queryOne<ItemRow>(
      `UPDATE stock_recheck_items
          SET counted_quantity     = $3,
              quantity_difference  = $4,
              result_status        = $5,
              workflow_status      = 'submitted',
              submitted_by         = $6,
              submitted_at         = NOW(),
              claimed_by           = NULL,
              claimed_at           = NULL,
              claim_expires_at     = NULL,
              row_version          = row_version + 1
        WHERE id = $1 AND stock_recheck_id = $2
        RETURNING ${ITEM_COLUMNS_BARE}`,
      [
        params.itemId,
        params.recheckId,
        params.countedQuantity,
        quantityDifference,
        resultStatus,
        params.userId,
      ],
    );

    if (updated === null) throw new NotFoundError('item');

    // Audit-grade history (section 39): supersede any previous attempt rather
    // than overwriting it.
    await client.query(
      `UPDATE count_submission_history
          SET is_current = FALSE
        WHERE stock_recheck_item_id = $1 AND is_current`,
      [params.itemId],
    );
    await client.query(
      `INSERT INTO count_submission_history (
         stock_recheck_item_id, attempt_number, counted_quantity, zoho_stock_quantity,
         quantity_difference, result_status, submitted_by, submitted_at, is_current
       )
       SELECT $1,
              COALESCE(MAX(attempt_number), 0) + 1,
              $2, $3, $4, $5, $6, NOW(), TRUE
         FROM count_submission_history
        WHERE stock_recheck_item_id = $1`,
      [
        params.itemId,
        params.countedQuantity,
        item.zoho_stock_quantity,
        quantityDifference,
        resultStatus,
        params.userId,
      ],
    );

    // 15. Audit event, in the same transaction as the state change.
    await recordAuditEventInTransaction(client, {
      eventType: 'item.count_submitted',
      actorUserId: params.userId,
      actorDisplayName: params.userDisplayName,
      stockRecheckId: params.recheckId,
      stockRecheckItemId: params.itemId,
      metadata: {
        countedQuantity: params.countedQuantity,
        zohoStockQuantity: item.zoho_stock_quantity,
        quantityDifference,
        resultStatus,
        sku: item.sku,
      },
      correlationId: params.correlationId,
      requestIp: params.requestIp,
    });

    // 16-17. Recalculate progress and complete the recheck if this was the last item.
    const progress = await recalculateRecheckProgress(client, params.recheckId);

    if (progress.becameCompleted) {
      await recordAuditEventInTransaction(client, {
        eventType: 'recheck.completed',
        actorUserId: params.userId,
        actorDisplayName: params.userDisplayName,
        stockRecheckId: params.recheckId,
        metadata: { totalItems: progress.counts.totalItems },
        correlationId: params.correlationId,
        requestIp: params.requestIp,
      });
    }

    return {
      item: updated,
      quantityDifference,
      resultStatus,
      recheckCompleted: progress.becameCompleted,
    };
  });
}

/* ----------------------------------------------------------- amend (s.39) */

/**
 * Corrects the counted quantity on an ALREADY-SUBMITTED item.
 *
 * The alternative — reopen, re-claim, recount, resubmit — is four steps for
 * what is usually a typo, and it briefly returns the item to the shared pool
 * where a colleague can take it.
 *
 * Business rules preserved exactly as for a first submission:
 *   - the difference is recomputed from the STORED Zoho snapshot, never a fresh
 *     read (section 2.6), so the basis of comparison cannot drift
 *   - the previous attempt stays in `count_submission_history`, superseded
 *     rather than overwritten (section 39)
 *   - Zoho is not touched in any way (section 2.1)
 */
export async function amendSubmittedCount(params: {
  recheckId: string;
  itemId: string;
  actorId: string;
  actorDisplayName: string;
  countedQuantity: number;
  reason: string;
  correlationId: string;
  requestIp: string | null;
}): Promise<{ item: ItemRow; quantityDifference: number; resultStatus: ResultStatus }> {
  return withTransaction(async (client) => {
    const item = await client.queryOne<ItemRow>(
      `SELECT ${ITEM_COLUMNS_BARE}
         FROM stock_recheck_items
        WHERE id = $1 AND stock_recheck_id = $2
        FOR UPDATE`,
      [params.itemId, params.recheckId],
    );
    if (item === null) throw new NotFoundError('item');
    if (item.workflow_status !== 'submitted' || item.submitted_at === null) {
      throw new ClaimNotOwnedError('Only a submitted item can have its count edited.');
    }

    const { quantityDifference, resultStatus } = evaluateCount(
      params.countedQuantity,
      item.zoho_stock_quantity,
    );

    const updated = await client.queryOne<ItemRow>(
      `UPDATE stock_recheck_items
          SET counted_quantity    = $3,
              quantity_difference = $4,
              result_status       = $5,
              submitted_by        = $6,
              submitted_at        = NOW(),
              row_version         = row_version + 1
        WHERE id = $1 AND stock_recheck_id = $2
        RETURNING ${ITEM_COLUMNS_BARE}`,
      [
        params.itemId,
        params.recheckId,
        params.countedQuantity,
        quantityDifference,
        resultStatus,
        params.actorId,
      ],
    );
    if (updated === null) throw new NotFoundError('item');

    await client.query(
      `UPDATE count_submission_history
          SET is_current = FALSE
        WHERE stock_recheck_item_id = $1 AND is_current`,
      [params.itemId],
    );
    await client.query(
      `INSERT INTO count_submission_history (
         stock_recheck_item_id, attempt_number, counted_quantity, zoho_stock_quantity,
         quantity_difference, result_status, submitted_by, submitted_at, is_current
       )
       SELECT $1,
              COALESCE(MAX(attempt_number), 0) + 1,
              $2, $3, $4, $5, $6, NOW(), TRUE
         FROM count_submission_history
        WHERE stock_recheck_item_id = $1`,
      [
        params.itemId,
        params.countedQuantity,
        item.zoho_stock_quantity,
        quantityDifference,
        resultStatus,
        params.actorId,
      ],
    );

    await recordAuditEventInTransaction(client, {
      eventType: 'item.count_amended',
      actorUserId: params.actorId,
      actorDisplayName: params.actorDisplayName,
      stockRecheckId: params.recheckId,
      stockRecheckItemId: params.itemId,
      metadata: {
        sku: item.sku,
        reason: params.reason,
        previousCountedQuantity: item.counted_quantity,
        countedQuantity: params.countedQuantity,
        previousQuantityDifference: item.quantity_difference,
        quantityDifference,
        zohoStockQuantity: item.zoho_stock_quantity,
        resultStatus,
      },
      correlationId: params.correlationId,
      requestIp: params.requestIp,
    });

    // Matched/mismatched tallies on the parent change even though the
    // submitted count does not.
    await recalculateRecheckProgress(client, params.recheckId);

    return { item: updated, quantityDifference, resultStatus };
  });
}

/* ---------------------------------------------------------- reopen (s.39) */

/**
 * Returns a submitted item to `available` for a recount — section 39.
 *
 * The previous submission is preserved in `count_submission_history` (it is
 * merely no longer current) and the reason is required. Zoho is never touched.
 */
export async function reopenItem(params: {
  recheckId: string;
  itemId: string;
  actorId: string;
  actorDisplayName: string;
  reason: string;
  correlationId: string;
  requestIp: string | null;
}): Promise<ItemRow> {
  return withTransaction(async (client) => {
    const item = await client.queryOne<ItemRow>(
      `SELECT ${ITEM_COLUMNS_BARE}
         FROM stock_recheck_items
        WHERE id = $1 AND stock_recheck_id = $2
        FOR UPDATE`,
      [params.itemId, params.recheckId],
    );
    if (item === null) throw new NotFoundError('item');
    if (item.workflow_status !== 'submitted') {
      throw new ClaimNotOwnedError('Only a submitted item can be reopened for recount.');
    }

    await client.query(
      `UPDATE count_submission_history
          SET reopened_by = $2, reopened_at = NOW(), reopen_reason = $3
        WHERE stock_recheck_item_id = $1 AND is_current`,
      [params.itemId, params.actorId, params.reason],
    );

    const reopened = await client.queryOne<ItemRow>(
      `UPDATE stock_recheck_items
          SET workflow_status     = 'available',
              result_status       = 'pending',
              counted_quantity    = NULL,
              quantity_difference = NULL,
              submitted_by        = NULL,
              submitted_at        = NULL,
              claimed_by          = NULL,
              claimed_at          = NULL,
              claim_expires_at    = NULL,
              row_version         = row_version + 1
        WHERE id = $1 AND stock_recheck_id = $2
        RETURNING ${ITEM_COLUMNS_BARE}`,
      [params.itemId, params.recheckId],
    );
    if (reopened === null) throw new NotFoundError('item');

    await recordAuditEventInTransaction(client, {
      eventType: 'item.reopened',
      actorUserId: params.actorId,
      actorDisplayName: params.actorDisplayName,
      stockRecheckId: params.recheckId,
      stockRecheckItemId: params.itemId,
      metadata: {
        reason: params.reason,
        previousCountedQuantity: item.counted_quantity,
        previousQuantityDifference: item.quantity_difference,
        previousResultStatus: item.result_status,
        previousSubmittedBy: item.submitted_by,
        previousSubmittedAt: item.submitted_at,
      },
      correlationId: params.correlationId,
      requestIp: params.requestIp,
    });

    await recalculateRecheckProgress(client, params.recheckId);
    return reopened;
  });
}

/* ------------------------------------------------------ progress rollup -- */

export interface ProgressCounts {
  totalItems: number;
  availableItems: number;
  inProgressItems: number;
  submittedItems: number;
  matchedItems: number;
  mismatchedItems: number;
}

/**
 * Recomputes the denormalized counters on `stock_rechecks` from the items
 * table, then derives the recheck status via the SHARED domain function so the
 * rule exists in exactly one place (section 44).
 */
export async function recalculateRecheckProgress(
  client: TransactionClient,
  recheckId: string,
): Promise<{ counts: ProgressCounts; status: string; becameCompleted: boolean }> {
  const aggregate = await client.queryOne<{
    total: number;
    available: number;
    in_progress: number;
    submitted: number;
    matched: number;
    mismatched: number;
  }>(
    `SELECT COUNT(*)::int                                                          AS total,
            COUNT(*) FILTER (WHERE workflow_status = 'available')::int             AS available,
            COUNT(*) FILTER (WHERE workflow_status = 'counting_in_progress')::int  AS in_progress,
            COUNT(*) FILTER (WHERE workflow_status = 'submitted')::int             AS submitted,
            COUNT(*) FILTER (WHERE result_status = 'matched')::int                 AS matched,
            COUNT(*) FILTER (WHERE result_status = 'mismatched')::int              AS mismatched
       FROM stock_recheck_items
      WHERE stock_recheck_id = $1`,
    [recheckId],
  );

  const counts: ProgressCounts = {
    totalItems: aggregate?.total ?? 0,
    availableItems: aggregate?.available ?? 0,
    inProgressItems: aggregate?.in_progress ?? 0,
    submittedItems: aggregate?.submitted ?? 0,
    matchedItems: aggregate?.matched ?? 0,
    mismatchedItems: aggregate?.mismatched ?? 0,
  };

  const current = await client.queryOne<{ status: string }>(
    'SELECT status FROM stock_rechecks WHERE id = $1 FOR UPDATE',
    [recheckId],
  );
  const currentStatus = (current?.status ?? 'ready') as Parameters<typeof deriveRecheckStatus>[1];
  const nextStatus = deriveRecheckStatus(counts, currentStatus);
  const becameCompleted = nextStatus === 'completed' && currentStatus !== 'completed';

  // $8 is referenced in three different contexts (an enum assignment and two
  // text comparisons). Without explicit casts Postgres cannot deduce a single
  // type for the parameter and rejects the statement with
  // "inconsistent types deduced for parameter $8".
  await client.query(
    `UPDATE stock_rechecks
        SET total_items       = $2,
            available_items   = $3,
            in_progress_items = $4,
            submitted_items   = $5,
            matched_items     = $6,
            mismatched_items  = $7,
            status            = $8::recheck_status,
            started_at        = COALESCE(started_at,
                                  CASE WHEN $8::text IN ('in_progress','completed')
                                       THEN NOW() END),
            completed_at      = CASE WHEN $8::text = 'completed'
                                     THEN COALESCE(completed_at, NOW())
                                     ELSE NULL END,
            version           = version + 1
      WHERE id = $1`,
    [
      recheckId,
      counts.totalItems,
      counts.availableItems,
      counts.inProgressItems,
      counts.submittedItems,
      counts.matchedItems,
      counts.mismatchedItems,
      nextStatus,
    ],
  );

  return { counts, status: nextStatus, becameCompleted };
}

/**
 * Recomputes the cached counters on a Stock Recheck from its items.
 *
 * `recalculateRecheckProgress` already ran on submit, amend and reopen, but NOT
 * on claim, release or stale-claim expiry — so `available_items` and
 * `in_progress_items` went stale the moment anyone claimed anything, and the
 * workspace stat cards and the Rechecks list both reported "0 counting" while
 * items were plainly being counted. `deriveRecheckStatus` already maps
 * `inProgressItems > 0` to `in_progress`, so those paths were always meant to
 * recalculate; they simply never did.
 *
 * Deliberately kept OUT of `claimItemAtomically`: that function's single
 * conditional UPDATE is the whole of the section 2.4 concurrency guarantee and
 * must stay one statement. This runs afterwards instead. If a process dies
 * between the two, the counters are stale until the next recalculation — the
 * item state itself, which is what correctness depends on, is never wrong.
 */
export async function refreshRecheckProgress(recheckId: string): Promise<void> {
  await withTransaction(async (client) => {
    await recalculateRecheckProgress(client, recheckId);
  });
}

/* ------------------------------------------------------- stock refresh -- */

export interface RefreshableItem {
  id: string;
  sku: string;
  normalized_sku: string;
  item_name: string;
  zoho_stock_quantity: number;
  workflow_status: ItemWorkflowStatus;
}

/**
 * The items a stock refresh may touch: everything NOT yet submitted.
 *
 * A submitted row's Zoho figure is part of the permanent record of that
 * submission (section 2.2) and is what its stored difference was computed
 * against. Re-reading it would silently rewrite a completed result, so
 * submitted rows are excluded here rather than filtered by the caller.
 */
export async function listRefreshableItems(recheckId: string): Promise<RefreshableItem[]> {
  return queryMany<RefreshableItem>(
    `SELECT id, sku, normalized_sku, item_name, zoho_stock_quantity, workflow_status
       FROM stock_recheck_items
      WHERE stock_recheck_id = $1
        AND workflow_status IN ('available', 'counting_in_progress')
      ORDER BY item_name`,
    [recheckId],
  );
}

export interface StockRefreshUpdate {
  itemId: string;
  stockQuantity: number;
  snapshot: unknown;
}

/**
 * Writes refreshed Zoho figures.
 *
 * Re-checks `workflow_status` inside the UPDATE rather than trusting the list
 * read: a counter can submit an item between the Zoho fetch and this write, and
 * that submission must win. The guard makes the race harmless instead of
 * overwriting a just-finished result with an older reading.
 */
export async function applyStockRefresh(
  recheckId: string,
  updates: readonly StockRefreshUpdate[],
): Promise<number> {
  if (updates.length === 0) return 0;

  return withTransaction(async (client) => {
    let applied = 0;
    for (const update of updates) {
      const result = await client.query(
        `UPDATE stock_recheck_items
            SET zoho_stock_quantity = $3,
                zoho_snapshot_json  = $4,
                row_version         = row_version + 1,
                updated_at          = NOW()
          WHERE id = $1
            AND stock_recheck_id = $2
            AND workflow_status IN ('available', 'counting_in_progress')`,
        [update.itemId, recheckId, update.stockQuantity, JSON.stringify(update.snapshot)],
      );
      applied += result.rowCount ?? 0;
    }

    // The recheck-level timestamp records when its stock was last read.
    await client.query('UPDATE stock_rechecks SET zoho_snapshot_at = NOW() WHERE id = $1', [
      recheckId,
    ]);

    return applied;
  });
}

/** Items a user currently holds — powers the "Continue Counting" affordance. */
export async function findActiveClaimForUser(userId: string): Promise<
  | {
      item_id: string;
      stock_recheck_id: string;
      item_name: string;
      sku: string;
      claim_expires_at: string;
      recheck_number: string;
    }
  | null
> {
  return queryOne(
    `SELECT i.id AS item_id, i.stock_recheck_id, i.item_name, i.sku,
            i.claim_expires_at, r.recheck_number
       FROM stock_recheck_items i
       JOIN stock_rechecks r ON r.id = i.stock_recheck_id
      WHERE i.claimed_by = $1
        AND i.workflow_status = 'counting_in_progress'
        AND i.claim_expires_at > NOW()
      ORDER BY i.claimed_at DESC
      LIMIT 1`,
    [userId],
  );
}

/** Every submitted item in a recheck, shaped for the difference export. */
export async function listItemsForExport(recheckId: string): Promise<
  {
    item_name: string;
    sku: string;
    quantity_difference: number | null;
    result_status: ResultStatus;
    submitted_at: string | null;
  }[]
> {
  return queryMany(
    `SELECT item_name, sku, quantity_difference, result_status, submitted_at
       FROM stock_recheck_items
      WHERE stock_recheck_id = $1 AND submitted_at IS NOT NULL
      ORDER BY item_name ASC, sku ASC`,
    [recheckId],
  );
}
