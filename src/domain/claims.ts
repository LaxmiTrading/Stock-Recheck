/**
 * Claim lease arithmetic — specification section 20.
 *
 * The authoritative claim state lives in Postgres; these helpers only compute
 * and interpret lease timestamps. Claim OWNERSHIP is never decided from
 * frontend state (section 20).
 */

export const DEFAULT_CLAIM_LEASE_SECONDS = 15 * 60; // 15 minutes
export const DEFAULT_HEARTBEAT_SECONDS = 30;
export const DEFAULT_STALE_GRACE_SECONDS = 60;

/**
 * The heartbeat must fire several times within one lease so a single dropped
 * request cannot expire an active claim. Section 28.4 requires validating
 * this relationship.
 */
export const MIN_HEARTBEATS_PER_LEASE = 3;

export function isHeartbeatIntervalValid(
  heartbeatSeconds: number,
  leaseSeconds: number,
): boolean {
  if (!Number.isFinite(heartbeatSeconds) || !Number.isFinite(leaseSeconds)) return false;
  if (heartbeatSeconds <= 0 || leaseSeconds <= 0) return false;
  return heartbeatSeconds * MIN_HEARTBEATS_PER_LEASE <= leaseSeconds;
}

export function heartbeatValidationMessage(
  heartbeatSeconds: number,
  leaseSeconds: number,
): string | null {
  if (heartbeatSeconds <= 0) return 'Heartbeat interval must be greater than zero.';
  if (leaseSeconds <= 0) return 'Claim lease duration must be greater than zero.';
  if (!isHeartbeatIntervalValid(heartbeatSeconds, leaseSeconds)) {
    const maximum = Math.floor(leaseSeconds / MIN_HEARTBEATS_PER_LEASE);
    return `Heartbeat must be at most ${maximum}s so at least ${MIN_HEARTBEATS_PER_LEASE} heartbeats fit inside the ${leaseSeconds}s lease.`;
  }
  return null;
}

/** Computes the absolute expiry instant for a new or extended lease. */
export function computeClaimExpiry(now: Date, leaseSeconds: number): Date {
  return new Date(now.getTime() + leaseSeconds * 1000);
}

/**
 * A claim is active while its expiry is in the future. The grace period gives
 * a client whose heartbeat is briefly delayed a chance to recover before the
 * item becomes reclaimable (section 28.4).
 */
export function isClaimActive(
  claimExpiresAt: string | Date | null | undefined,
  now: Date = new Date(),
  graceSeconds = 0,
): boolean {
  if (claimExpiresAt === null || claimExpiresAt === undefined) return false;
  const expiry = claimExpiresAt instanceof Date ? claimExpiresAt : new Date(claimExpiresAt);
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry.getTime() + graceSeconds * 1000 > now.getTime();
}

export function isClaimExpired(
  claimExpiresAt: string | Date | null | undefined,
  now: Date = new Date(),
  graceSeconds = 0,
): boolean {
  if (claimExpiresAt === null || claimExpiresAt === undefined) return false;
  return !isClaimActive(claimExpiresAt, now, graceSeconds);
}

/** Whole seconds remaining on the lease; 0 once expired. */
export function claimSecondsRemaining(
  claimExpiresAt: string | Date | null | undefined,
  now: Date = new Date(),
): number {
  if (claimExpiresAt === null || claimExpiresAt === undefined) return 0;
  const expiry = claimExpiresAt instanceof Date ? claimExpiresAt : new Date(claimExpiresAt);
  if (Number.isNaN(expiry.getTime())) return 0;
  return Math.max(0, Math.floor((expiry.getTime() - now.getTime()) / 1000));
}

/** `12:04` style countdown for the claim-lease indicator (section 21). */
export function formatLeaseRemaining(secondsRemaining: number): string {
  const safe = Math.max(0, Math.floor(secondsRemaining));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Lease health drives the colour of the claim indicator. */
export type LeaseHealth = 'healthy' | 'expiring' | 'expired';

export function leaseHealth(secondsRemaining: number, leaseSeconds: number): LeaseHealth {
  if (secondsRemaining <= 0) return 'expired';
  if (secondsRemaining <= Math.max(30, leaseSeconds * 0.2)) return 'expiring';
  return 'healthy';
}

/**
 * Whether a locally stored draft count may be restored — section 22.
 *
 * Every condition must hold. The claim version is the decisive check: it is
 * incremented on every claim, so a draft written under an older claim can
 * never be resurrected against a newer one, even if the same user reclaims
 * the same item.
 */
export interface LocalDraftValidation {
  draftUserId: string;
  draftItemId: string;
  draftClaimVersion: number;
  draftNormalizedSku: string;
  currentUserId: string;
  currentItemId: string;
  currentClaimVersion: number;
  currentNormalizedSku: string;
  currentClaimOwnerId: string | null;
  claimExpiresAt: string | Date | null;
  isSubmitted: boolean;
  now?: Date;
}

export type DraftRejectionReason =
  | 'different_user'
  | 'different_item'
  | 'claim_version_changed'
  | 'sku_changed'
  | 'not_claim_owner'
  | 'claim_expired'
  | 'already_submitted';

export function validateLocalDraft(
  input: LocalDraftValidation,
): { restorable: true } | { restorable: false; reason: DraftRejectionReason } {
  if (input.draftUserId !== input.currentUserId) {
    return { restorable: false, reason: 'different_user' };
  }
  if (input.draftItemId !== input.currentItemId) {
    return { restorable: false, reason: 'different_item' };
  }
  if (input.isSubmitted) {
    return { restorable: false, reason: 'already_submitted' };
  }
  if (input.currentClaimOwnerId !== input.currentUserId) {
    return { restorable: false, reason: 'not_claim_owner' };
  }
  if (input.draftClaimVersion !== input.currentClaimVersion) {
    return { restorable: false, reason: 'claim_version_changed' };
  }
  if (input.draftNormalizedSku !== input.currentNormalizedSku) {
    return { restorable: false, reason: 'sku_changed' };
  }
  if (!isClaimActive(input.claimExpiresAt, input.now ?? new Date())) {
    return { restorable: false, reason: 'claim_expired' };
  }
  return { restorable: true };
}

export const DRAFT_REJECTION_MESSAGE: Record<DraftRejectionReason, string> = {
  different_user: 'This local count belongs to a different user account.',
  different_item: 'This local count belongs to a different item.',
  claim_version_changed:
    'Your previous claim expired. This local count has not been submitted.',
  sku_changed: 'This item has changed since the count was saved.',
  not_claim_owner: 'This item is no longer claimed by you. The local count cannot be submitted.',
  claim_expired: 'Your previous claim expired. This local count has not been submitted.',
  already_submitted: 'This item has already been submitted by another session.',
};
