/**
 * Screen 8: Stock Recheck workspace — specification section 19.
 *
 * Desktop renders a table; below `md` the same rows become cards so nothing is
 * horizontally unusable on a phone (section 8.2).
 *
 * Deliberately NOT polled: the data refreshes on action and on tab focus, so a
 * table left open costs nothing while idle. See the items query below.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { isAdministrator } from '@/domain/permissions';
import { formatRelativeTime, formatDateTime } from '@/domain/recheckNumber';
import { formatQuantity, formatSignedQuantity } from '@/domain/quantity';
import { describeStockBasis } from '@/domain/stockBasis';
import {
  calculateCompletionPercentage,
  itemWorkflowTone,
  RECHECK_STATUS_LABEL,
  recheckStatusTone,
  RESULT_STATUS_LABEL,
  type ItemWorkflowStatus,
  type RecheckStatus,
  type ResultStatus,
} from '@/domain/status';
import { PAGE_SIZE_OPTIONS, SORT_KEY_LABEL, SORT_KEYS, type SortKey } from '@/domain/settings';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, apiRequest } from '@/services/api';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineNotice,
  LinkButton,
  Pagination,
  ProgressBar,
  Select,
  Spinner,
  StatCard,
  TextInput,
  useToast,
} from '@/components/ui';
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  LayersIcon,
  PackageIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  UserIcon,
} from '@/components/icons';

/* ------------------------------------------------------------------ types */

interface WorkspaceItem {
  id: string;
  itemName: string;
  sku: string;
  zohoStock: number | null;
  vendor: string | null;
  unit: string | null;
  workflowStatus: ItemWorkflowStatus;
  resultStatus: ResultStatus;
  claimedBy: string | null;
  claimedByName: string | null;
  claimedAt: string | null;
  claimExpiresAt: string | null;
  claimVersion: number;
  isClaimedByMe: boolean;
  countedQuantity: number | null;
  quantityDifference: number | null;
  submittedByName: string | null;
  submittedAt: string | null;
}

interface ItemsResponse {
  items: WorkspaceItem[];
  facets: {
    vendors: string[];
    claimants: { id: string; name: string }[];
  };
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
  recheckStatus: RecheckStatus;
  isReadOnly: boolean;
}

interface RecheckResponse {
  recheck: {
    id: string;
    recheckNumber: string;
    name: string;
    businessDate: string;
    status: RecheckStatus;
    organization: { id: string | null; name: string | null };
    stockBasis: {
      type: 'organization' | 'location' | 'warehouse';
      locationId: string | null;
      locationName: string | null;
      warehouseId: string | null;
      warehouseName: string | null;
    };
    zohoSnapshotAt: string;
    counts: {
      totalItems: number;
      availableItems: number;
      inProgressItems: number;
      submittedItems: number;
      matchedItems: number;
      mismatchedItems: number;
    };
    completionPercentage: number;
    createdByName: string | null;
    createdAt: string;
    isReadOnly: boolean;
  };
}

/* --------------------------------------------------------------- component */

