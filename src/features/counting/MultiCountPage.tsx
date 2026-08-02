/**
 * Multi-item counting screen — sections 2.3, 2.5, 20, 21 and 22.
 *
 * The operator claims several items in the workspace and counts them all here:
 * one scan bar feeds whichever row owns the scanned SKU, and every row can be
 * nudged with − / + or typed directly. Counting one item at a time meant a
 * round trip through the workspace between every single item.
 *
 * Two modes share the whole screen:
 *   count — items this user currently holds a claim on; submitting writes the
 *           first result for each (POST …/submit).
 *   amend — items that are ALREADY submitted, reopened for correction; saving
 *           writes a new attempt with a mandatory reason (POST …/amend).
 *
 * The running count never leaves the browser until submission (section 2.3);
 * `useLocalCountMap` owns it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  countRowState,
  countTotals,
  countVariance,
  resolveSessionScan,
  varianceTone,
  visibleCountRows,
  SCAN_NOT_IN_SESSION_MESSAGE,
  SCAN_UNKNOWN_MESSAGE,
  type CountFilter,
  type CountRow,
} from '@/domain/multiCount';
import {
  claimSecondsRemaining,
  formatLeaseRemaining,
  leaseHealth,
} from '@/domain/claims';
import { toNormalizedSku } from '@/domain/sku';
import { isAdministrator } from '@/domain/permissions';
import type { ItemWorkflowStatus, ResultStatus } from '@/domain/status';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, apiRequest, newIdempotencyKey } from '@/services/api';
import { useLocalCountMap, type SessionItemKey } from '@/hooks/useLocalCountMap';
import { useScannerFeedback } from '@/hooks/useScannerFeedback';
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorState,
  Field,
  InlineNotice,
  LinkButton,
  TextInput,
  useToast,
} from '@/components/ui';
import {
  ArrowLeftIcon,
  CloseIcon,
  PackageIcon,
  PlusIcon,
  SearchIcon,
} from '@/components/icons';

/* ------------------------------------------------------------------ types */

interface SessionItem {
  id: string;
  itemName: string;
  sku: string;
  zohoStock: number | null;
  workflowStatus: ItemWorkflowStatus;
  resultStatus: ResultStatus;
  claimVersion: number;
  isClaimedByMe: boolean;
  /** Drives the lease countdown; null once the item is no longer claimed. */
  claimExpiresAt: string | null;
  countedQuantity: number | null;
  submittedAt: string | null;
}

interface ItemsResponse {
  items: SessionItem[];
  pagination?: { total: number };
  isReadOnly: boolean;
}

interface ScannableItem {
  id: string;
  itemName: string;
  sku: string;
  normalizedSku: string;
}

type Mode = 'count' | 'amend';

/* -------------------------------------------------------------- fragments */

/** The barcode glyph in the scan bar. Purely decorative. */
function BarcodeMark({ tone }: { tone: 'idle' | 'error' }): React.JSX.Element {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
      className={clsx(
        'pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2',
        tone === 'error' ? 'text-[var(--color-danger)]' : 'text-[var(--color-ink-muted)]',
      )}
    >
      <path
        d="M2 4v12M5 4v12M8 4v12M11 4v12M14 4v12M17 4v12"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Placeholder for the whole counting session while it loads.
 *
 * A skeleton rather than a spinner because the layout is known in advance, so
 * the page can hold its shape and settle in place instead of jumping when the
 * data lands.
 */
function CountSessionSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Card>
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="h-3 w-28 animate-pulse rounded bg-[var(--color-surface-sunken)]" />
          <span className="h-4 w-32 animate-pulse rounded bg-[var(--color-surface-sunken)]" />
        </div>
        <div className="h-2.5 w-full animate-pulse rounded-full bg-[var(--color-surface-sunken)]" />
      </Card>

      <Card>
        <span className="block h-3 w-20 animate-pulse rounded bg-[var(--color-surface-sunken)]" />
        <div className="mt-2.5 flex gap-2.5">
          <div className="h-[52px] flex-1 animate-pulse rounded-[10px] bg-[var(--color-surface-sunken)]" />
          <div className="h-[52px] w-20 animate-pulse rounded-lg bg-[var(--color-surface-sunken)]" />
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="flex gap-2 border-b border-[var(--color-border)] p-3.5">
          {[72, 118, 104, 96].map((width) => (
            <span
              key={width}
              style={{ width }}
              className="h-8 animate-pulse rounded-full bg-[var(--color-surface-sunken)]"
            />
          ))}
        </div>
        {[0, 1, 2, 3].map((row) => (
          <div
            key={row}
            className="grid grid-cols-[minmax(0,1fr)_130px_120px_92px_40px] items-center gap-2 border-b border-[var(--color-border)] px-4 py-3.5"
          >
            <div className="space-y-1.5">
              <span className="block h-3.5 w-48 animate-pulse rounded bg-[var(--color-surface-sunken)]" />
              <span className="block h-3 w-24 animate-pulse rounded bg-[var(--color-surface-sunken)]" />
            </div>
            <span className="mx-auto h-7 w-20 animate-pulse rounded-lg bg-[var(--color-surface-sunken)]" />
            <span className="mx-auto h-8 w-[70px] animate-pulse rounded-lg bg-[var(--color-surface-sunken)]" />
            <span className="ml-auto h-6 w-14 animate-pulse rounded-full bg-[var(--color-surface-sunken)]" />
            <span />
          </div>
        ))}
      </Card>
    </div>
  );
}

