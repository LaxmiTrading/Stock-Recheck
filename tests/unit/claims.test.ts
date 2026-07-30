/**
 * Claim lease arithmetic and local-draft validation — specification
 * sections 20 and 22.
 */

import { describe, expect, it } from 'vitest';
import {
  claimSecondsRemaining,
  computeClaimExpiry,
  formatLeaseRemaining,
  heartbeatValidationMessage,
  isClaimActive,
  isClaimExpired,
  isHeartbeatIntervalValid,
  leaseHealth,
  validateLocalDraft,
  type LocalDraftValidation,
} from '@/domain/claims';

const NOW = new Date('2026-07-25T12:00:00Z');

describe('computeClaimExpiry', () => {
  it('adds the lease duration to the given instant', () => {
    expect(computeClaimExpiry(NOW, 900).toISOString()).toBe('2026-07-25T12:15:00.000Z');
  });
});

describe('isClaimActive / isClaimExpired', () => {
  it('treats a future expiry as active', () => {
    expect(isClaimActive('2026-07-25T12:05:00Z', NOW)).toBe(true);
    expect(isClaimExpired('2026-07-25T12:05:00Z', NOW)).toBe(false);
  });

  it('treats a past expiry as expired', () => {
    expect(isClaimActive('2026-07-25T11:55:00Z', NOW)).toBe(false);
    expect(isClaimExpired('2026-07-25T11:55:00Z', NOW)).toBe(true);
  });

  it('treats a null expiry as no claim at all', () => {
    expect(isClaimActive(null, NOW)).toBe(false);
    // Not "expired" either — there was never a claim.
    expect(isClaimExpired(null, NOW)).toBe(false);
  });

  it('honours the grace period', () => {
    // Expired 30s ago, but a 60s grace keeps it active.
    expect(isClaimActive('2026-07-25T11:59:30Z', NOW, 60)).toBe(true);
    expect(isClaimActive('2026-07-25T11:59:30Z', NOW, 10)).toBe(false);
  });

  it('rejects an unparseable timestamp rather than treating it as active', () => {
    expect(isClaimActive('not-a-date', NOW)).toBe(false);
  });
});

describe('claimSecondsRemaining', () => {
  it('counts down and floors at zero', () => {
    expect(claimSecondsRemaining('2026-07-25T12:05:00Z', NOW)).toBe(300);
    expect(claimSecondsRemaining('2026-07-25T11:00:00Z', NOW)).toBe(0);
    expect(claimSecondsRemaining(null, NOW)).toBe(0);
  });
});

describe('formatLeaseRemaining', () => {
  it('renders m:ss', () => {
    expect(formatLeaseRemaining(900)).toBe('15:00');
    expect(formatLeaseRemaining(65)).toBe('1:05');
    expect(formatLeaseRemaining(9)).toBe('0:09');
    expect(formatLeaseRemaining(-5)).toBe('0:00');
  });
});

describe('leaseHealth', () => {
  it('reports expired at zero', () => {
    expect(leaseHealth(0, 900)).toBe('expired');
  });

  it('warns inside the final fifth of the lease', () => {
    expect(leaseHealth(100, 900)).toBe('expiring');
  });

  it('is healthy with plenty of time left', () => {
    expect(leaseHealth(800, 900)).toBe('healthy');
  });
});

describe('isHeartbeatIntervalValid (section 28.4)', () => {
  it('requires at least three heartbeats per lease', () => {
    expect(isHeartbeatIntervalValid(30, 900)).toBe(true);
    expect(isHeartbeatIntervalValid(300, 900)).toBe(true);
    expect(isHeartbeatIntervalValid(301, 900)).toBe(false);
  });

  it('rejects non-positive or non-finite values', () => {
    expect(isHeartbeatIntervalValid(0, 900)).toBe(false);
    expect(isHeartbeatIntervalValid(30, 0)).toBe(false);
    expect(isHeartbeatIntervalValid(Number.NaN, 900)).toBe(false);
  });

  it('produces an actionable message naming the maximum', () => {
    const message = heartbeatValidationMessage(400, 900);
    expect(message).toContain('300');
    expect(heartbeatValidationMessage(30, 900)).toBeNull();
  });
});

/* ------------------------------------------------- local draft validation */

const VALID_DRAFT: LocalDraftValidation = {
  draftUserId: 'user-1',
  draftItemId: 'item-1',
  draftClaimVersion: 4,
  draftNormalizedSku: 'ABC-001',
  currentUserId: 'user-1',
  currentItemId: 'item-1',
  currentClaimVersion: 4,
  currentNormalizedSku: 'ABC-001',
  currentClaimOwnerId: 'user-1',
  claimExpiresAt: '2026-07-25T12:10:00Z',
  isSubmitted: false,
  now: NOW,
};

describe('validateLocalDraft (section 22)', () => {
  it('restores when every check passes', () => {
    expect(validateLocalDraft(VALID_DRAFT)).toEqual({ restorable: true });
  });

  it('refuses a draft belonging to a different user', () => {
    const result = validateLocalDraft({ ...VALID_DRAFT, draftUserId: 'user-2' });
    expect(result).toEqual({ restorable: false, reason: 'different_user' });
  });

  it('refuses a draft for a different item', () => {
    const result = validateLocalDraft({ ...VALID_DRAFT, draftItemId: 'item-2' });
    expect(result).toEqual({ restorable: false, reason: 'different_item' });
  });

  it('refuses once the item has been submitted', () => {
    const result = validateLocalDraft({ ...VALID_DRAFT, isSubmitted: true });
    expect(result).toEqual({ restorable: false, reason: 'already_submitted' });
  });

  it('refuses when someone else now holds the claim', () => {
    const result = validateLocalDraft({ ...VALID_DRAFT, currentClaimOwnerId: 'user-2' });
    expect(result).toEqual({ restorable: false, reason: 'not_claim_owner' });
  });

  it('refuses a draft written under an older claim version', () => {
    // The decisive check: the same user reclaimed the same item, so the old
    // count must NOT be resurrected.
    const result = validateLocalDraft({ ...VALID_DRAFT, currentClaimVersion: 5 });
    expect(result).toEqual({ restorable: false, reason: 'claim_version_changed' });
  });

  it('refuses when the item SKU changed underneath the draft', () => {
    const result = validateLocalDraft({ ...VALID_DRAFT, currentNormalizedSku: 'XYZ-002' });
    expect(result).toEqual({ restorable: false, reason: 'sku_changed' });
  });

  it('refuses when the claim has expired', () => {
    const result = validateLocalDraft({
      ...VALID_DRAFT,
      claimExpiresAt: '2026-07-25T11:00:00Z',
    });
    expect(result).toEqual({ restorable: false, reason: 'claim_expired' });
  });
});
