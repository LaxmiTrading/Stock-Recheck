/**
 * Status derivation and identifiers — specification sections 3.1, 6 and 19.
 */

import { describe, expect, it } from 'vitest';
import {
  calculateCompletionPercentage,
  deriveRecheckStatus,
  isRecheckActive,
  isRecheckReadOnly,
  itemWorkflowTone,
} from '@/domain/status';
import {
  businessDateInTimeZone,
  formatBusinessDateLong,
  formatRecheckDisplayName,
  formatRecheckNumber,
  isValidBusinessDate,
  isValidRecheckName,
  parseRecheckNumber,
} from '@/domain/recheckNumber';
import { failureReason, isRetryable, retryableCodes } from '@/domain/failureCodes';

describe('deriveRecheckStatus (section 6.1)', () => {
  it('is ready when nothing has been claimed or submitted', () => {
    expect(
      deriveRecheckStatus(
        { totalItems: 10, availableItems: 10, inProgressItems: 0, submittedItems: 0 },
        'ready',
      ),
    ).toBe('ready');
  });

  it('is in_progress once an item is claimed', () => {
    expect(
      deriveRecheckStatus(
        { totalItems: 10, availableItems: 9, inProgressItems: 1, submittedItems: 0 },
        'ready',
      ),
    ).toBe('in_progress');
  });

  it('is in_progress once an item is submitted but work remains', () => {
    expect(
      deriveRecheckStatus(
        { totalItems: 10, availableItems: 9, inProgressItems: 0, submittedItems: 1 },
        'ready',
      ),
    ).toBe('in_progress');
  });

  it('is completed only when every item is submitted', () => {
    expect(
      deriveRecheckStatus(
        { totalItems: 10, availableItems: 0, inProgressItems: 0, submittedItems: 10 },
        'in_progress',
      ),
    ).toBe('completed');
  });

  it('never derives away from cancelled', () => {
    expect(
      deriveRecheckStatus(
        { totalItems: 10, availableItems: 0, inProgressItems: 0, submittedItems: 10 },
        'cancelled',
      ),
    ).toBe('cancelled');
  });

  it('leaves draft and validating untouched', () => {
    const counts = { totalItems: 0, availableItems: 0, inProgressItems: 0, submittedItems: 0 };
    expect(deriveRecheckStatus(counts, 'draft')).toBe('draft');
    expect(deriveRecheckStatus(counts, 'validating')).toBe('validating');
  });
});

describe('calculateCompletionPercentage (section 19)', () => {
  it('counts only SUBMITTED items as complete', () => {
    // Claimed-but-unsubmitted must not inflate the figure.
    expect(calculateCompletionPercentage({ submittedItems: 5, totalItems: 10 })).toBe(50);
    expect(calculateCompletionPercentage({ submittedItems: 0, totalItems: 10 })).toBe(0);
    expect(calculateCompletionPercentage({ submittedItems: 10, totalItems: 10 })).toBe(100);
  });

  it('returns zero rather than dividing by zero', () => {
    expect(calculateCompletionPercentage({ submittedItems: 0, totalItems: 0 })).toBe(0);
  });
});

describe('read-only and active status helpers (section 38)', () => {
  it('treats completed and cancelled as read-only', () => {
    expect(isRecheckReadOnly('completed')).toBe(true);
    expect(isRecheckReadOnly('cancelled')).toBe(true);
    expect(isRecheckReadOnly('in_progress')).toBe(false);
  });

  it('treats ready and in_progress as active', () => {
    expect(isRecheckActive('ready')).toBe(true);
    expect(isRecheckActive('in_progress')).toBe(true);
    expect(isRecheckActive('completed')).toBe(false);
  });
});

describe('itemWorkflowTone', () => {
  it('maps each state to its semantic tone', () => {
    expect(itemWorkflowTone('available', 'pending')).toBe('neutral');
    expect(itemWorkflowTone('counting_in_progress', 'pending')).toBe('info');
    expect(itemWorkflowTone('submitted', 'matched')).toBe('success');
    expect(itemWorkflowTone('submitted', 'mismatched')).toBe('danger');
  });
});