function VariancePill({ variance }: { variance: number }): React.JSX.Element {
  return (
    <Badge tone={varianceTone(variance)} icon={null}>
      <span className="tabular font-mono font-bold">
        {variance > 0 ? '+' : ''}
        {variance}
      </span>
    </Badge>
  );
}

const FILTER_CHIPS: { key: CountFilter; label: string; active: string }[] = [
  { key: 'all', label: 'All', active: 'bg-[var(--color-brand)] border-[var(--color-brand)]' },
  {
    key: 'discrepancy',
    label: 'Discrepancy',
    active: 'bg-[var(--color-danger)] border-[var(--color-danger)]',
  },
  {
    key: 'untouched',
    label: 'Untouched',
    active: 'bg-[var(--color-warning)] border-[var(--color-warning)]',
  },
  {
    key: 'matched',
    label: 'Matched',
    active: 'bg-[var(--color-success)] border-[var(--color-success)]',
  },
];

/* ------------------------------------------------------------------- page */

export default function MultiCountPage(): React.JSX.Element {
  const { recheckId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user, settings } = useAuth();
  const [searchParams] = useSearchParams();

  const mode: Mode = searchParams.get('mode') === 'amend' ? 'amend' : 'count';
  const amendIds = useMemo(() => {
    const raw = searchParams.get('ids');
    return raw === null ? [] : raw.split(',').filter((value) => value.length > 0);
  }, [searchParams]);

  const [scanValue, setScanValue] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CountFilter>('all');
  const [submitOpen, setSubmitOpen] = useState(false);
  /* Releasing throws away a count that exists nowhere else (section 2.3), so it
     asks first rather than acting on a single click of a small × . */
  const [releaseTarget, setReleaseTarget] = useState<CountRow | null>(null);

  /**
   * Rows ticked for a bulk action.
   *
   * Ids rather than rows, so a refetch that changes a row's counted quantity or
   * state does not leave a stale copy pinned in the selection.
   *
   * An EMPTY selection means "all rows", which keeps the existing one-button
   * "Submit N counts" behaviour intact for anyone who never ticks anything.
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const toggleSelected = useCallback((itemId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);
  const [amendReason, setAmendReason] = useState('');
  // Explicitly nullable so the ref CALLBACK can assign to `.current`; the
  // `useRef<HTMLInputElement>(null)` form types `current` as read-only.
  const scanRef = useRef<HTMLInputElement | null>(null);

  const feedback = useScannerFeedback({
    soundEnabled: settings?.scannerSoundEnabled ?? true,
    successSound: true,
    errorSound: true,
    successFlash: true,
    errorFlash: true,
  });

  /* ------------------------------------------------------------- queries */

  const itemsQuery = useQuery({
    queryKey: ['recheck', recheckId, 'count-session', mode, amendIds.join(',')],
    queryFn: () =>
      apiRequest<ItemsResponse>(`/api/rechecks/${recheckId}/items`, {
        searchParams:
          mode === 'count'
            ? { onlyMine: 'true', workflowStatus: 'counting_in_progress', pageSize: 200 }
            : // Ask for exactly the selected rows. Requesting one page of
              // submitted items and filtering locally meant anything beyond
              // that page resolved to nothing and the editor opened empty.
              {
                workflowStatus: 'submitted',
                ids: amendIds.join(','),
                pageSize: Math.max(1, amendIds.length),
              },
      }),
  });

  const scannablesQuery = useQuery({
    queryKey: ['recheck', recheckId, 'scannables'],
    queryFn: () => apiRequest<{ items: ScannableItem[] }>(`/api/rechecks/${recheckId}/scannables`),
    staleTime: 60_000,
  });

  /*
   * In amend mode the API has no "these specific ids" filter, so the submitted
   * page is narrowed here. Falling back to every submitted item when no ids are
   * supplied would silently reopen the whole recheck for editing.
   */
  const sessionItems = useMemo(() => {
    const all = itemsQuery.data?.items ?? [];
    if (mode === 'count') return all.filter((item) => item.isClaimedByMe);
    const wanted = new Set(amendIds);
    return all.filter((item) => wanted.has(item.id));
  }, [itemsQuery.data, mode, amendIds]);

  const sessionKeys: SessionItemKey[] = useMemo(
    () =>
      sessionItems.map((item) => ({
        itemId: item.id,
        normalizedSku: toNormalizedSku(item.sku),
        claimVersion: item.claimVersion,
      })),
    [sessionItems],
  );

  const local = useLocalCountMap({
    userId: user?.id ?? '',
    recheckId,
    items: sessionKeys,
    enabled: user !== null && mode === 'count',
  });

  /*
   * Amend mode seeds each field from the quantity already on record — the
   * operator is correcting a number, not counting from zero — and keeps it in
   * plain component state, because a submitted item has no claim and therefore
   * no claim version to key a local draft against (section 22).
   */
  const [amendCounts, setAmendCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const amendSeeded = useRef(false);
  useEffect(() => {
    if (mode !== 'amend' || amendSeeded.current || sessionItems.length === 0) return;
    amendSeeded.current = true;
    setAmendCounts(new Map(sessionItems.map((item) => [item.id, item.countedQuantity ?? 0])));
  }, [mode, sessionItems]);

  const countOf = useCallback(
    (itemId: string): number =>
      mode === 'count' ? local.countOf(itemId) : (amendCounts.get(itemId) ?? 0),
    [mode, local, amendCounts],
  );

  const applyCount = useCallback(
    (key: SessionItemKey, next: number): void => {
      if (mode === 'count') {
        local.setCount(key, next);
        return;
      }
      setAmendCounts((current) => {
        const copy = new Map(current);
        copy.set(key.itemId, Math.max(0, next));
        return copy;
      });
    },
    [mode, local],
  );

  const adjustCount = useCallback(
    (key: SessionItemKey, delta: number): void => {
      if (mode === 'count') {
        local.adjust(key, delta);
        return;
      }
      setAmendCounts((current) => {
        const copy = new Map(current);
        copy.set(key.itemId, Math.max(0, (current.get(key.itemId) ?? 0) + delta));
        return copy;
      });
    },
    [mode, local],
  );

  /* --------------------------------------------------------------- rows */

  const rows: CountRow[] = useMemo(
    () =>
      sessionItems.map((item) => {
        const expected = item.zohoStock ?? 0;
        const counted = countOf(item.id);
        return {
          itemId: item.id,
          itemName: item.itemName,
          sku: item.sku,
          normalizedSku: toNormalizedSku(item.sku),
          expected,
          counted,
          state: countRowState(counted, expected),
          variance: countVariance(counted, expected),
        };
      }),
    [sessionItems, countOf],
  );

  /*
   * Lease countdown for this counting session — section 20.
   *
   * The session holds several claims, each with its own expiry, so the SOONEST
   * one is shown: that is the first work at risk, and a timer showing the
   * healthiest claim would be reassuring right up until an item was lost.
   *
   * A local 1s tick, not a network poll — nothing is requested by this.
   */
  const soonestClaimExpiry = useMemo(() => {
    if (mode !== 'count') return null;
    const expiries = sessionItems
      .filter((item) => item.isClaimedByMe && item.claimExpiresAt !== null)
      .map((item) => new Date(item.claimExpiresAt as string).getTime())
      .filter((time) => Number.isFinite(time));
    return expiries.length === 0 ? null : new Date(Math.min(...expiries)).toISOString();
  }, [sessionItems, mode]);

  const [leaseSecondsRemaining, setLeaseSecondsRemaining] = useState(0);

  useEffect(() => {
    if (soonestClaimExpiry === null) {
      setLeaseSecondsRemaining(0);
      return;
    }
    const update = (): void =>
      setLeaseSecondsRemaining(claimSecondsRemaining(soonestClaimExpiry));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [soonestClaimExpiry]);

  const leaseExpired = soonestClaimExpiry !== null && leaseSecondsRemaining <= 0;
  const leaseTone = leaseHealth(leaseSecondsRemaining, settings?.claimLeaseSeconds ?? 900);

  /** The rows an action applies to: the ticked ones, or all when none are. */
  const targetRows = useMemo(
    () => (selectedIds.size === 0 ? rows : rows.filter((row) => selectedIds.has(row.itemId))),
    [rows, selectedIds],
  );
  const hasSelection = selectedIds.size > 0;

  // Drop ids whose rows have gone (submitted, released, or claim lost), so the
  // count beside an action can never exceed what it would actually act on.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const live = new Set(rows.map((row) => row.itemId));
      const next = new Set([...current].filter((id) => live.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rows]);

  const totals = useMemo(() => countTotals(rows), [rows]);
  /** Totals for what the confirm dialog is actually about to write. */
  const targetTotals = useMemo(() => countTotals(targetRows), [targetRows]);
  const visible = useMemo(() => visibleCountRows(rows, filter), [rows, filter]);

  const keyByItemId = useMemo(
    () => new Map(sessionKeys.map((key) => [key.itemId, key])),
    [sessionKeys],
  );

  /* --------------------------------------------------------------- scan */

  const sessionIndex = useMemo(
    () => new Map(rows.map((row) => [row.normalizedSku, { itemId: row.itemId }])),
    [rows],
  );
  const recheckIndex = useMemo(
    () =>
      new Map(
        (scannablesQuery.data?.items ?? []).map((item) => [
          item.normalizedSku,
          { itemName: item.itemName },
        ]),
      ),
    [scannablesQuery.data],
  );

  /*
   * ===================== THE SCAN BOX OWNS THE KEYBOARD =====================
   * A hardware scanner is just a keyboard that types very fast and presses
   * Enter. If the caret is anywhere else, a scan is silently typed into that
   * control instead — into a quantity field, or nowhere at all — and the
   * operator does not find out until the totals are wrong. So the input takes
   * focus on arrival and takes it back whenever nothing else genuinely needs it.
   * =========================================================================
   */

  const submitOpenRef = useRef(submitOpen);
  submitOpenRef.current = submitOpen;

  const refocusScanner = useCallback(() => {
    // Never fight the dialog's focus trap.
    if (submitOpenRef.current) return;
    scanRef.current?.focus();
  }, []);

  /*
   * Focus on ARRIVAL via a ref callback rather than an effect.
   *
   * The page early-returns a spinner while the item query is pending, so the
   * input does not exist during the first render pass; a mount effect would run
   * against a null ref and silently do nothing, which is why landing here from
   * "Claim" or "Resume counting" left the caret nowhere. A ref callback fires
   * exactly when the element attaches, whenever that turns out to be.
   */
  const attachScanner = useCallback((node: HTMLInputElement | null) => {
    scanRef.current = node;
    node?.focus();
  }, []);

  /* Coming back from another tab or window should not cost the operator a
     click before the next scan registers. */
  useEffect(() => {
    const onWindowFocus = (): void => refocusScanner();
    window.addEventListener('focus', onWindowFocus);
    return () => window.removeEventListener('focus', onWindowFocus);
  }, [refocusScanner]);

  /* The confirm dialog restores focus to the button that opened it; pull it
     back to the scanner once the dialog is gone. */
  useEffect(() => {
    if (submitOpen) return;
    const timer = setTimeout(() => refocusScanner(), 0);
    return () => clearTimeout(timer);
  }, [submitOpen, refocusScanner]);

  const commitScan = useCallback(
    (raw: string) => {
      const outcome = resolveSessionScan(toNormalizedSku(raw), sessionIndex, recheckIndex);

      if (outcome.kind === 'empty') return;

      if (outcome.kind === 'valid') {
        const key = keyByItemId.get(outcome.itemId);
        if (key !== undefined) adjustCount(key, 1);
        setScanError(null);
        setScanValue('');
        feedback.signal('success');
        return;
      }

      setScanError(
        outcome.kind === 'not_in_session'
          ? `[${outcome.normalizedSku}] ${outcome.itemName} ${SCAN_NOT_IN_SESSION_MESSAGE}`
          : `[${outcome.normalizedSku}] ${SCAN_UNKNOWN_MESSAGE}`,
      );
      feedback.signal('error');
    },
    [sessionIndex, recheckIndex, keyByItemId, adjustCount, feedback],
  );

  /* ------------------------------------------------------------ mutations */

  const releaseMutation = useMutation({
    mutationFn: (itemId: string) =>
      apiRequest(`/api/rechecks/${recheckId}/items/${itemId}/release`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: async (_result, itemId) => {
      local.discard(itemId);
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
      // Held open until the server confirms, so the button can show progress.
      setReleaseTarget(null);
      toast.push({ tone: 'muted', title: 'Item released' });
    },
    onError: (error) => {
      // Deliberately leaves the dialog open: closing it would hide the retry
      // behind another hunt for the right row.
      toast.push({
        tone: 'danger',
        title: 'Could not release the item',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  /**
   * Releases every ticked row, one request per item.
   *
   * Sequential and per-item for the same reason as submission: each release
   * takes a row lock, and a partial failure has to name the rows that survived
   * rather than collapsing into one opaque error. A row that fails stays
   * claimed, which is the safe direction — the operator keeps the item.
   */
  const bulkReleaseMutation = useMutation({
    mutationFn: async (targets: readonly CountRow[]) => {
      const succeeded: string[] = [];
      const failed: { itemName: string; message: string }[] = [];

      for (const row of targets) {
        try {
          await apiRequest(`/api/rechecks/${recheckId}/items/${row.itemId}/release`, {
            method: 'POST',
            body: {},
          });
          succeeded.push(row.itemId);
        } catch (error) {
          failed.push({
            itemName: row.itemName,
            message: error instanceof ApiError ? error.message : 'Unexpected error.',
          });
        }
      }
      return { succeeded, failed };
    },
    onSuccess: async ({ succeeded, failed }) => {
      // The local count for a released item is dropped: the claim is gone, so
      // it could never be submitted (section 22).
      for (const itemId of succeeded) local.discard(itemId);
      setSelectedIds(new Set());
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });

      toast.push(
        failed.length === 0
          ? {
              tone: 'muted',
              title: `${succeeded.length} item${succeeded.length === 1 ? '' : 's'} released`,
            }
          : {
              tone: 'warning',
              title: `${succeeded.length} released, ${failed.length} failed`,
              description: `${failed[0]?.itemName}: ${failed[0]?.message}`,
            },
      );
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Could not release the selected items',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  /**
   * Submits (or amends) every row, one request per item.
   *
   * Sequential rather than parallel: each carries its own idempotency key and
   * the server takes a row lock per item, so firing 50 at once buys nothing and
   * makes a partial failure much harder to report accurately.
   */
  const submitMutation = useMutation({
    mutationFn: async () => {
      const succeeded: string[] = [];
      const failed: { itemName: string; message: string }[] = [];

      for (const row of targetRows) {
        const item = sessionItems.find((candidate) => candidate.id === row.itemId);
        if (item === undefined) continue;
        try {
          if (mode === 'count') {
            await apiRequest(`/api/rechecks/${recheckId}/items/${row.itemId}/submit`, {
              method: 'POST',
              body: {
                countedQuantity: row.counted,
                claimVersion: item.claimVersion,
                idempotencyKey: newIdempotencyKey(),
              },
            });
          } else {
            await apiRequest(`/api/rechecks/${recheckId}/items/${row.itemId}/amend`, {
              method: 'POST',
              body: {
                countedQuantity: row.counted,
                reason: amendReason,
                idempotencyKey: newIdempotencyKey(),
              },
            });
          }
          succeeded.push(row.itemId);
        } catch (error) {
          failed.push({
            itemName: row.itemName,
            message: error instanceof ApiError ? error.message : 'Unexpected error.',
          });
        }
      }

      // Captured here, not read in onSuccess: by then the selection has been
      // cleared and the answer would always be "everything".
      return { succeeded, failed, coveredEverything: targetRows.length === rows.length };
    },
    onSuccess: async ({ succeeded, failed, coveredEverything }) => {
      for (const itemId of succeeded) local.discard(itemId);
      setSubmitOpen(false);
      setSelectedIds(new Set());
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });

      // Submitting only part of the session leaves work on this screen, so stay
      // put; leaving would strand the rows the operator did not pick.
      if (failed.length === 0 && !coveredEverything) {
        toast.push({
          tone: 'success',
          title: `${succeeded.length} count${succeeded.length === 1 ? '' : 's'} submitted`,
        });
        return;
      }

      if (failed.length === 0) {
        toast.push({
          tone: 'success',
          title:
            mode === 'count'
              ? `${succeeded.length} count${succeeded.length === 1 ? '' : 's'} submitted`
              : `${succeeded.length} count${succeeded.length === 1 ? '' : 's'} corrected`,
        });
        navigate(`/app/rechecks/${recheckId}/workspace`);
        return;
      }

      toast.push({
        tone: 'warning',
        title: `${succeeded.length} saved, ${failed.length} failed`,
        description: `${failed[0]?.itemName}: ${failed[0]?.message}`,
      });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Submission failed',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  /* ---------------------------------------------------------- heartbeat */

  const heartbeatSeconds = settings?.heartbeatSeconds ?? 30;
  useEffect(() => {
    if (mode !== 'count' || sessionItems.length === 0) return;

    /*
     * One heartbeat per claimed item per interval. Section 20 requires each
     * lease to be extended individually; a session-wide heartbeat would keep
     * items alive that the operator had already released elsewhere.
     */
    const beat = async (): Promise<void> => {
      await Promise.allSettled(
        sessionItems.map((item) =>
          apiRequest(`/api/rechecks/${recheckId}/items/${item.id}/heartbeat`, {
            method: 'POST',
            body: { claimVersion: item.claimVersion },
          }),
        ),
      );
    };

    const timer = setInterval(() => void beat(), heartbeatSeconds * 1000);
    return () => clearInterval(timer);
  }, [mode, sessionItems, recheckId, heartbeatSeconds]);

  /* ------------------------------------------------------------- render */

  /*
   * `isPending` alone is not enough. It is false whenever React Query holds a
   * cached result, so arriving here a second time rendered the PREVIOUS
   * (usually empty) session while the refetch was still in flight — the
   * operator claimed items and was told "You are not counting anything yet",
   * and the rows appeared a moment later. Treat "fetching with nothing to
   * show" as loading too.
   */
  const sessionLoading =
    itemsQuery.isPending || (itemsQuery.isFetching && sessionItems.length === 0);

  if (itemsQuery.error !== null) {
    return (
      <ErrorState
        message={
          itemsQuery.error instanceof ApiError
            ? itemsQuery.error.message
            : 'This count could not be loaded.'
        }
        action={<LinkButton to={`/app/rechecks/${recheckId}/workspace`}>Back to workspace</LinkButton>}
      />
    );
  }

  const isAdmin = user !== null && isAdministrator(user.role);
  const canSave = mode === 'count' || isAdmin;
  const amendReasonValid = mode === 'count' || amendReason.trim().length >= 3;

  return (
    <div
      className="space-y-4"
      onClick={(event) => {
        /*
         * Clicking dead space returns the caret to the scanner. Clicking a real
         * control does not: an unconditional refocus here bounced focus out of
         * the quantity fields the instant they were clicked, so they could not
         * be typed into at all.
         */
        if ((event.target as HTMLElement).closest('input, select, textarea, button, a')) return;
        refocusScanner();
      }}
    >
      {/* ------------------------------------------------------- toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className="brand-gradient flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-[0_2px_8px_rgba(37,99,235,0.32)]"
        >
          <PackageIcon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">
              {mode === 'count' ? 'Stock Count' : 'Correct Submitted Counts'}
            </h2>
            {/*
              Claim countdown. Expiry is announced as text beside the timer
              rather than a dialog: a modal here would land on top of the
              scanner mid-count and interrupt work that is still recoverable,
              since the heartbeat may yet renew the lease.
            */}
            {soonestClaimExpiry !== null && (
              <span className="flex items-center gap-2">
                <span
                  className={clsx(
                    'tabular rounded-lg px-2 py-0.5 text-sm font-semibold tracking-tight',
                    leaseTone === 'healthy' && 'bg-[var(--color-success-bg)] text-[var(--color-success)]',
                    leaseTone === 'expiring' && 'bg-[var(--color-warning-bg)] text-[var(--color-warning)]',
                    leaseTone === 'expired' && 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
                  )}
                  title="Time left on your claim. It renews automatically while this screen is open."
                >
                  {formatLeaseRemaining(leaseSecondsRemaining)}
                </span>
                {leaseExpired && (
                  <span
                    role="status"
                    className="text-sm font-semibold text-[var(--color-danger)]"
                  >
                    Timer expired
                  </span>
                )}
              </span>
            )}
          </div>
          <p className="text-sm text-[var(--color-ink-muted)]">
            {sessionLoading
              ? 'Loading your count…'
              : totals.items === 0
                ? 'No items in this count'
                : `${totals.items} item${totals.items === 1 ? '' : 's'} in this count`}
          </p>
        </div>
        <LinkButton
          to={`/app/rechecks/${recheckId}/workspace`}
          variant="secondary"
          icon={<ArrowLeftIcon size={15} />}
        >
          Workspace
        </LinkButton>
        {mode === 'count' && (
          <LinkButton
            to={`/app/rechecks/${recheckId}/workspace?status=available`}
            variant="primary"
            icon={<PlusIcon size={15} />}
          >
            Add Items
          </LinkButton>
        )}
      </div>

      {sessionLoading ? (
        <CountSessionSkeleton />
      ) : totals.items === 0 ? (
        <Card className="space-y-3 py-10 text-center">
          <p className="text-sm text-[var(--color-ink-muted)]">
            {mode === 'count'
              ? 'You are not counting anything yet. Claim items in the workspace to start.'
              : 'No submitted items were selected for correction.'}
          </p>
          <LinkButton variant="primary" to={`/app/rechecks/${recheckId}/workspace`}>
            Go to the workspace
          </LinkButton>
        </Card>
      ) : (
        <>
          {/* ------------------------------------------------- progress */}
          <Card>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <span className="text-xs font-bold uppercase tracking-wide text-[var(--color-ink-muted)]">
                Count progress
              </span>
              <span className="text-sm">
                <strong className="tabular text-base">{totals.counted}</strong>{' '}
                <span className="text-[var(--color-ink-subtle)]">of</span>{' '}
                <strong className="tabular">{totals.expected}</strong>{' '}
                <span className="text-[var(--color-ink-subtle)]">pieces</span>
              </span>
            </div>
            <div
              role="progressbar"
              aria-valuenow={totals.counted}
              aria-valuemin={0}
              aria-valuemax={totals.expected}
              aria-label="Count progress"
              className="h-2.5 w-full overflow-hidden rounded-full bg-[#E6EBF2]"
            >
              <div
                className="h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${totals.percentage}%`,
                  background: 'linear-gradient(90deg, #2D74F0, #16A34A)',
                }}
              />
            </div>
          </Card>

          {/* ----------------------------------------------------- scan */}
          <Card>
            <label
              htmlFor="scan-input"
              className="text-xs font-bold uppercase tracking-wide text-[var(--color-ink-muted)]"
            >
              Scan item
            </label>
            <div className="mt-2.5 flex gap-2.5">
              <div className="relative flex-1">
                <BarcodeMark tone={scanError !== null ? 'error' : 'idle'} />
                <input
                  id="scan-input"
                  ref={attachScanner}
                  value={scanValue}
                  onChange={(event) => setScanValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return;
                    event.preventDefault();
                    commitScan(scanValue);
                  }}
                  onBlur={(event) => {
                    /*
                     * Reclaim focus only when it went NOWHERE — a click on dead
                     * space, or the browser dropping it. `relatedTarget` names
                     * the element that took over, so a deliberate move to a
                     * quantity field or a button is left alone.
                     */
                    if (event.relatedTarget !== null) return;
                    setTimeout(() => refocusScanner(), 0);
                  }}
                  placeholder="Point the scanner and pull the trigger"
                  autoComplete="off"
                  autoFocus
                  className={clsx(
                    'w-full rounded-[10px] border-[1.5px] bg-[var(--color-surface)] py-3 pl-11 pr-3.5 font-mono text-lg text-[var(--color-ink)] outline-none',
                    scanError !== null
                      ? 'border-[var(--color-danger)]'
                      : 'border-[var(--color-border-strong)] focus:border-[var(--color-brand)]',
                    feedback.flash === 'success' && 'scan-flash-success',
                    feedback.flash === 'error' && 'scan-flash-error',
                  )}
                />
              </div>
              <Button
                onClick={() => {
                  setScanValue('');
                  setScanError(null);
                  refocusScanner();
                }}
              >
                Clear
              </Button>
            </div>
            {scanError !== null && (
              <div className="mt-2.5">
                <InlineNotice tone="danger">{scanError}</InlineNotice>
              </div>
            )}
          </Card>

          {/* -------------------------------------------- filters + table */}
          <Card className="overflow-hidden p-0">
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] p-3.5">
              {FILTER_CHIPS.map((chip) => {
                const count =
                  chip.key === 'all'
                    ? totals.items
                    : chip.key === 'discrepancy'
                      ? totals.discrepancy
                      : chip.key === 'untouched'
                        ? totals.untouched
                        : totals.matched;
                const active = filter === chip.key;
                return (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => {
                      setFilter(chip.key);
                      refocusScanner();
                    }}
                    aria-pressed={active}
                    className={clsx(
                      'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors',
                      active
                        ? clsx(chip.active, 'font-semibold text-white')
                        : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-row-hover)]',
                    )}
                  >
                    {chip.label}
                    <span
                      className={clsx(
                        'tabular min-w-[18px] rounded-full px-1.5 text-center text-xs font-bold',
                        active
                          ? 'bg-white/25 text-white'
                          : 'bg-[var(--color-neutral-bg)] text-[var(--color-ink-muted)]',
                      )}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* header row */}
            <div className="grid grid-cols-[32px_minmax(0,1fr)_130px_120px_92px_40px] gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-raised)] px-4 py-2.5 text-[11px] font-bold uppercase tracking-wide text-[var(--color-ink-subtle)]">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  aria-label={
                    visible.every((row) => selectedIds.has(row.itemId)) && visible.length > 0
                      ? 'Clear selection'
                      : 'Select all shown items'
                  }
                  className="h-4 w-4 cursor-pointer accent-[var(--color-brand)]"
                  checked={visible.length > 0 && visible.every((row) => selectedIds.has(row.itemId))}
                  // Some shown rows ticked, but not all.
                  ref={(node) => {
                    if (node !== null) {
                      node.indeterminate =
                        visible.some((row) => selectedIds.has(row.itemId)) &&
                        !visible.every((row) => selectedIds.has(row.itemId));
                    }
                  }}
                  onChange={(event) => {
                    // Scoped to the VISIBLE rows, so a filter chip cannot
                    // silently select rows the operator cannot see.
                    const shown = visible.map((row) => row.itemId);
                    setSelectedIds((current) => {
                      const next = new Set(current);
                      if (event.target.checked) for (const id of shown) next.add(id);
                      else for (const id of shown) next.delete(id);
                      return next;
                    });
                  }}
                />
              </div>
              <div>Item / SKU</div>
              <div className="text-center">Counted / Exp</div>
              <div className="text-center">Adjust</div>
              <div className="text-right">Variance</div>
              <div />
            </div>

            <ul className="max-h-[520px] overflow-y-auto">
              {visible.map((row) => {
                const key = keyByItemId.get(row.itemId);
                if (key === undefined) return null;
                const accent =
                  row.state === 'matched'
                    ? 'border-l-[var(--color-success)]'
                    : row.state === 'untouched'
                      ? 'border-l-transparent'
                      : row.variance > 0
                        ? 'border-l-[var(--color-danger)]'
                        : 'border-l-[var(--color-warning)]';
                return (
                  <li
                    key={row.itemId}
                    className={clsx(
                      'animate-row-in grid grid-cols-[32px_minmax(0,1fr)_130px_120px_92px_40px] items-center gap-2 border-b border-l-[3px] border-[var(--color-border)] px-4 py-3 transition-colors hover:bg-[var(--color-row-hover)]',
                      accent,
                    )}
                  >
                    <div className="flex items-center">
                      <input
                        type="checkbox"
                        aria-label={`Select ${row.itemName}`}
                        className="h-4 w-4 cursor-pointer accent-[var(--color-brand)]"
                        checked={selectedIds.has(row.itemId)}
                        onChange={() => toggleSelected(row.itemId)}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{row.itemName}</div>
                      <div className="font-mono text-xs text-[var(--color-ink-muted)]">
                        [{row.sku}]
                      </div>
                    </div>

                    <div className="flex items-center justify-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={row.counted}
                        onChange={(event) => applyCount(key, Number(event.target.value))}
                        onKeyDown={(event) => {
                          // Enter means "done with this field", not "submit".
                          if (event.key !== 'Enter') return;
                          event.preventDefault();
                          refocusScanner();
                        }}
                        aria-label={`Counted quantity for ${row.itemName}`}
                        className="tabular w-14 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] py-1 text-center text-[15px] font-semibold outline-none focus:border-[var(--color-brand)]"
                      />
                      <span className="text-sm text-[var(--color-ink-subtle)]">/ {row.expected}</span>
                    </div>

                    <div className="flex items-center justify-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          adjustCount(key, -1);
                          refocusScanner();
                        }}
                        aria-label={`Decrease ${row.itemName} by one`}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-lg leading-none hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-subtle)] hover:text-[var(--color-brand)]"
                      >
                        −
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          adjustCount(key, 1);
                          refocusScanner();
                        }}
                        aria-label={`Increase ${row.itemName} by one`}
                        className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] text-lg leading-none hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-subtle)] hover:text-[var(--color-brand)]"
                      >
                        +
                      </button>
                    </div>

                    <div className="flex justify-end">
                      <VariancePill variance={row.variance} />
                    </div>

                    <div className="flex justify-center">
                      {mode === 'count' && (
                        <button
                          type="button"
                          onClick={() => setReleaseTarget(row)}
                          aria-label={`Release ${row.itemName} and remove it from this count`}
                          title="Release this item"
                          className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[var(--color-danger)] hover:bg-[var(--color-danger)] hover:text-white"
                        >
                          <CloseIcon size={13} strokeWidth={2.5} />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}

              {visible.length === 0 && (
                <li className="flex flex-col items-center gap-3 px-6 py-12 text-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-raised)] text-[var(--color-ink-subtle)]">
                    <SearchIcon size={22} />
                  </span>
                  <p className="text-sm text-[var(--color-ink-muted)]">No items in this view.</p>
                </li>
              )}
            </ul>
          </Card>

          {/* --------------------------------------------------- save bar */}
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-[var(--color-ink-muted)]">
              {mode === 'count' ? (
                <>
                  Counts stay on this device until you submit.{' '}
                  <strong className="tabular text-[var(--color-ink)]">{totals.untouched}</strong>{' '}
                  still untouched.
                </>
              ) : (
                <>
                  Correcting <strong className="tabular text-[var(--color-ink)]">{totals.items}</strong>{' '}
                  submitted count{totals.items === 1 ? '' : 's'}. A written reason is required.
                </>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {/*
                Release is offered only for a real selection. With nothing
                ticked "release" would mean the whole session, which is a far
                more destructive reading of an empty selection than submit's.
              */}
              {mode === 'count' && hasSelection && (
                <Button
                  size="lg"
                  onClick={() => bulkReleaseMutation.mutate(targetRows)}
                  loading={bulkReleaseMutation.isPending}
                  loadingText="Releasing…"
                  disabled={submitMutation.isPending}
                >
                  {`Release ${targetRows.length}`}
                </Button>
              )}
              <Button
                variant="primary"
                size="lg"
                disabled={!canSave || bulkReleaseMutation.isPending || targetRows.length === 0}
                onClick={() => setSubmitOpen(true)}
              >
                {mode === 'count'
                  ? `Submit ${targetRows.length} count${targetRows.length === 1 ? '' : 's'}`
                  : `Save ${targetRows.length} correction${targetRows.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </Card>

          {!canSave && (
            <InlineNotice tone="warning">
              Only an administrator can correct a count that has already been submitted.
            </InlineNotice>
          )}
        </>
      )}

      {/* ------------------------------------------------- release dialog */}
      <Dialog
        open={releaseTarget !== null}
        tone="warning"
        title="Release this item?"
        description={
          releaseTarget === null ? undefined : (
            <>
              <strong>{releaseTarget.itemName}</strong> goes back to Available for anyone to
              count.
              {releaseTarget.counted > 0 && (
                <>
                  {' '}
                  The <strong className="tabular">{releaseTarget.counted}</strong> counted here is
                  held only on this device and has never been submitted, so releasing{' '}
                  <strong>discards it</strong>.
                </>
              )}
            </>
          )
        }
        onClose={() => {
          // Ignore dismissals while the request is in flight, so the dialog
          // cannot vanish mid-release and leave the outcome unreported.
          if (releaseMutation.isPending) return;
          setReleaseTarget(null);
        }}
        footer={
          <>
            <Button
              disabled={releaseMutation.isPending}
              onClick={() => setReleaseTarget(null)}
            >
              Keep counting it
            </Button>
            <Button
              variant="danger"
              loading={releaseMutation.isPending}
              loadingText="Releasing…"
              onClick={() => {
                if (releaseTarget !== null) releaseMutation.mutate(releaseTarget.itemId);
              }}
            >
              Release item
            </Button>
          </>
        }
      />

      {/* ------------------------------------------------- confirm dialog */}
      <Dialog
        open={submitOpen}
        tone={mode === 'count' ? 'neutral' : 'warning'}
        title={mode === 'count' ? 'Submit these counts?' : 'Save these corrections?'}
        description={
          <>
            {targetTotals.items} item{targetTotals.items === 1 ? '' : 's'} ·{' '}
            {targetTotals.counted} pieces counted against {targetTotals.expected} expected.{' '}
            {targetTotals.discrepancy > 0 && (
              <strong>
                {targetTotals.discrepancy} row{targetTotals.discrepancy === 1 ? '' : 's'} differ
                from Zoho.
              </strong>
            )}{' '}
            {mode === 'count' && targetTotals.untouched > 0 && (
              <>
                {targetTotals.untouched} row{targetTotals.untouched === 1 ? '' : 's'} would be
                submitted as zero.
              </>
            )}{' '}
            {hasSelection && (
              <>
                The remaining {rows.length - targetRows.length} row
                {rows.length - targetRows.length === 1 ? '' : 's'} stay claimed and uncounted.
              </>
            )}
          </>
        }
        onClose={() => setSubmitOpen(false)}
        footer={
          <>
            <Button onClick={() => setSubmitOpen(false)}>Back</Button>
            <Button
              variant="primary"
              loading={submitMutation.isPending}
              loadingText="Saving…"
              disabled={!amendReasonValid}
              onClick={() => submitMutation.mutate()}
            >
              {mode === 'count'
                ? hasSelection
                  ? `Submit ${targetRows.length}`
                  : 'Submit all'
                : 'Save corrections'}
            </Button>
          </>
        }
      >
        {mode === 'amend' && (
          <Field
            label="Reason"
            hint="Recorded against every corrected item in the audit log."
            required
          >
            {({ inputId, describedBy }) => (
              <TextInput
                id={inputId}
                aria-describedby={describedBy}
                value={amendReason}
                onChange={(event) => setAmendReason(event.target.value)}
                placeholder="e.g. Recount after the shelf was re-checked"
              />
            )}
          </Field>
        )}
      </Dialog>
    </div>
  );
}
