/**
 * Idempotency — specification sections 18, 23, 30.9.
 *
 * Guarantees that a retried Stock Recheck creation or count submission cannot
 * produce a duplicate. The first request to claim a key wins; concurrent
 * duplicates and later retries receive the stored response.
 */

import { createHash } from 'node:crypto';
import { AppError } from './errors';
import { query, queryOne } from './database/client';

export type IdempotentOperation =
  | 'recheck.create'
  | 'count.submit'
  | 'export.generate'
  | 'item.reopen'
  // Amending a submitted count writes a new history attempt, so a retried
  // request must be replay-protected exactly like the original submission.
  | 'item.amend';

export function hashRequest(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');
}

interface KeyRow {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

export type IdempotencyOutcome<Result> =
  /** No prior request: the caller should do the work then call `complete`. */
  | { kind: 'proceed' }
  /** A previous identical request already completed; replay its response. */
  | { kind: 'replay'; status: number; body: Result }
  /** The same request is still running elsewhere. */
  | { kind: 'in_flight' };

/**
 * Reserves the key. Uses `ON CONFLICT DO NOTHING` so that two concurrent
 * requests race at the database, not in application code — exactly one insert
 * succeeds.
 */
export async function beginIdempotentOperation<Result>(params: {
  userId: string;
  operation: IdempotentOperation;
  idempotencyKey: string;
  requestPayload: unknown;
}): Promise<IdempotencyOutcome<Result>> {
  const requestHash = hashRequest(params.requestPayload);

  const inserted = await query(
    `INSERT INTO idempotency_keys (user_id, operation_type, idempotency_key, request_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, operation_type, idempotency_key) DO NOTHING
     RETURNING id`,
    [params.userId, params.operation, params.idempotencyKey, requestHash],
  );

  if ((inserted.rowCount ?? 0) > 0) return { kind: 'proceed' };

  const existing = await queryOne<KeyRow>(
    `SELECT request_hash, response_status, response_body
       FROM idempotency_keys
      WHERE user_id = $1 AND operation_type = $2 AND idempotency_key = $3`,
    [params.userId, params.operation, params.idempotencyKey],
  );

  if (existing === null) {
    // The row expired between the insert attempt and this read. Treat it as a
    // fresh request rather than failing the user.
    return { kind: 'proceed' };
  }

  // Same key, different payload — a client bug that must not silently reuse
  // an unrelated stored response.
  if (existing.request_hash !== requestHash) {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'This idempotency key was already used with a different request.',
      409,
    );
  }

  if (existing.response_status === null) return { kind: 'in_flight' };

  return {
    kind: 'replay',
    status: existing.response_status,
    body: existing.response_body as Result,
  };
}

/** Stores the response so a later retry replays it verbatim. */
export async function completeIdempotentOperation(params: {
  userId: string;
  operation: IdempotentOperation;
  idempotencyKey: string;
  status: number;
  body: unknown;
}): Promise<void> {
  await query(
    `UPDATE idempotency_keys
        SET response_status = $4, response_body = $5
      WHERE user_id = $1 AND operation_type = $2 AND idempotency_key = $3`,
    [
      params.userId,
      params.operation,
      params.idempotencyKey,
      params.status,
      JSON.stringify(params.body ?? null),
    ],
  );
}

/**
 * Releases a reservation whose work failed, so the user can retry rather than
 * being permanently blocked by a key that recorded no response.
 */
export async function abandonIdempotentOperation(params: {
  userId: string;
  operation: IdempotentOperation;
  idempotencyKey: string;
}): Promise<void> {
  await query(
    `DELETE FROM idempotency_keys
      WHERE user_id = $1 AND operation_type = $2 AND idempotency_key = $3
        AND response_status IS NULL`,
    [params.userId, params.operation, params.idempotencyKey],
  );
}

export async function pruneIdempotencyKeys(): Promise<void> {
  await query('DELETE FROM idempotency_keys WHERE expires_at < NOW()');
}