describe('recheck identifiers (section 3.1)', () => {
  it('formats the documented number', () => {
    expect(formatRecheckNumber('2026-07-23', 1)).toBe('SR-20260723-001');
    expect(formatRecheckNumber('2026-07-23', 42)).toBe('SR-20260723-042');
    expect(formatRecheckNumber('2026-07-23', 7, 'INV')).toBe('INV-20260723-007');
  });

  it('formats the documented display name', () => {
    expect(formatRecheckDisplayName('2026-07-23', 1)).toBe('Stock Recheck — 23 Jul 2026 — 001');
  });

  it('round-trips through the parser', () => {
    expect(parseRecheckNumber('SR-20260723-001')).toEqual({
      prefix: 'SR',
      businessDate: '2026-07-23',
      sequence: 1,
    });
    expect(parseRecheckNumber('not-a-number')).toBeNull();
  });

  it('renders the long date without timezone drift', () => {
    // Midday-UTC interpretation prevents the date sliding a day either way.
    expect(formatBusinessDateLong('2026-07-23', 'Asia/Kolkata')).toBe('23 Jul 2026');
    expect(formatBusinessDateLong('2026-01-01', 'America/Los_Angeles')).toBe('01 Jan 2026');
  });
});

describe('businessDateInTimeZone', () => {
  it('uses the business timezone, not the host timezone', () => {
    // 20:00 UTC on the 24th is already the 25th in Asia/Kolkata (+05:30).
    const instant = new Date('2026-07-24T20:00:00Z');
    expect(businessDateInTimeZone(instant, 'Asia/Kolkata')).toBe('2026-07-25');
    expect(businessDateInTimeZone(instant, 'UTC')).toBe('2026-07-24');
    expect(businessDateInTimeZone(instant, 'America/Los_Angeles')).toBe('2026-07-24');
  });
});

describe('business date and name validation (section 18)', () => {
  it('rejects impossible calendar dates', () => {
    expect(isValidBusinessDate('2026-07-23')).toBe(true);
    expect(isValidBusinessDate('2026-02-31')).toBe(false);
    expect(isValidBusinessDate('23-07-2026')).toBe(false);
    expect(isValidBusinessDate('')).toBe(false);
  });

  it('enforces the 100-character name limit', () => {
    expect(isValidRecheckName('Stock Recheck')).toBe(true);
    expect(isValidRecheckName('   ')).toBe(false);
    expect(isValidRecheckName('x'.repeat(100))).toBe(true);
    expect(isValidRecheckName('x'.repeat(101))).toBe(false);
  });
});

describe('failure codes (section 16)', () => {
  it('interpolates the accepted row into the duplicate message', () => {
    expect(failureReason('DUPLICATE_IN_IMPORT', { duplicateOfRowNumber: 7 })).toBe(
      'This SKU already appeared on row 7.',
    );
  });

  it('degrades gracefully when the row is unknown', () => {
    expect(failureReason('DUPLICATE_IN_IMPORT')).toContain('already appeared');
  });

  it('marks only transient Zoho conditions retryable (section 17)', () => {
    expect(isRetryable('ZOHO_RATE_LIMITED')).toBe(true);
    expect(isRetryable('ZOHO_TEMPORARILY_UNAVAILABLE')).toBe(true);
    expect(isRetryable('ZOHO_AUTHENTICATION_FAILED')).toBe(true);
    expect(isRetryable('UNEXPECTED_ZOHO_RESPONSE')).toBe(true);

    // Permanent failures must NOT offer Retry.
    expect(isRetryable('EMPTY_SKU')).toBe(false);
    expect(isRetryable('DUPLICATE_IN_IMPORT')).toBe(false);
    expect(isRetryable('SKU_NOT_FOUND')).toBe(false);
    expect(isRetryable('AMBIGUOUS_SKU')).toBe(false);
    expect(isRetryable('INACTIVE_ITEM')).toBe(false);
    expect(isRetryable('NOT_INVENTORY_TRACKED')).toBe(false);
    expect(isRetryable('STOCK_BASIS_NOT_FOUND')).toBe(false);
  });

  it('exposes the retryable set for the Retry All action', () => {
    expect(retryableCodes()).toContain('ZOHO_RATE_LIMITED');
    expect(retryableCodes()).not.toContain('EMPTY_SKU');
  });
});
