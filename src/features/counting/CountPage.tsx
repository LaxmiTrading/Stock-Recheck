/**
 * Screen 9: counting and scanning — specification sections 21, 22, 23.
 *
 * This is the primary operational screen and is optimized for speed:
 *   - the scanner input holds focus at all times, valid scan or not
 *   - a valid scan increments locally and clears the field
 *   - an invalid scan does NOT increment and does NOT clear the field; the bad
 *     value is selected so the next scan overwrites it
 *   - nothing reaches the server until "Submit Final Count"
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  claimSecondsRemaining,
  DRAFT_REJECTION_MESSAGE,
  formatLeaseRemaining,
  leaseHealth,
  validateLocalDraft,
  type DraftRejectionReason,
} from '@/domain/claims';
import { formatQuantity } from '@/domain/quantity';
import {
  evaluateScan,
  indexItemsByNormalizedSku,
  isScanSubmitKey,
  scanErrorAnnouncement,
  scanSuccessAnnouncement,
  type ScanOutcome,
} from '@/domain/scanning';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, apiRequest, newIdempotencyKey } from '@/services/api';
import { useLocalCount } from '@/hooks/useLocalCount';
import { useScannerFeedback } from '@/hooks/useScannerFeedback';
import { useUnsavedCountGuard } from '@/hooks/useUnsavedCountGuard';
import { useWakeLock } from '@/hooks/useWakeLock';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  ErrorState,
  InlineNotice,
  Spinner,
  TextInput,
  useToast,
} from '@/components/ui';

interface ItemDetail {
  id: string;
  recheckId: string;
  itemName: string;
  sku: string;
  normalizedSku: string;
  zohoStock: number | null;
  vendor: string | null;
  brand: string | null;
  manufacturer: string | null;
  unit: string | null;
  workflowStatus: 'available' | 'counting_in_progress' | 'submitted';
  resultStatus: 'pending' | 'matched' | 'mismatched';
  claimedBy: string | null;
  claimedByName: string | null;
  claimExpiresAt: string | null;
  claimVersion: number;
  isClaimedByMe: boolean;
  countedQuantity: number | null;
}

interface ItemResponse {
  item: ItemDetail;
  recheck: {
    id: string;
    recheckNumber: string;
    name: string;
    status: string;
    isReadOnly: boolean;
    stockBasisType: string;
    stockBasisName: string | null;
    zohoSnapshotAt: string;
  };
  blindCountEnabled: boolean;
}

interface ScannableItem {
  id: string;
  itemName: string;
  sku: string;
  normalizedSku: string;
}

export default function CountPage(): React.JSX.Element {
  const { recheckId = '', itemId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user, settings } = useAuth();

  const scannerRef = useRef<HTMLInputElement>(null);
  const [scanValue, setScanValue] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitConfirmed, setSubmitConfirmed] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [draftRejection, setDraftRejection] = useState<DraftRejectionReason | null>(null);
  const [secondsRemaining, setSecondsRemaining] = useState(0);
  const draftEvaluated = useRef(false);

  /* ------------------------------------------------------------- queries */

  const itemQuery = useQuery({
    queryKey: ['recheck', recheckId, 'item', itemId],
    queryFn: () => apiRequest<ItemResponse>(`/api/rechecks/${recheckId}/items/${itemId}`),
  });

  // The normalized-SKU index lets a wrong scan name the item it belongs to.
  const scannablesQuery = useQuery({
    queryKey: ['recheck', recheckId, 'scannables'],
    queryFn: () =>
      apiRequest<{ items: ScannableItem[] }>(`/api/rechecks/${recheckId}/scannables`),
    staleTime: 5 * 60_000,
  });

  const item = itemQuery.data?.item;
  const blindCount = itemQuery.data?.blindCountEnabled ?? false;

  const scannableIndex = useMemo(
    () => indexItemsByNormalizedSku(scannablesQuery.data?.items ?? []),
    [scannablesQuery.data?.items],
  );

  /* --------------------------------------------------------- local count */

  const localCount = useLocalCount({
    userId: user?.id ?? 'anonymous',
    recheckId,
    itemId,
    claimVersion: item?.claimVersion ?? 0,
    normalizedSku: item?.normalizedSku ?? '',
    enabled: user !== null && item !== undefined,
  });

  const feedback = useScannerFeedback({
    soundEnabled: settings?.scannerSoundEnabled ?? true,
    successSound: settings?.scannerSuccessSound ?? true,
    errorSound: settings?.scannerErrorSound ?? true,
    successFlash: settings?.scannerSuccessFlash ?? true,
    errorFlash: settings?.scannerErrorFlash ?? true,
  });

  useUnsavedCountGuard(localCount.count > 0);
  useWakeLock((settings?.scannerPreventSleep ?? true) && item?.isClaimedByMe === true);

  /* ------------------------------------------ restore a persisted draft */

  useEffect(() => {
    if (draftEvaluated.current) return;
    if (item === undefined || user === null || localCount.storedDraft === null) {
      // No draft to consider; mark evaluated once the item has loaded.
      if (item !== undefined) draftEvaluated.current = true;
      return;
    }
    draftEvaluated.current = true;

    // Section 22: every check must pass before a stored count is restored.
    const verdict = validateLocalDraft({
      draftUserId: localCount.storedDraft.userId,
      draftItemId: localCount.storedDraft.itemId,
      draftClaimVersion: localCount.storedDraft.claimVersion,
      draftNormalizedSku: localCount.storedDraft.normalizedSku,
      currentUserId: user.id,
      currentItemId: item.id,
      currentClaimVersion: item.claimVersion,
      currentNormalizedSku: item.normalizedSku,
      currentClaimOwnerId: item.claimedBy,
      claimExpiresAt: item.claimExpiresAt,
      isSubmitted: item.workflowStatus === 'submitted',
    });

    if (verdict.restorable) {
      localCount.restore(localCount.storedDraft.count);
      toast.push({
        tone: 'info',
        title: 'Local count restored',
        description: `Recovered a count of ${localCount.storedDraft.count} from this device.`,
      });
    } else {
      setDraftRejection(verdict.reason);
    }
  }, [item, user, localCount, toast]);

  /* -------------------------------------------------------- claim lease */

  useEffect(() => {
    if (item?.claimExpiresAt === null || item?.claimExpiresAt === undefined) return;
    const update = (): void => setSecondsRemaining(claimSecondsRemaining(item.claimExpiresAt));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [item?.claimExpiresAt]);

  /* --------------------------------------------------------- heartbeat */

  const heartbeatSeconds = settings?.heartbeatSeconds ?? 30;

  useEffect(() => {
    if (item === undefined || !item.isClaimedByMe || item.workflowStatus === 'submitted') return;

    let cancelled = false;
    const beat = async (): Promise<void> => {
      try {
        const result = await apiRequest<{ claimExpiresAt: string; claimVersion: number }>(
          `/api/rechecks/${recheckId}/items/${itemId}/heartbeat`,
          { method: 'POST', body: { claimVersion: item.claimVersion } },
        );
        if (!cancelled) setSecondsRemaining(claimSecondsRemaining(result.claimExpiresAt));
      } catch (error) {
        if (cancelled) return;
        // The claim is gone. Keep the local count (section 38) but stop
        // pretending the item is ours.
        toast.push({
          tone: 'danger',
          title: 'Your claim is no longer active',
          description:
            error instanceof ApiError
              ? error.message
              : 'Reclaim the item before submitting this count.',
        });
        void queryClient.invalidateQueries({ queryKey: ['recheck', recheckId, 'item', itemId] });
      }
    };

    const timer = setInterval(() => void beat(), heartbeatSeconds * 1000);
    // Section 20: heartbeats stop on release, submission or navigating away.
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [item, recheckId, itemId, heartbeatSeconds, queryClient, toast]);

  /* ------------------------------------------------------------ scanning */

  const focusScanner = useCallback(() => {
    scannerRef.current?.focus();
  }, []);

  useEffect(() => {
    // Autofocus on load (section 21).
    if (item !== undefined && item.isClaimedByMe) focusScanner();
  }, [item, focusScanner]);

  const processScan = useCallback(() => {
    if (item === undefined) return;

    const outcome: ScanOutcome = evaluateScan(
      scanValue,
      {
        id: item.id,
        itemName: item.itemName,
        sku: item.sku,
        normalizedSku: item.normalizedSku,
      },
      scannableIndex,
      { caseSensitive: settings?.skuCaseSensitive ?? false },
    );

    if (outcome.kind === 'empty') {
      // Section 21: an empty Enter press is ignored entirely.
      focusScanner();
      return;
    }

    if (outcome.kind === 'valid') {
      const next = localCount.increment();
      setScanValue('');
      setScanError(null);
      setAnnouncement(scanSuccessAnnouncement(next));
      feedback.signal('success');
      focusScanner();
      return;
    }

    // Invalid: do not increment, do not clear, select the bad value so the
    // next scan replaces it, keep focus (section 3.3).
    setScanError(outcome.message);
    setAnnouncement(scanErrorAnnouncement(outcome));
    feedback.signal('error');
    focusScanner();
    if (settings?.scannerAutoSelectInvalid ?? true) {
      requestAnimationFrame(() => scannerRef.current?.select());
    }
  }, [item, scanValue, scannableIndex, settings, localCount, feedback, focusScanner]);

  /* ---------------------------------------------------------- mutations */

  const submitKey = useMemo(() => newIdempotencyKey(), []);

  const submitMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ quantityDifference: number; resultStatus: string; recheckCompleted: boolean }>(
        `/api/rechecks/${recheckId}/items/${itemId}/submit`,
        {
          method: 'POST',
          body: {
            countedQuantity: localCount.count,
            claimVersion: item?.claimVersion ?? 0,
            idempotencyKey: submitKey,
          },
        },
      ),
    onSuccess: async (result) => {
      // Only NOW is the local draft safe to delete (section 23).
      localCount.discard();
      setSubmitOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
      if (result.recheckCompleted) {
        toast.push({
          tone: 'success',
          title: 'Stock Recheck complete',
          description: 'Every item has now been submitted.',
        });
      }
      navigate(`/app/rechecks/${recheckId}/items/${itemId}/submitted`, { replace: true });
    },
    onError: (error) => {
      // Section 23: on failure the local draft is KEPT and we never assume the
      // submission succeeded.
      toast.push({
        tone: 'danger',
        title: 'Submission failed',
        description:
          error instanceof ApiError
            ? `${error.message} Your count of ${localCount.count} is still saved on this device.`
            : `Your count of ${localCount.count} is still saved on this device. Try again.`,
      });
    },
  });

  const releaseMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/rechecks/${recheckId}/items/${itemId}/release`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: async () => {
      localCount.discard();
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
      navigate(`/app/rechecks/${recheckId}/workspace`);
    },
  });

  const reclaimMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/rechecks/${recheckId}/items/${itemId}/claim`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: async () => {
      setDraftRejection(null);
      draftEvaluated.current = false;
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId, 'item', itemId] });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Could not reclaim this item',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  /* -------------------------------------------------------------- render */

  if (itemQuery.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} label="Loading item" />
      </div>
    );
  }

  if (itemQuery.error !== null || item === undefined || itemQuery.data === undefined) {
    return (
      <ErrorState
        title="This item could not be loaded"
        message={
          itemQuery.error instanceof ApiError ? itemQuery.error.message : 'It may have been removed.'
        }
        correlationId={
          itemQuery.error instanceof ApiError ? itemQuery.error.correlationId : undefined
        }
        action={
          <Button variant="primary" onClick={() => navigate(`/app/rechecks/${recheckId}/workspace`)}>
            Back to workspace
          </Button>
        }
      />
    );
  }

  const { recheck } = itemQuery.data;
  const health = leaseHealth(secondsRemaining, settings?.claimLeaseSeconds ?? 900);
  const ownsClaim = item.isClaimedByMe && item.workflowStatus === 'counting_in_progress';

  return (
    <div className="mx-auto max-w-3xl space-y-4 pb-32">
      {/* ---------------------------------------------------------- header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          size="sm"
          onClick={() => {
            if (localCount.count > 0) setLeaveOpen(true);
            else navigate(`/app/rechecks/${recheckId}/workspace`);
          }}
        >
          ← Back to Recheck
        </Button>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono text-[var(--color-ink-subtle)]">{recheck.recheckNumber}</span>
          {ownsClaim && (
            <Badge tone={health === 'healthy' ? 'success' : health === 'expiring' ? 'warning' : 'danger'}>
              Claim {formatLeaseRemaining(secondsRemaining)}
            </Badge>
          )}
          <span className="text-[var(--color-ink-subtle)]">{user?.displayName}</span>
        </div>
      </div>

      {/* --------------------------------------- expired / lost claim state */}
      {draftRejection !== null && (
        <Card className="space-y-3 border-[var(--color-warning)] bg-[var(--color-warning-bg)]">
          <h3 className="font-semibold">{DRAFT_REJECTION_MESSAGE[draftRejection]}</h3>
          <p className="text-sm">
            A count of {localCount.storedDraft?.count ?? 0} is stored on this device but is no
            longer authoritative.
          </p>
          <div className="flex flex-wrap gap-2">
            {item.workflowStatus === 'available' && (
              <Button
                variant="primary"
                loading={reclaimMutation.isPending}
                onClick={() => reclaimMutation.mutate()}
              >
                Reclaim Item
              </Button>
            )}
            <Button
              onClick={() => {
                localCount.discard();
                setDraftRejection(null);
              }}
            >
              Discard Local Count
            </Button>
            <Button onClick={() => navigate(`/app/rechecks/${recheckId}/workspace`)}>
              Return to Workspace
            </Button>
          </div>
        </Card>
      )}

      {!ownsClaim && draftRejection === null && (
        <InlineNotice tone="warning">
          {item.workflowStatus === 'submitted'
            ? 'This item has already been submitted.'
            : item.claimedByName === null
              ? 'You do not hold a claim on this item. Claim it from the workspace to start counting.'
              : `${item.claimedByName} is currently counting this item.`}
        </InlineNotice>
      )}

      {/* ---------------------------------------------- item identity panel */}
      <Card className="space-y-2">
        <h2 className="text-lg font-semibold leading-tight">{item.itemName}</h2>
        {/* The current SKU must be visually unmistakable (section 21). */}
        <p className="rounded-lg bg-[var(--color-surface-sunken)] px-3 py-2 font-mono text-xl font-bold tracking-wide">
          {item.sku}
        </p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Vendor</dt>
            <dd>{item.vendor ?? 'Not available in Zoho'}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Brand</dt>
            <dd>{item.brand ?? 'Not available in Zoho'}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Manufacturer</dt>
            <dd>{item.manufacturer ?? 'Not available in Zoho'}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Unit</dt>
            <dd>{item.unit ?? 'Not specified'}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Zoho stock</dt>
            <dd className="tabular font-semibold">
              {/* Blind count hides this until submission (section 21). */}
              {blindCount ? (
                <span className="text-[var(--color-ink-subtle)]">Hidden while counting</span>
              ) : item.zohoStock === null ? (
                '—'
              ) : (
                formatQuantity(item.zohoStock)
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Stock basis</dt>
            <dd>{recheck.stockBasisName ?? recheck.stockBasisType}</dd>
          </div>
        </dl>
      </Card>

      {/* ------------------------------------------------------ count panel */}
      <Card
        className={clsx(
          'flex flex-col items-center gap-2 py-6',
          feedback.flash === 'success' && 'scan-flash-success',
          feedback.flash === 'error' && 'scan-flash-error',
        )}
      >
        <span className="text-xs uppercase tracking-wide text-[var(--color-ink-subtle)]">
          Counted Quantity
        </span>
        <span className="tabular text-6xl font-bold leading-none">{localCount.count}</span>
        <span className="text-xs text-[var(--color-ink-subtle)]">
          Stored on this device only until you submit.
        </span>
      </Card>

      {/* --------------------------------------------------- scanner input */}
      <Card className="space-y-3">
        <label htmlFor="scanner" className="block text-sm font-medium">
          Scan SKU
        </label>
        <div className="flex gap-2">
          <TextInput
            id="scanner"
            ref={scannerRef}
            value={scanValue}
            disabled={!ownsClaim}
            error={scanError !== null}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // Section 21: never enforce numeric-only input.
            inputMode="text"
            placeholder="Scan the current item and press Enter"
            aria-describedby={scanError === null ? undefined : 'scan-error'}
            className="flex-1 font-mono text-lg"
            onChange={(event) => {
              setScanValue(event.target.value);
              if (scanError !== null) setScanError(null);
            }}
            onKeyDown={(event) => {
              if (!isScanSubmitKey(event)) return;
              // Section 21: never let Enter submit a form or navigate.
              event.preventDefault();
              processScan();
            }}
          />
          <Button variant="primary" disabled={!ownsClaim} onClick={processScan}>
            Process Scan
          </Button>
        </div>

        {scanError !== null && (
          <p
            id="scan-error"
            role="alert"
            className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm font-medium text-[var(--color-danger)]"
          >
            <span aria-hidden="true">✕ </span>
            {scanError}
          </p>
        )}

        {/* Section 36: concise live announcements for screen readers. */}
        <p aria-live="polite" role="status" className="sr-only-focusable absolute">
          {announcement}
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={!ownsClaim || localCount.count === 0}
            onClick={() => {
              localCount.decrement();
              setAnnouncement('Last increment removed.');
              toast.push({ tone: 'muted', title: 'Last increment removed' });
              focusScanner();
            }}
          >
            Undo Last Scan
          </Button>
          <Button
            size="sm"
            disabled={!ownsClaim || localCount.count === 0}
            onClick={() => setResetOpen(true)}
          >
            Reset Count
          </Button>
          <Button size="sm" disabled={!ownsClaim} onClick={focusScanner}>
            Refocus Scanner
          </Button>
        </div>
      </Card>

      {/* -------------------------------------------- sticky primary action */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-3 lg:pl-60">
        <div className="mx-auto flex max-w-3xl gap-2">
          <Button
            variant="danger"
            disabled={!ownsClaim}
            onClick={() => setReleaseOpen(true)}
          >
            Release Item
          </Button>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            disabled={!ownsClaim}
            onClick={() => {
              setSubmitConfirmed(false);
              setSubmitOpen(true);
            }}
          >
            Submit Results
          </Button>
        </div>
      </div>

      {/* --------------------------------------------------- reset dialog */}
      <Dialog
        open={resetOpen}
        tone="warning"
        title="Reset the count?"
        description={`Reset the current local count from ${localCount.count} to 0? This cannot be recovered unless you rescan the items.`}
        onClose={() => setResetOpen(false)}
        footer={
          <>
            <Button onClick={() => setResetOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                localCount.reset();
                setResetOpen(false);
                focusScanner();
              }}
            >
              Reset to 0
            </Button>
          </>
        }
      />

      {/* ------------------------------------------------- release dialog */}
      <Dialog
        open={releaseOpen}
        tone="danger"
        title="Release this item?"
        description={
          localCount.count > 0
            ? `You have an unsubmitted local count of ${localCount.count}. Releasing this item will discard it from this device.`
            : 'The item will return to Available so another user can count it.'
        }
        onClose={() => setReleaseOpen(false)}
        footer={
          <>
            <Button onClick={() => setReleaseOpen(false)}>Keep counting</Button>
            <Button
              variant="danger"
              loading={releaseMutation.isPending}
              onClick={() => releaseMutation.mutate()}
            >
              Release Item
            </Button>
          </>
        }
      />

      {/* ---------------------------------------------------- leave dialog */}
      <Dialog
        open={leaveOpen}
        tone="warning"
        title="Leave this screen?"
        description="Your count will remain only on this device and the item will stay claimed."
        onClose={() => setLeaveOpen(false)}
        footer={
          <>
            <Button onClick={() => setLeaveOpen(false)}>Stay</Button>
            <Button onClick={() => navigate(`/app/rechecks/${recheckId}/workspace`)}>
              Leave and Keep Claim
            </Button>
            <Button
              variant="danger"
              loading={releaseMutation.isPending}
              onClick={() => releaseMutation.mutate()}
            >
              Release Item and Discard Count
            </Button>
          </>
        }
      />

      {/* --------------------------------------------------- submit dialog */}
      <Dialog
        open={submitOpen}
        title="Submit final count"
        onClose={() => setSubmitOpen(false)}
        footer={
          <>
            <Button onClick={() => setSubmitOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!submitConfirmed}
              loading={submitMutation.isPending}
              loadingText="Submitting…"
              onClick={() => submitMutation.mutate()}
            >
              Submit Final Count
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--color-ink-subtle)]">Item</dt>
              <dd className="font-medium">{item.itemName}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--color-ink-subtle)]">SKU</dt>
              <dd className="font-mono">{item.sku}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--color-ink-subtle)]">Counted quantity</dt>
              <dd className="tabular text-lg font-bold">{localCount.count}</dd>
            </div>
            {!blindCount && item.zohoStock !== null && (
              <div className="flex justify-between">
                <dt className="text-[var(--color-ink-subtle)]">Zoho stock</dt>
                <dd className="tabular">{formatQuantity(item.zohoStock)}</dd>
              </div>
            )}
          </dl>

          {/* Section 21: a zero count is valid and must be called out clearly. */}
          {localCount.count === 0 && (
            <InlineNotice tone="warning">You are submitting a counted quantity of 0.</InlineNotice>
          )}

          <InlineNotice tone="info">
            After submission you cannot edit this count. Only an administrator can reopen the item
            for a recount.
          </InlineNotice>

          <Checkbox
            checked={submitConfirmed}
            onChange={(event) => setSubmitConfirmed(event.target.checked)}
            label="I confirm that I have finished counting this item."
          />
        </div>
      </Dialog>
    </div>
  );
}