export default function WorkspacePage(): React.JSX.Element {
  const { recheckId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const isAdmin = user !== null && isAdministrator(user.role);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<SortKey>('item_name');
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc');
  const [workflowStatus, setWorkflowStatus] = useState<ItemWorkflowStatus | ''>(
    // "Count Next Item" lands here pre-filtered to available items (section 24).
    (searchParams.get('status') as ItemWorkflowStatus | null) ?? '',
  );
  const [resultStatus, setResultStatus] = useState<ResultStatus | ''>('');
  const [vendor, setVendor] = useState('');
  const [claimedBy, setClaimedBy] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [releaseTarget, setReleaseTarget] = useState<WorkspaceItem | null>(null);
  const [releaseReason, setReleaseReason] = useState('');
  const [removeOpen, setRemoveOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState('');

  /*
   * Selected item ids for bulk claiming.
   *
   * A Set keyed by id rather than an array of rows: holding row OBJECTS would
   * pin stale copies of rows whose status has since changed by the next
   * refetch. Ids stay valid across refetches and are all the bulk-claim
   * endpoint needs.
   */
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());

  const toggleSelected = (itemId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  // Reset to page 1 whenever a filter changes, so the user is not stranded on
  // an out-of-range page.
  useEffect(() => setPage(1), [debouncedSearch, workflowStatus, resultStatus, vendor, claimedBy, onlyMine, pageSize]);

  // Selection is per-view. Carrying it across a page or filter change would
  // leave rows selected that the user can no longer see, and the bulk bar would
  // claim items they are not looking at.
  useEffect(
    () => setSelectedIds(new Set()),
    [page, debouncedSearch, workflowStatus, resultStatus, vendor, claimedBy, onlyMine, pageSize],
  );

  const recheckQuery = useQuery({
    queryKey: ['recheck', recheckId],
    queryFn: () => apiRequest<RecheckResponse>(`/api/rechecks/${recheckId}`),
  });

  const itemsQuery = useQuery({
    queryKey: [
      'recheck',
      recheckId,
      'items',
      { debouncedSearch, workflowStatus, resultStatus, vendor, claimedBy, onlyMine, sort, direction, page, pageSize },
    ],
    queryFn: () =>
      apiRequest<ItemsResponse>(`/api/rechecks/${recheckId}/items`, {
        searchParams: {
          search: debouncedSearch || undefined,
          workflowStatus: workflowStatus || undefined,
          resultStatus: resultStatus || undefined,
          vendor: vendor || undefined,
          claimedBy: claimedBy || undefined,
          onlyMine: onlyMine ? 'true' : undefined,
          sort,
          direction,
          page,
          pageSize,
        },
      }),
    /*
     * NOT polled.
     *
     * This table previously refetched every 4s (and the header every 5s) for as
     * long as it was open, which burned function invocations and database
     * queries while nobody was doing anything — the common case is a table left
     * open on a warehouse tablet.
     *
     * Freshness now comes from actions instead: every mutation below
     * invalidates ['recheck', recheckId], which covers both queries, and React
     * Query refetches when the tab regains focus. So the data updates when the
     * operator does something or comes back to it, and costs nothing when idle.
     */
    // Keeping the previous page visible avoids a flash of empty table on paging.
    placeholderData: (previous) => previous,
  });

  /**
   * How many items THIS user is mid-count on, across the whole recheck.
   *
   * Deliberately its own request rather than a scan of the loaded rows: the
   * table shows one page of a recheck that may hold thousands, so deriving this
   * from `items` made "Resume counting" appear only when a claimed row happened
   * to fall on the page being viewed. The operator then had to hunt for their
   * own item before the button offering to take them to it would show up.
   *
   * `pageSize: 1` because only the total is wanted; the row itself is unused.
   */
  /** Removes the selected AVAILABLE items. The server enforces that guard too. */
  const removeItemsMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      apiRequest<{ removed: number; skipped: number }>(
        `/api/rechecks/${recheckId}/remove-items`,
        { method: 'POST', body: { itemIds } },
      ),
    onSuccess: async ({ removed, skipped }) => {
      setRemoveOpen(false);
      setSelectedIds(new Set());
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
      toast.push(
        skipped === 0
          ? { tone: 'success', title: `${removed} item${removed === 1 ? '' : 's'} removed` }
          : {
              tone: 'warning',
              title: `${removed} removed, ${skipped} skipped`,
              description:
                'Kept: items claimed or submitted in the meantime, and any that have been counted before.',
            },
      );
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Could not remove the items',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  /** Validates pasted SKUs against Zoho and adds those that pass. */
  const addItemsMutation = useMutation({
    mutationFn: (skus: string[]) =>
      apiRequest<{ added: number; alreadyPresent: number; failed: number }>(
        `/api/rechecks/${recheckId}/add-items`,
        { method: 'POST', body: { skus } },
      ),
    onSuccess: async ({ added, alreadyPresent, failed }) => {
      setAddOpen(false);
      setAddText('');
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });

      const notes = [
        alreadyPresent > 0 ? `${alreadyPresent} already in this recheck` : null,
        failed > 0 ? `${failed} could not be validated against Zoho` : null,
      ].filter((note) => note !== null);

      toast.push({
        tone: added > 0 ? 'success' : 'warning',
        title: `${added} item${added === 1 ? '' : 's'} added`,
        description: notes.length > 0 ? notes.join(' · ') : undefined,
      });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Could not add the items',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  const myClaimsQuery = useQuery({
    queryKey: ['recheck', recheckId, 'my-claims'],
    queryFn: () =>
      apiRequest<ItemsResponse>(`/api/rechecks/${recheckId}/items`, {
        searchParams: { onlyMine: 'true', workflowStatus: 'counting_in_progress', pageSize: 1 },
      }),
  });
  const myClaimCount = myClaimsQuery.data?.pagination.total ?? 0;

  /**
   * Bulk claim (section 20). The endpoint claims each id atomically and reports
   * per-item outcomes rather than failing the whole batch, so a race on one row
   * never costs the user the rest of their selection.
   */
  const bulkClaimMutation = useMutation({
    mutationFn: (itemIds: string[]) =>
      apiRequest<{
        claimed: { itemId: string; sku: string; itemName: string }[];
        rejected: { itemId: string; sku: string | null; code: string; message: string }[];
        claimedCount: number;
        rejectedCount: number;
      }>(`/api/rechecks/${recheckId}/items/bulk-claim`, {
        method: 'POST',
        body: { itemIds },
      }),
    onSuccess: (result) => {
      /*
       * Nothing landed: stay put, drop the selection so the stale rows can be
       * re-picked, and refresh in place.
       */
      if (result.claimedCount === 0) {
        setSelectedIds(new Set());
        void queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
        toast.push({
          tone: 'warning',
          title: 'Nothing was claimed',
          description: result.rejected[0]?.message ?? 'Those items are no longer available.',
        });
        return;
      }

      /*
       * Navigate FIRST, and synchronously.
       *
       * This used to clear the selection and then `await` the invalidation
       * before navigating. Because invalidation refetches the workspace list
       * and the recheck, that await ran for a couple of seconds — during which
       * the checkboxes had already emptied and the action bar had already
       * vanished, so a claim that had in fact succeeded looked like it had done
       * nothing at all, right up until the screen abruptly changed.
       *
       * The counting screen has its own skeleton, so it is the right place to
       * wait. Straight there whether one item was claimed or fifty; it holds
       * every item this user has claimed, so a partially-rejected batch still
       * lands somewhere useful.
       */
      navigate(`/app/rechecks/${recheckId}/count`);

      if (result.rejectedCount > 0) {
        toast.push({
          tone: 'warning',
          title: `${result.claimedCount} of ${result.claimedCount + result.rejectedCount} claimed`,
          description: `${result.rejectedCount} could not be claimed: ${result.rejected[0]?.message ?? ''}`,
        });
      }

      /*
       * `refetchType: 'none'` marks the workspace queries stale without firing
       * requests now. This component is unmounting and the counting screen
       * fetches its own session, so an immediate refetch would be work nobody
       * is waiting on — and would race the new page's own request. The
       * workspace refetches when the operator returns to it.
       */
      void queryClient.invalidateQueries({
        queryKey: ['recheck', recheckId],
        refetchType: 'none',
      });
    },
    onError: async (error) => {
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
      toast.push({
        tone: 'danger',
        title: 'Could not claim these items',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  /**
   * Re-reads Zoho stock for every item that is not yet submitted.
   *
   * Submitted rows are deliberately left alone by the server: their Zoho figure
   * is what their stored difference was measured against, so refreshing it
   * would restate a finished result.
   */
  const refreshStockMutation = useMutation({
    mutationFn: () =>
      apiRequest<{
        updated: number;
        considered: number;
        skippedSubmitted: number;
        unresolved: { sku: string; reason: string }[];
      }>(`/api/rechecks/${recheckId}/refresh-stock`, { method: 'POST', body: {} }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
      const skipped =
        result.skippedSubmitted > 0
          ? ` ${result.skippedSubmitted} submitted item${result.skippedSubmitted === 1 ? '' : 's'} left untouched.`
          : '';
      toast.push({
        tone: result.unresolved.length > 0 ? 'warning' : 'success',
        title:
          result.updated === 0
            ? 'No stock figures changed'
            : `${result.updated} stock figure${result.updated === 1 ? '' : 's'} updated`,
        description:
          result.unresolved.length > 0
            ? `${result.unresolved.length} could not be read (${result.unresolved[0]?.sku}: ${result.unresolved[0]?.reason}).${skipped}`
            : `Counted quantities are unchanged.${skipped}`,
      });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Could not update stock details',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () =>
      apiRequest(`/api/rechecks/${recheckId}/cancel`, {
        method: 'POST',
        body: { reason: cancelReason },
      }),
    onSuccess: async () => {
      setCancelOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
      toast.push({
        tone: 'muted',
        title: 'Stock Recheck cancelled',
        description: 'Submitted results have been preserved.',
      });
    },
  });

  const forceReleaseMutation = useMutation({
    mutationFn: (itemId: string) =>
      apiRequest(`/api/rechecks/${recheckId}/items/${itemId}/force-release`, {
        method: 'POST',
        body: { reason: releaseReason },
      }),
    onSuccess: async () => {
      setReleaseTarget(null);
      setReleaseReason('');
      await queryClient.invalidateQueries({ queryKey: ['recheck', recheckId] });
      toast.push({ tone: 'success', title: 'Claim released' });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Could not release the claim',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  const facets = itemsQuery.data?.facets;
  const recheck = recheckQuery.data?.recheck;

  /*
   * Drop any selection that has stopped being claimable.
   *
   * The table polls every four seconds, so another counter can claim a row the
   * moment after this user ticked it. Without this, the bulk bar would keep
   * counting it and the request would come back with an avoidable rejection.
   *
   * Returning `current` unchanged when nothing was pruned keeps this from
   * looping: an identical Set reference is not a state change.
   */
  const loadedItems = itemsQuery.data?.items;
  const loadedReadOnly = itemsQuery.data?.isReadOnly ?? false;
  useEffect(() => {
    if (loadedItems === undefined) return;
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const stillSelectable = new Set(
        loadedItems
          .filter((item) => selectionKindOf(item, loadedReadOnly, isAdmin) !== null)
          .map((item) => item.id),
      );
      const next = new Set<string>();
      for (const id of current) if (stillSelectable.has(id)) next.add(id);
      return next.size === current.size ? current : next;
    });
  }, [loadedItems, loadedReadOnly, isAdmin]);

  const hasActiveFilters = useMemo(
    () =>
      debouncedSearch !== '' ||
      workflowStatus !== '' ||
      resultStatus !== '' ||
      vendor !== '' ||
      claimedBy !== '' ||
      onlyMine,
    [debouncedSearch, workflowStatus, resultStatus, vendor, claimedBy, onlyMine],
  );

  const clearFilters = (): void => {
    setSearch('');
    setWorkflowStatus('');
    setResultStatus('');
    setVendor('');
    setClaimedBy('');
    setOnlyMine(false);
    setSearchParams({});
  };

  if (recheckQuery.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} label="Loading Stock Recheck" />
      </div>
    );
  }

  if (recheckQuery.error !== null || recheck === undefined) {
    return (
      <ErrorState
        title="This Stock Recheck could not be loaded"
        message={
          recheckQuery.error instanceof ApiError
            ? recheckQuery.error.message
            : 'It may have been removed.'
        }
        correlationId={
          recheckQuery.error instanceof ApiError ? recheckQuery.error.correlationId : undefined
        }
        action={<LinkButton to="/app/rechecks">Back to Rechecks</LinkButton>}
      />
    );
  }

  const { counts } = recheck;
  const items = itemsQuery.data?.items ?? [];
  const kindOf = (item: WorkspaceItem): SelectionKind | null =>
    selectionKindOf(item, recheck.isReadOnly, isAdmin);

  const selectedItems = items.filter((item) => selectedIds.has(item.id));
  const selectedCount = selectedItems.length;

  /*
   * A selection carries exactly ONE verb. The kind is taken from whatever is
   * already selected; with nothing selected the header checkbox falls back to
   * the highest-priority kind present on the page, so it always has a
   * well-defined target instead of silently doing nothing.
   */
  const activeKind: SelectionKind | null =
    selectedItems.length > 0
      ? kindOf(selectedItems[0] as WorkspaceItem)
      : (KIND_PRIORITY.find((kind) => items.some((item) => kindOf(item) === kind)) ?? null);

  const kindTargets = items.filter((item) => kindOf(item) === activeKind);
  /* Whether THIS user has anything mid-count, anywhere in the recheck.
     `counts.inProgressItems` counts every user's claims, so it would offer a
     counting screen to someone holding nothing. */
  const hasMyClaims = myClaimCount > 0;
  const pagination = itemsQuery.data?.pagination;

  return (
    <div className="space-y-5">
      {/* ---------------------------------------------------------- header */}
      <header className="space-y-3">
        {/*
         * Explicit way back to the list. The workspace is reached from the
         * Rechecks table, and until this existed the only routes out were the
         * browser Back button or the sidebar — neither of which is available
         * on the mobile bottom-nav layout while a count is in progress.
         */}
        <LinkButton
          to="/app/rechecks"
          variant="ghost"
          size="sm"
          icon={<ArrowLeftIcon size={15} />}
          className="-ml-3"
        >
          All Stock Rechecks
        </LinkButton>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-mono text-xs text-[var(--color-ink-subtle)]">
              {recheck.recheckNumber}
            </p>
            <h2 className="text-xl font-semibold">{recheck.name}</h2>
            <p className="text-sm text-[var(--color-ink-muted)]">
              {recheck.businessDate} · created by {recheck.createdByName ?? 'Unknown'} ·{' '}
              {formatDateTime(recheck.createdAt)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={recheckStatusTone(recheck.status)}>
              {RECHECK_STATUS_LABEL[recheck.status]}
            </Badge>
            <Button
              onClick={() => {
                void recheckQuery.refetch();
                void itemsQuery.refetch();
              }}
              loading={itemsQuery.isFetching && !itemsQuery.isPlaceholderData}
              icon={<RefreshIcon size={15} />}
            >
              Refresh
            </Button>
            {hasMyClaims && (
              <LinkButton
                to={`/app/rechecks/${recheckId}/count`}
                variant="primary"
                icon={<PackageIcon size={15} />}
              >
                {myClaimCount === 1
                  ? 'Resume counting'
                  : `Resume counting (${myClaimCount})`}
              </LinkButton>
            )}
            {isAdmin && !recheck.isReadOnly && (
              <Button onClick={() => setAddOpen(true)} icon={<PlusIcon size={15} />}>
                Add items
              </Button>
            )}
            {isAdmin && !recheck.isReadOnly && (
              <Button
                onClick={() => refreshStockMutation.mutate()}
                loading={refreshStockMutation.isPending}
                loadingText="Reading Zoho…"
                icon={<RefreshIcon size={15} />}
                /*
                 * Spelled out because the label alone could be read as pushing
                 * counts INTO Zoho, which section 2.1 forbids and this does not
                 * do. The direction is Zoho -> here, for unsubmitted rows only.
                 */
                title="Re-read stock from Zoho for items not yet submitted. Nothing is ever written to Zoho."
              >
                Update stock details
              </Button>
            )}
            <LinkButton
              to={`/app/rechecks/${recheckId}/summary`}
              icon={<LayersIcon size={15} />}
            >
              {recheck.status === 'completed' ? 'Final Summary' : 'Current Summary'}
            </LinkButton>
            {isAdmin && (
              <Button
                variant="danger"
                disabled={recheck.isReadOnly}
                onClick={() => setCancelOpen(true)}
              >
                Cancel Recheck
              </Button>
            )}
          </div>
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="inline text-[var(--color-ink-subtle)]">Zoho organization: </dt>
            <dd className="inline">{recheck.organization.name ?? 'Not available'}</dd>
          </div>
          <div>
            <dt className="inline text-[var(--color-ink-subtle)]">Stock basis: </dt>
            <dd className="inline">{describeStockBasis(recheck.stockBasis)}</dd>
          </div>
          <div>
            <dt className="inline text-[var(--color-ink-subtle)]">Stock last read: </dt>
            <dd className="inline">{formatDateTime(recheck.zohoSnapshotAt)}</dd>
          </div>
        </dl>
      </header>

      {recheck.isReadOnly && (
        <InlineNotice tone={recheck.status === 'cancelled' ? 'muted' : 'success'}>
          {recheck.status === 'cancelled'
            ? 'This Stock Recheck was cancelled. It is read-only; submitted results are preserved.'
            : 'All items have been counted. This Stock Recheck is complete.'}
        </InlineNotice>
      )}

      {/* --------------------------------------------------- progress cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <StatCard label="Total Items" value={counts.totalItems} />
        <StatCard label="Available" value={counts.availableItems} />
        <StatCard label="Counting" value={counts.inProgressItems} tone="info" />
        <StatCard label="Submitted" value={counts.submittedItems} tone="success" />
        <StatCard label="Matched" value={counts.matchedItems} tone="success" />
        <StatCard
          label="Mismatched"
          value={counts.mismatchedItems}
          tone={counts.mismatchedItems > 0 ? 'danger' : 'neutral'}
        />
        <StatCard
          label="Completion"
          value={`${calculateCompletionPercentage({ submittedItems: counts.submittedItems, totalItems: counts.totalItems })}%`}
        />
      </div>

      {/* Section 19: claimed-but-unsubmitted items are NOT counted as complete. */}
      <ProgressBar
        value={counts.submittedItems}
        max={counts.totalItems}
        label={`${counts.submittedItems} of ${counts.totalItems} items submitted`}
      />

      {/* ---------------------------------------------------------- filters */}
      <Card className="space-y-3">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <Field label="Search">
            {({ inputId }) => (
              <TextInput
                id={inputId}
                type="search"
                placeholder="Item name, SKU, vendor…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            )}
          </Field>

          <Field label="Status">
            {({ inputId }) => (
              <Select
                id={inputId}
                value={workflowStatus}
                onChange={(event) =>
                  setWorkflowStatus(event.target.value as ItemWorkflowStatus | '')
                }
              >
                <option value="">All statuses</option>
                <option value="available">Available</option>
                <option value="counting_in_progress">Counting in progress</option>
                <option value="submitted">Submitted</option>
              </Select>
            )}
          </Field>

          <Field label="Result">
            {({ inputId }) => (
              <Select
                id={inputId}
                value={resultStatus}
                onChange={(event) => setResultStatus(event.target.value as ResultStatus | '')}
              >
                <option value="">All results</option>
                <option value="pending">Pending</option>
                <option value="matched">Matched</option>
                <option value="mismatched">Mismatched</option>
              </Select>
            )}
          </Field>

          <Field label="Sort by">
            {({ inputId }) => (
              <div className="flex gap-2">
                <Select
                  id={inputId}
                  value={sort}
                  onChange={(event) => setSort(event.target.value as SortKey)}
                >
                  {SORT_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {SORT_KEY_LABEL[key]}
                    </option>
                  ))}
                </Select>
                {/*
                  * Square and icon-only. `px-4` from the default button size
                  * made this ~52px wide for a single glyph, so it read as a
                  * lopsided box next to the select rather than a paired control.
                  */}
                <Button
                  onClick={() => setDirection((current) => (current === 'asc' ? 'desc' : 'asc'))}
                  aria-label={`Sort ${direction === 'asc' ? 'descending' : 'ascending'}`}
                  className="w-11 shrink-0 px-0"
                  icon={
                    direction === 'asc' ? <ArrowUpIcon size={16} /> : <ArrowDownIcon size={16} />
                  }
                />
              </div>
            )}
          </Field>
        </div>

        {/*
          * `list-none` + `[&::-webkit-details-marker]:hidden` removes the
          * native disclosure triangle, which rendered at a different size per
          * browser and indented the label out of line with the field labels
          * above it. The chevron below is drawn at a known size instead.
          */}
        <details className="group text-sm">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 font-medium text-[var(--color-brand)] [&::-webkit-details-marker]:hidden">
            <ChevronDownIcon
              size={15}
              className="-rotate-90 transition-transform group-open:rotate-0"
            />
            More filters
          </summary>
          <div className="grid gap-3 pt-3 md:grid-cols-2 lg:grid-cols-4">
            <Field label="Vendor">
              {({ inputId }) => (
                <Select id={inputId} value={vendor} onChange={(e) => setVendor(e.target.value)}>
                  <option value="">All vendors</option>
                  {facets?.vendors.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Claimed by">
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={claimedBy}
                  onChange={(e) => setClaimedBy(e.target.value)}
                >
                  <option value="">Anyone</option>
                  {facets?.claimants.map((claimant) => (
                    <option key={claimant.id} value={claimant.id}>
                      {claimant.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </details>

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-[var(--color-border-strong)] accent-[var(--color-brand)]"
              checked={onlyMine}
              onChange={(event) => setOnlyMine(event.target.checked)}
            />
            Only my items
          </label>
          {hasActiveFilters && (
            <Button size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      </Card>

      {/*
        * Bulk action bar — appears only once something is selected, which is
        * what replaced the per-row Claim button.
        *
        * Rendered inline above the table rather than pinned to the viewport:
        * the app header is already `sticky top-0` and the mobile layout adds a
        * bottom navigation bar, so a second floating element would have to
        * guess both offsets and would overlap one of them at some breakpoint.
        */}
      {selectedCount > 0 && activeKind !== null && (
        <div className="animate-row-in flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-[var(--color-brand)] bg-[var(--color-brand-subtle)] px-4 py-3">
          <p className="text-sm font-medium">
            <span className="tabular">{selectedCount}</span> {KIND_NOUN[activeKind]}{' '}
            {selectedCount === 1 ? 'item' : 'items'} selected
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setSelectedIds(new Set())}>
              Clear
            </Button>
            {/*
              * Removal rides on a CLAIM selection rather than being its own
              * selection kind: the rows it applies to are exactly the available
              * ones, and a separate kind would make every available row belong
              * to two kinds at once, which the single-kind rule forbids.
              */}
            {activeKind === 'claim' && isAdmin && (
              <Button
                size="sm"
                onClick={() => setRemoveOpen(true)}
                disabled={bulkClaimMutation.isPending || removeItemsMutation.isPending}
              >
                Remove from recheck
              </Button>
            )}
            {/*
              * Exactly one action, matching the kind of what is selected.
              * Showing "Claim" and "Edit" side by side — which happened when a
              * mixed selection was allowed — asks the operator to work out
              * which button applies to which half of their selection.
              */}
            <Button
              variant="primary"
              size="sm"
              icon={
                activeKind === 'edit' ? (
                  <PencilIcon size={15} />
                ) : activeKind === 'resume' ? (
                  <PackageIcon size={15} />
                ) : undefined
              }
              loading={activeKind === 'claim' && bulkClaimMutation.isPending}
              loadingText="Claiming…"
              onClick={() => {
                const ids = selectedItems.map((item) => item.id);
                if (activeKind === 'claim') {
                  bulkClaimMutation.mutate(ids);
                  return;
                }
                if (activeKind === 'resume') {
                  navigate(`/app/rechecks/${recheckId}/count`);
                  return;
                }
                navigate(`/app/rechecks/${recheckId}/count?mode=amend&ids=${ids.join(',')}`);
              }}
            >
              {actionLabel(activeKind, selectedCount)}
            </Button>
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ items */}
      {itemsQuery.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner size={28} label="Loading items" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={hasActiveFilters ? <SearchIcon size={22} /> : <PackageIcon size={22} />}
          title={hasActiveFilters ? 'No items match these filters' : 'No items in this Stock Recheck'}
          message={
            hasActiveFilters
              ? 'Try widening or clearing the filters to see more items.'
              : 'This Stock Recheck contains no countable items.'
          }
          action={
            hasActiveFilters ? (
              <Button variant="primary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* --------------------------------- desktop table (md and up) */}
          <Card className="hidden overflow-x-auto p-0 md:block">
            <table className="w-full min-w-[1100px] text-left text-sm">
              <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
                <tr>
                  <th scope="col" className="w-10 px-3 py-2">
                    <SelectAllCheckbox
                      targets={kindTargets}
                      kind={activeKind}
                      selectedIds={selectedIds}
                      onChange={setSelectedIds}
                    />
                  </th>
                  <th scope="col" className="px-3 py-2">Status</th>
                  <th scope="col" className="px-3 py-2">Item Name</th>
                  <th scope="col" className="px-3 py-2">SKU</th>
                  <th scope="col" className="px-3 py-2">Zoho Stock</th>
                  <th scope="col" className="px-3 py-2">Vendor</th>
                  <th scope="col" className="px-3 py-2">Unit</th>
                  <th scope="col" className="px-3 py-2">Claimed By</th>
                  <th scope="col" className="px-3 py-2">Counted</th>
                  <th scope="col" className="px-3 py-2">Difference</th>
                  <th scope="col" className="px-3 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const kind = kindOf(item);
                  const selected = selectedIds.has(item.id);
                  /* A selection holds one kind at a time; rows of another kind
                     stay visible but disabled so the reason is obvious rather
                     than the checkbox simply not responding. */
                  const blocked = kind !== null && activeKind !== null && kind !== activeKind && selectedCount > 0;
                  return (
                  <tr
                    key={item.id}
                    className={clsx(
                      'border-t border-[var(--color-border)]',
                      selected && 'bg-[var(--color-brand-subtle)]',
                    )}
                  >
                    <td className="px-3 py-2">
                      {kind !== null ? (
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={blocked}
                          onChange={() => toggleSelected(item.id)}
                          title={
                            blocked
                              ? `Clear the current selection to choose ${KIND_NOUN[kind]} items.`
                              : undefined
                          }
                          aria-label={`Select ${item.itemName}`}
                          className="h-4 w-4 rounded border-[var(--color-border-strong)] accent-[var(--color-brand)] disabled:cursor-not-allowed disabled:opacity-35"
                        />
                      ) : (
                        /* Placeholder keeps the column width stable across rows. */
                        <span className="sr-only-focusable absolute">Not claimable</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <ItemStatusBadge item={item} />
                    </td>
                    <td className="px-3 py-2 font-medium">
                      <ItemNameCell item={item} recheckId={recheckId} />
                    </td>
                    <td className="px-3 py-2 font-mono">{item.sku}</td>
                    <td className="tabular px-3 py-2">
                      {item.zohoStock === null ? '—' : formatQuantity(item.zohoStock)}
                    </td>
                    <td className="px-3 py-2">{item.vendor ?? '—'}</td>
                    <td className="px-3 py-2">{item.unit ?? '—'}</td>
                    <td className="px-3 py-2">
                      {item.claimedByName === null ? (
                        '—'
                      ) : (
                        <span>
                          {item.claimedByName}
                          <span className="block text-xs text-[var(--color-ink-subtle)]">
                            {formatRelativeTime(item.claimedAt)}
                          </span>
                          {/*
                            * Force-release lives beside the claim it acts on
                            * rather than in a trailing Action column, which no
                            * longer exists. Administrators only (section 19).
                            */}
                          {isAdmin && !recheck.isReadOnly && !item.isClaimedByMe && (
                            <button
                              type="button"
                              onClick={() => setReleaseTarget(item)}
                              className="mt-0.5 block text-xs font-medium text-[var(--color-danger)] hover:underline"
                            >
                              Release claim
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                    {/* Section 19: before submission these show an em dash. */}
                    <td className="tabular px-3 py-2">
                      {item.countedQuantity === null ? '—' : item.countedQuantity}
                    </td>
                    <td className="tabular px-3 py-2 font-medium">
                      {item.quantityDifference === null
                        ? '—'
                        : formatSignedQuantity(item.quantityDifference)}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={itemWorkflowTone(item.workflowStatus, item.resultStatus)}>
                        {RESULT_STATUS_LABEL[item.resultStatus]}
                      </Badge>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* ----------------------------------- mobile cards (below md) */}
          <ul className="space-y-3 md:hidden">
            {items.map((item) => {
              const kind = kindOf(item);
              const selected = selectedIds.has(item.id);
              const blocked = kind !== null && activeKind !== null && kind !== activeKind && selectedCount > 0;
              return (
              <Card
                key={item.id}
                as="li"
                className={clsx('space-y-2', selected && 'border-[var(--color-brand)]')}
              >
                <div className="flex items-start gap-2">
                  {kind !== null && (
                    <input
                      type="checkbox"
                      checked={selected}
                      disabled={blocked}
                      onChange={() => toggleSelected(item.id)}
                      aria-label={`Select ${item.itemName}`}
                      className="mt-1 h-5 w-5 shrink-0 rounded border-[var(--color-border-strong)] accent-[var(--color-brand)] disabled:cursor-not-allowed disabled:opacity-35"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      <ItemNameCell item={item} recheckId={recheckId} />
                    </p>
                    <p className="font-mono text-sm text-[var(--color-ink-muted)]">{item.sku}</p>
                  </div>
                  <ItemStatusBadge item={item} />
                </div>

                <dl className="tabular grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-[var(--color-ink-subtle)]">Zoho</dt>
                    <dd className="font-semibold">
                      {item.zohoStock === null ? '—' : formatQuantity(item.zohoStock)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-ink-subtle)]">Counted</dt>
                    <dd className="font-semibold">{item.countedQuantity ?? '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-[var(--color-ink-subtle)]">Difference</dt>
                    <dd className="font-semibold">
                      {item.quantityDifference === null
                        ? '—'
                        : formatSignedQuantity(item.quantityDifference)}
                    </dd>
                  </div>
                </dl>

                {item.claimedByName !== null && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-[var(--color-ink-subtle)]">
                      Claimed by {item.claimedByName} · {formatRelativeTime(item.claimedAt)}
                    </p>
                    {isAdmin && !recheck.isReadOnly && !item.isClaimedByMe && (
                      <button
                        type="button"
                        onClick={() => setReleaseTarget(item)}
                        className="text-xs font-medium text-[var(--color-danger)] hover:underline"
                      >
                        Release claim
                      </button>
                    )}
                  </div>
                )}
              </Card>
              );
            })}
          </ul>

          {pagination !== undefined && (
            <Pagination
              page={pagination.page}
              pageSize={pagination.pageSize}
              total={pagination.total}
              totalPages={pagination.totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
            />
          )}
        </>
      )}

      {/* --------------------------------------------------- cancel dialog */}
      {/* ------------------------------------------------- remove items */}
      <Dialog
        open={removeOpen}
        tone="warning"
        title={`Remove ${selectedCount} item${selectedCount === 1 ? '' : 's'}?`}
        description={
          <>
            {selectedCount === 1 ? 'This item' : 'These items'} will be taken out of{' '}
            <strong>{recheck.recheckNumber}</strong> and will no longer be counted. Only items
            still <strong>Available</strong> and never counted can be removed — anything claimed,
            submitted, or previously counted and reopened is kept, so no counting record is ever
            destroyed. The removal is recorded in the audit log.
          </>
        }
        onClose={() => setRemoveOpen(false)}
        footer={
          <>
            <Button onClick={() => setRemoveOpen(false)}>Back</Button>
            <Button
              variant="danger"
              loading={removeItemsMutation.isPending}
              loadingText="Removing…"
              onClick={() => removeItemsMutation.mutate(selectedItems.map((item) => item.id))}
            >
              Remove {selectedCount}
            </Button>
          </>
        }
      />

      {/* ---------------------------------------------------- add items */}
      <Dialog
        open={addOpen}
        title="Add items to this Stock Recheck"
        description={
          <>
            One SKU per line. Each is validated against Zoho using{' '}
            <strong>this recheck&rsquo;s</strong> stock basis, so added rows are measured the same
            way as the existing ones. SKUs already present are skipped.
          </>
        }
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={addItemsMutation.isPending}
              loadingText="Validating with Zoho…"
              disabled={addText.trim() === ''}
              onClick={() =>
                addItemsMutation.mutate(
                  addText
                    .split(/[\r\n,]+/)
                    .map((value) => value.trim())
                    .filter((value) => value !== ''),
                )
              }
            >
              Validate and add
            </Button>
          </>
        }
      >
        <Field label="SKUs" hint="One per line. Blank lines and duplicates are ignored.">
          {({ inputId, describedBy }) => (
            <textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={10}
              value={addText}
              onChange={(event) => setAddText(event.target.value)}
              placeholder={'SKU-0001\nSKU-0002'}
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-brand)]"
            />
          )}
        </Field>
      </Dialog>

      <Dialog
        open={cancelOpen}
        tone="danger"
        title="Cancel this Stock Recheck?"
        description={
          <>
            This Stock Recheck has <strong className="tabular">{counts.submittedItems}</strong>{' '}
            submitted item(s). Cancelling stops all further counting but{' '}
            <strong>does not delete any submitted result</strong>.
          </>
        }
        onClose={() => setCancelOpen(false)}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)}>Keep it active</Button>
            <Button
              variant="danger"
              disabled={cancelReason.trim().length < 3}
              loading={cancelMutation.isPending}
              onClick={() => cancelMutation.mutate()}
            >
              Cancel Stock Recheck
            </Button>
          </>
        }
      >
        <Field label="Reason" hint="Recorded in the audit log." required>
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              value={cancelReason}
              onChange={(event) => setCancelReason(event.target.value)}
            />
          )}
        </Field>
      </Dialog>

      {/* -------------------------------------------- force-release dialog */}
      <Dialog
        open={releaseTarget !== null}
        tone="warning"
        title="Release this claim?"
        description={
          releaseTarget === null ? undefined : (
            <>
              <strong>{releaseTarget.claimedByName}</strong> is counting{' '}
              <strong>{releaseTarget.itemName}</strong>. Releasing returns it to Available. Their
              local count is discarded and cannot be submitted.
            </>
          )
        }
        onClose={() => setReleaseTarget(null)}
        footer={
          <>
            <Button onClick={() => setReleaseTarget(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={releaseReason.trim().length < 3}
              loading={forceReleaseMutation.isPending}
              onClick={() => {
                if (releaseTarget !== null) forceReleaseMutation.mutate(releaseTarget.id);
              }}
            >
              Release claim
            </Button>
          </>
        }
      >
        <Field label="Reason" hint="Required and recorded in the audit log." required>
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              value={releaseReason}
              onChange={(event) => setReleaseReason(event.target.value)}
            />
          )}
        </Field>
      </Dialog>
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

/**
 * What selecting a row would let you DO.
 *
 * A row gets a checkbox only if it has one of these verbs, and a selection may
 * only ever hold rows of a SINGLE kind. Mixing them produced an action bar
 * offering both "Claim" and "Edit" at once, which does not describe any single
 * thing the operator asked for.
 *
 *   claim  — unclaimed and unsubmitted. Re-claiming your own item is a no-op,
 *            and claiming someone else's is what section 2.4 forbids, so
 *            neither of those is selectable.
 *   resume — already claimed BY THIS USER and still being counted. Without
 *            this, walking back to the workspace mid-count stranded the items:
 *            no checkbox, so no route back into the counting screen.
 *   edit   — already submitted, reopened for correction. Administrators only:
 *            section 4.5 says a counter "cannot modify completed counts", and
 *            `item:amend` is withheld from COUNTER_PERMISSIONS to match.
 *
 * ALL three require a writable recheck. Once a Stock Recheck is completed or
 * cancelled it is frozen: corrections are possible while the count is still
 * running, and not afterwards. The server enforces the same rule, so hiding
 * the checkbox is presentation, never the control.
 */
export type SelectionKind = 'claim' | 'resume' | 'edit';

function selectionKindOf(
  item: WorkspaceItem,
  isReadOnly: boolean,
  isAdmin: boolean,
): SelectionKind | null {
  if (!isReadOnly && item.workflowStatus === 'available') return 'claim';
  if (!isReadOnly && item.workflowStatus === 'counting_in_progress' && item.isClaimedByMe) {
    return 'resume';
  }
  if (!isReadOnly && isAdmin && item.workflowStatus === 'submitted') return 'edit';
  return null;
}

/** Which kind the header checkbox targets when nothing is selected yet. */
const KIND_PRIORITY: readonly SelectionKind[] = ['claim', 'resume', 'edit'];

function actionLabel(kind: SelectionKind, count: number): string {
  const plural = count === 1 ? '' : 's';
  switch (kind) {
    case 'claim':
      return count === 1 ? 'Claim item' : `Claim ${count} items`;
    case 'resume':
      return count === 1 ? 'Resume counting' : `Resume counting ${count} items`;
    case 'edit':
      return count === 1 ? 'Edit submitted item' : `Edit ${count} submitted item${plural}`;
  }
}

const KIND_NOUN: Record<SelectionKind, string> = {
  claim: 'unclaimed',
  resume: 'in-progress',
  edit: 'submitted',
};

/**
 * Where a row leads when its name is clicked, or null when it leads nowhere.
 *
 * This replaced the Action column: navigation now hangs off the item name, so
 * the row still reaches the count screen and the submitted result without a
 * column of competing buttons.
 */
function itemDestination(item: WorkspaceItem, recheckId: string): string | null {
  if (item.workflowStatus === 'submitted') {
    return `/app/rechecks/${recheckId}/items/${item.id}/submitted`;
  }
  if (item.workflowStatus === 'counting_in_progress' && item.isClaimedByMe) {
    // The multi-item screen, which already holds every item this user claimed —
    // not the single-item page, which would drop the rest of the session.
    return `/app/rechecks/${recheckId}/count`;
  }
  return null;
}

/** The item name: a link when the row has a destination, plain text otherwise. */
function ItemNameCell({
  item,
  recheckId,
}: {
  item: WorkspaceItem;
  recheckId: string;
}): React.JSX.Element {
  const destination = itemDestination(item, recheckId);
  if (destination === null) return <span>{item.itemName}</span>;
  return (
    <Link
      to={destination}
      className="text-[var(--color-brand)] underline-offset-2 hover:underline"
    >
      {item.itemName}
    </Link>
  );
}

/**
 * Header checkbox: selects or clears every claimable row on the current page.
 *
 * Uses the DOM `indeterminate` property for a partial selection. It cannot be
 * set through JSX — React has no `indeterminate` attribute — so it is applied
 * via a ref callback. Without it a partial selection would render as unticked
 * and clicking once would appear to do nothing.
 */
function SelectAllCheckbox({
  targets,
  kind,
  selectedIds,
  onChange,
}: {
  /** Rows of the active kind only — a selection is never mixed. */
  targets: WorkspaceItem[];
  kind: SelectionKind | null;
  selectedIds: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
}): React.JSX.Element | null {
  if (kind === null || targets.length === 0) return null;

  const selectedHere = targets.filter((item) => selectedIds.has(item.id)).length;
  const allSelected = selectedHere === targets.length;

  return (
    <input
      type="checkbox"
      checked={allSelected}
      ref={(node) => {
        if (node !== null) node.indeterminate = selectedHere > 0 && !allSelected;
      }}
      onChange={() => onChange(allSelected ? new Set() : new Set(targets.map((item) => item.id)))}
      aria-label={allSelected ? 'Clear selection' : `Select all ${KIND_NOUN[kind]} items`}
      className="h-4 w-4 rounded border-[var(--color-border-strong)] accent-[var(--color-brand)]"
    />
  );
}

function ItemStatusBadge({ item }: { item: WorkspaceItem }): React.JSX.Element {
  if (item.workflowStatus === 'submitted') {
    return (
      <Badge tone={item.resultStatus === 'matched' ? 'success' : 'danger'}>
        {item.resultStatus === 'matched' ? 'Matched' : 'Mismatched'}
      </Badge>
    );
  }
  if (item.workflowStatus === 'counting_in_progress') {
    // Section 19: a distinct, highlighted badge when it is the current user.
    return item.isClaimedByMe ? (
      // A person icon rather than the tone's default progress ring: at a glance
      // this must read as "yours", not merely "in progress".
      <Badge tone="info" icon={<UserIcon size={13} strokeWidth={2} />}>
        You are counting
      </Badge>
    ) : (
      <Badge tone="warning">Counting in progress</Badge>
    );
  }
  return <Badge tone="neutral">Available</Badge>;
}

