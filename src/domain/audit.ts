/**
 * Audit event taxonomy — specification section 29.
 *
 * Events are written server-side only. The list is closed so that the audit
 * screen can offer a reliable filter and so that a typo cannot silently create
 * an unfilterable event type.
 */

export const AUDIT_EVENT_TYPES = [
  'user.invited',
  'user.invite_accepted',
  'user.disabled',
  'user.enabled',
  'user.role_changed',
  'user.password_reset_requested',
  'user.signed_in',
  'zoho.connected',
  'zoho.disconnected',
  'zoho.connection_failed',
  'settings.stock_basis_changed',
  'settings.updated',
  'import.started',
  'import.completed',
  'import.failed',
  'import.cancelled',
  'recheck.created',
  'recheck.completed',
  'recheck.cancelled',
  'recheck.stock_refreshed',
  'recheck.items_added',
  'recheck.items_removed',
  'item.claimed',
  'item.claim_heartbeat_failed',
  'item.claim_expired',
  'item.claim_released',
  'item.claim_force_released',
  'item.count_submitted',
  'item.count_amended',
  'item.reopened',
  'export.generated',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_EVENT_LABEL: Record<AuditEventType, string> = {
  'user.invited': 'User invited',
  'user.invite_accepted': 'Invite accepted',
  'user.disabled': 'User disabled',
  'user.enabled': 'User enabled',
  'user.role_changed': 'User role changed',
  'user.password_reset_requested': 'Password reset requested',
  'user.signed_in': 'User signed in',
  'zoho.connected': 'Zoho connected',
  'zoho.disconnected': 'Zoho disconnected',
  'zoho.connection_failed': 'Zoho connection failed',
  'settings.stock_basis_changed': 'Stock basis changed',
  'settings.updated': 'Settings updated',
  'import.started': 'Import started',
  'import.completed': 'Import completed',
  'import.failed': 'Import failed',
  'import.cancelled': 'Import cancelled',
  'recheck.created': 'Stock Recheck created',
  'recheck.completed': 'Stock Recheck completed',
  'recheck.cancelled': 'Stock Recheck cancelled',
  'recheck.stock_refreshed': 'Zoho stock refreshed',
  'recheck.items_added': 'Items added to Stock Recheck',
  'recheck.items_removed': 'Items removed from Stock Recheck',
  'item.claimed': 'Item claimed',
  'item.claim_heartbeat_failed': 'Claim heartbeat failure',
  'item.claim_expired': 'Claim expired',
  'item.claim_released': 'Claim released',
  'item.claim_force_released': 'Claim force-released',
  'item.count_submitted': 'Count submitted',
  'item.count_amended': 'Count amended',
  'item.reopened': 'Item reopened for recount',
  'export.generated': 'Excel exported',
};

export function isAuditEventType(value: string): value is AuditEventType {
  return (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Keys that must NEVER appear in audit metadata — section 29.
 * `redactAuditMetadata` strips them defensively even if a caller is careless.
 */
const FORBIDDEN_METADATA_KEYS = [
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'client_secret',
  'clientsecret',
  'password',
  'passwordhash',
  'password_hash',
  'authorization',
  'cookie',
  'set-cookie',
  'jwt',
  'secret',
  'apikey',
  'api_key',
];

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase().replace(/[^a-z_]/g, '');
  return FORBIDDEN_METADATA_KEYS.some((forbidden) => lower.includes(forbidden.replace(/[^a-z_]/g, '')));
}

export type AuditMetadata = Record<string, unknown>;

/**
 * Recursively removes secret-bearing keys from audit metadata before it is
 * persisted. Depth-limited so a cyclic or pathological object cannot hang the
 * request.
 */
export function redactAuditMetadata(metadata: AuditMetadata, depth = 0): AuditMetadata {
  if (depth > 6) return {};
  const output: AuditMetadata = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (isForbiddenKey(key)) {
      output[key] = '[redacted]';
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = redactAuditMetadata(value as AuditMetadata, depth + 1);
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value.slice(0, 100);
      continue;
    }
    output[key] = value;
  }

  return output;
}
