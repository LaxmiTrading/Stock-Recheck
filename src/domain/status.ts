/**
 * Status models and domain terminology — specification sections 5 and 6.
 * These string literals are persisted in Postgres enums; do not rename them
 * without a migration.
 */

/* ---------------------------------------------------------------- section 6.1 */

export const RECHECK_STATUSES = [
  'draft',
  'validating',
  'ready',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type RecheckStatus = (typeof RECHECK_STATUSES)[number];

export const RECHECK_STATUS_LABEL: Record<RecheckStatus, string> = {
  draft: 'Draft',
  validating: 'Validating',
  ready: 'Ready',
  in_progress: 'In Progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const RECHECK_STATUS_DESCRIPTION: Record<RecheckStatus, string> = {
  draft: 'Import data exists but has not been finalized.',
  validating: 'The application is matching SKUs with Zoho.',
  ready: 'The Stock Recheck has valid items, but no item has yet been claimed or submitted.',
  in_progress:
    'At least one item has been claimed or submitted and at least one item remains incomplete.',
  completed: 'Every valid item has been submitted.',
  cancelled: 'The administrator cancelled the Stock Recheck. It is read-only.',
};

/* ---------------------------------------------------------------- section 6.2 */

export const ITEM_WORKFLOW_STATUSES = ['available', 'counting_in_progress', 'submitted'] as const;
export type ItemWorkflowStatus = (typeof ITEM_WORKFLOW_STATUSES)[number];

export const ITEM_WORKFLOW_STATUS_LABEL: Record<ItemWorkflowStatus, string> = {
  available: 'Available',
  counting_in_progress: 'Counting in progress',
  submitted: 'Submitted',
};

/* ---------------------------------------------------------------- section 6.3 */

export const RESULT_STATUSES = ['pending', 'matched', 'mismatched'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

export const RESULT_STATUS_LABEL: Record<ResultStatus, string> = {
  pending: 'Pending',
  matched: 'Matched',
  mismatched: 'Mismatched',
};

/* ------------------------------------------------------------ derived helpers */

export interface RecheckItemCounts {
  totalItems: number;
  availableItems: number;
  inProgressItems: number;
  submittedItems: number;
}

/**
 * Derives the Stock Recheck status from its item counts (section 6.1).
 *
 * `cancelled` is a terminal administrative state and is never derived — the
 * caller passes the current status so it can be preserved.
 */
export function deriveRecheckStatus(
  counts: RecheckItemCounts,
  currentStatus: RecheckStatus,
): RecheckStatus {
  if (currentStatus === 'cancelled') return 'cancelled';
  if (currentStatus === 'draft' || currentStatus === 'validating') return currentStatus;

  if (counts.totalItems === 0) return 'ready';
  if (counts.submittedItems >= counts.totalItems) return 'completed';
  if (counts.submittedItems > 0 || counts.inProgressItems > 0) return 'in_progress';
  return 'ready';
}

/**
 * Completion percentage — section 19.
 * Claimed-but-unsubmitted items deliberately do NOT count as complete.
 */
export function calculateCompletionPercentage(counts: {
  submittedItems: number;
  totalItems: number;
}): number {
  if (counts.totalItems <= 0) return 0;
  return Math.round((counts.submittedItems / counts.totalItems) * 100);
}

/** A recheck that accepts no further claims or submissions (section 38). */
export function isRecheckReadOnly(status: RecheckStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

/** A recheck that is open for counting work. */
export function isRecheckActive(status: RecheckStatus): boolean {
  return status === 'ready' || status === 'in_progress';
}

/** Semantic colour token per status — section 35. Paired with an icon in the UI. */
export type StatusTone = 'neutral' | 'info' | 'success' | 'danger' | 'warning' | 'muted';

export function itemWorkflowTone(
  status: ItemWorkflowStatus,
  resultStatus: ResultStatus,
): StatusTone {
  if (status === 'available') return 'neutral';
  if (status === 'counting_in_progress') return 'info';
  if (resultStatus === 'matched') return 'success';
  if (resultStatus === 'mismatched') return 'danger';
  return 'neutral';
}

export function recheckStatusTone(status: RecheckStatus): StatusTone {
  switch (status) {
    case 'completed':
      return 'success';
    case 'in_progress':
      return 'info';
    case 'validating':
      return 'warning';
    case 'cancelled':
      return 'muted';
    case 'ready':
    case 'draft':
      return 'neutral';
  }
}
