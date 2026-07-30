/**
 * Audit trail writer — specification section 29.
 *
 * Audit events are written server-side only. Metadata passes through
 * `redactAuditMetadata` so that a careless caller cannot persist a token,
 * password or client secret.
 */

import { redactAuditMetadata, type AuditEventType, type AuditMetadata } from '../../src/domain/audit';
import { query, type TransactionClient } from './database/client';
import { logError } from './http';

export interface AuditEventInput {
  eventType: AuditEventType;
  actorUserId?: string | null;
  actorDisplayName?: string | null;
  stockRecheckId?: string | null;
  stockRecheckItemId?: string | null;
  metadata?: AuditMetadata;
  correlationId: string;
  requestIp?: string | null;
}

const INSERT_SQL = `
  INSERT INTO audit_events (
    event_type, actor_user_id, actor_display_name,
    stock_recheck_id, stock_recheck_item_id,
    metadata_json, correlation_id, request_ip
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`;

function toParameters(event: AuditEventInput): unknown[] {
  return [
    event.eventType,
    event.actorUserId ?? null,
    event.actorDisplayName ?? null,
    event.stockRecheckId ?? null,
    event.stockRecheckItemId ?? null,
    JSON.stringify(redactAuditMetadata(event.metadata ?? {})),
    event.correlationId,
    event.requestIp ?? null,
  ];
}

/**
 * Writes an audit event outside any transaction.
 *
 * Never throws: an audit-write failure must not fail the user's operation.
 * It is logged loudly instead so the gap is visible in monitoring.
 */
export async function recordAuditEvent(event: AuditEventInput): Promise<void> {
  try {
    await query(INSERT_SQL, toParameters(event));
  } catch (error) {
    logError('audit.write_failed', {
      correlationId: event.correlationId,
      eventType: event.eventType,
      error,
    });
  }
}

/**
 * Writes an audit event inside an existing transaction, so the event and the
 * state change it describes commit or roll back together.
 *
 * This one DOES propagate errors — inside a transaction the caller has chosen
 * atomicity, and silently dropping the record would break the audit trail.
 */
export async function recordAuditEventInTransaction(
  client: TransactionClient,
  event: AuditEventInput,
): Promise<void> {
  await client.query(INSERT_SQL, toParameters(event));
}
