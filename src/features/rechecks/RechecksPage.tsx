/**
 * Rechecks — the single destination that replaced the separate Dashboard,
 * Active Rechecks and History screens.
 *
 * Everything ever created is listed here with its status; the filter chips
 * narrow the same list rather than navigating somewhere else. Splitting
 * "active" from "history" only ever forced the operator to guess which screen
 * a Stock Recheck had moved to.
 *
 * Selecting a row opens its detail in the right-hand panel instead of
 * navigating to a separate summary page, so the list — with its filter, search
 * and scroll position — stays put while the operator compares one Recheck
 * against another. The panel carries the primary "Open" action.
 */

import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { isAdministrator } from '@/domain/permissions';
import {
  RECHECK_STATUS_LABEL,
  recheckStatusTone,
  type RecheckStatus,
  type StatusTone,
} from '@/domain/status';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError, apiRequest } from '@/services/api';
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  ErrorState,
  LinkButton,
  ProgressBar,
  Spinner,
  TextInput,
} from '@/components/ui';
import {
  ChevronRightIcon,
  ClipboardCheckIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
} from '@/components/icons';
import { RecheckDetailPanel } from './RecheckDetailPanel';

interface Recheck {
  id: string;
  recheckNumber: string;
  name: string;
  businessDate: string;
  status: RecheckStatus;
  createdByName: string | null;
  counts: {
    totalItems: number;
    availableItems: number;
    inProgressItems: number;
    submittedItems: number;
  };
  completionPercentage: number;
  mismatchedItems?: number;
}

/**
 * Chip filters. `open` is the default because that is what an operator
 * arriving for a shift needs; the others are one click away.
 */
type FilterKey = 'open' | 'all' | 'in_progress' | 'completed' | 'cancelled';

const FILTERS: { key: FilterKey; label: string; statuses?: RecheckStatus[]; tone: StatusTone }[] = [
  { key: 'open', label: 'Open', statuses: ['ready', 'in_progress'], tone: 'info' },
  { key: 'in_progress', label: 'In Progress', statuses: ['in_progress'], tone: 'info' },
  { key: 'completed', label: 'Completed', statuses: ['completed'], tone: 'success' },
  { key: 'cancelled', label: 'Cancelled', statuses: ['cancelled'], tone: 'muted' },
  { key: 'all', label: 'All', tone: 'neutral' },
];

const CHIP_TONE: Record<StatusTone, string> = {
  info: 'bg-[var(--color-brand)] text-white border-[var(--color-brand)]',
  success: 'bg-[var(--color-success)] text-white border-[var(--color-success)]',
  warning: 'bg-[var(--color-warning)] text-white border-[var(--color-warning)]',
  danger: 'bg-[var(--color-danger)] text-white border-[var(--color-danger)]',
  muted: 'bg-[var(--color-ink-muted)] text-white border-[var(--color-ink-muted)]',
  neutral: 'bg-[var(--color-ink)] text-white border-[var(--color-ink)]',
};

export default function RechecksPage(): React.JSX.Element {
  const { user } = useAuth();
  const isAdmin = user !== null && isAdministrator(user.role);
  const [filter, setFilter] = useState<FilterKey>('open');
  const [search, setSearch] = useState('');

  /*
   * The open panel lives in the query string rather than component state, so a
   * detail view is linkable and the browser Back button closes the panel
   * instead of leaving the list entirely.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get('details');

  const openDetails = (id: string): void => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.set('details', id);
        return next;
      },
      { replace: false },
    );
  };

  const closeDetails = (): void => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete('details');
        return next;
      },
      { replace: true },
    );
  };

  const { data, isPending, isFetching, error, refetch } = useQuery({
    // Every filter reads from one fetch of the full list, so switching chips is
    // instant and does not re-hit the API.
    queryKey: ['rechecks', 'all'],
    queryFn: () =>
      apiRequest<{ rechecks: Recheck[] }>('/api/rechecks', {
        searchParams: { pageSize: 200 },
      }),
  });

  const rechecks = useMemo(() => data?.rechecks ?? [], [data]);

  const counts = useMemo(() => {
    const tally: Record<FilterKey, number> = {
      open: 0,
      all: rechecks.length,
      in_progress: 0,
      completed: 0,
      cancelled: 0,
    };
    for (const recheck of rechecks) {
      if (recheck.status === 'ready' || recheck.status === 'in_progress') tally.open += 1;
      if (recheck.status === 'in_progress') tally.in_progress += 1;
      if (recheck.status === 'completed') tally.completed += 1;
      if (recheck.status === 'cancelled') tally.cancelled += 1;
    }
    return tally;
  }, [rechecks]);

  const visible = useMemo(() => {
    const active = FILTERS.find((entry) => entry.key === filter);
    const byStatus =
      active?.statuses === undefined
        ? rechecks
        : rechecks.filter((recheck) => active.statuses?.includes(recheck.status) === true);

    const query = search.trim().toLowerCase();
    const bySearch =
      query === ''
        ? byStatus
        : byStatus.filter(
            (recheck) =>
              recheck.recheckNumber.toLowerCase().includes(query) ||
              recheck.name.toLowerCase().includes(query),
          );

    // Newest business date first, then by recheck number so the order is stable.
    return [...bySearch].sort((a, b) =>
      a.businessDate === b.businessDate
        ? b.recheckNumber.localeCompare(a.recheckNumber)
        : b.businessDate.localeCompare(a.businessDate),
    );
  }, [rechecks, filter, search]);

  /* Resolved against the FULL list, not the filtered view: a panel opened from
     a deep link must render even when the current chip excludes that row. */
  const selected = useMemo(
    () => rechecks.find((recheck) => recheck.id === selectedId) ?? null,
    [rechecks, selectedId],
  );

  if (isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} label="Loading Stock Rechecks" />
      </div>
    );
  }

  if (error !== null) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.message : 'The list could not be loaded.'}
        correlationId={error instanceof ApiError ? error.correlationId : undefined}
        action={
          <Button variant="primary" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Stock Rechecks</h2>
          <p className="text-sm text-[var(--color-ink-muted)]">Every Stock Recheck, newest first.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={() => void refetch()}
            loading={isFetching}
            icon={<RefreshIcon size={15} />}
          >
            Refresh
          </Button>
          {isAdmin && (
            <LinkButton variant="primary" to="/app/rechecks/new/source" icon={<PlusIcon size={15} />}>
              New Stock Recheck
            </LinkButton>
          )}
        </div>
      </div>

      <Card className="p-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border)] p-3">
          {FILTERS.map((entry) => {
            const active = filter === entry.key;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setFilter(entry.key)}
                aria-pressed={active}
                className={clsx(
                  'inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors',
                  active
                    ? clsx(CHIP_TONE[entry.tone], 'font-semibold')
                    : 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-ink)] hover:bg-[var(--color-row-hover)]',
                )}
              >
                {entry.label}
                <span
                  className={clsx(
                    'tabular min-w-[18px] rounded-full px-1.5 text-center text-xs font-bold',
                    active
                      ? 'bg-white/25 text-white'
                      : 'bg-[var(--color-neutral-bg)] text-[var(--color-ink-muted)]',
                  )}
                >
                  {counts[entry.key]}
                </span>
              </button>
            );
          })}
          <div className="relative ml-auto w-full sm:w-64">
            <SearchIcon
              size={15}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-ink-subtle)]"
            />
            <TextInput
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search number or name"
              aria-label="Search Stock Rechecks"
              className="pl-9"
            />
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={<ClipboardCheckIcon size={22} />}
            title="Nothing to show"
            message={
              search.trim() !== ''
                ? 'No Stock Recheck matches that search.'
                : isAdmin
                  ? 'Import a list of SKUs to start counting.'
                  : 'Nothing is open for counting right now.'
            }
            action={
              isAdmin && search.trim() === '' ? (
                <LinkButton variant="primary" to="/app/rechecks/new/source">
                  New Stock Recheck
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {visible.map((recheck) => (
              <li key={recheck.id} className="animate-row-in">
                {/*
                 * The whole row is the control that opens the panel. One target
                 * is easier to hit than a pair of small buttons, and it removes
                 * the nested-interactive problem a clickable row containing
                 * links would otherwise have.
                 */}
                <button
                  type="button"
                  onClick={() => openDetails(recheck.id)}
                  aria-haspopup="dialog"
                  aria-expanded={selectedId === recheck.id}
                  className={clsx(
                    'grid w-full gap-3 p-4 text-left transition-colors hover:bg-[var(--color-row-hover)]',
                    /*
                     * The trailing column is a FIXED width, not `auto`. With
                     * `auto` it sized to its own content, so a row badged
                     * "In Progress" left less room for the middle column than
                     * one badged "Ready" — and the progress bars, which fill
                     * that column, ended at different x-positions down the
                     * list. A fixed track makes every bar the same width.
                     */
                    'md:grid-cols-[minmax(0,1.7fr)_minmax(0,2fr)_13rem] md:items-center',
                    selectedId === recheck.id && 'bg-[var(--color-brand-subtle)]',
                  )}
                >
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-[var(--color-ink-subtle)]">
                      {recheck.recheckNumber}
                    </p>
                    <h3 className="truncate font-semibold">{recheck.name}</h3>
                    <p className="truncate text-xs text-[var(--color-ink-subtle)]">
                      {recheck.businessDate} · {recheck.createdByName ?? 'Unknown'}
                    </p>
                  </div>

                  <div className="min-w-0 space-y-1.5">
                    <ProgressBar
                      value={recheck.counts.submittedItems}
                      max={recheck.counts.totalItems}
                      label={`${recheck.counts.submittedItems} of ${recheck.counts.totalItems} submitted`}
                    />
                    <p className="tabular text-xs text-[var(--color-ink-subtle)]">
                      {recheck.counts.availableItems} available · {recheck.counts.inProgressItems}{' '}
                      counting · {recheck.counts.submittedItems} submitted
                    </p>
                  </div>

                  <div className="flex items-center gap-2 justify-self-start md:justify-self-end">
                    <Badge tone={recheckStatusTone(recheck.status)}>
                      {RECHECK_STATUS_LABEL[recheck.status]}
                    </Badge>
                    <span className="text-[var(--color-ink-subtle)]">
                      <ChevronRightIcon size={18} />
                    </span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ------------------------------------------------- detail side panel */}
      <Drawer
        open={selectedId !== null}
        onClose={closeDetails}
        width="lg"
        title={selected?.name ?? 'Stock Recheck'}
        subtitle={
          selected === null ? undefined : (
            <span className="font-mono">{selected.recheckNumber}</span>
          )
        }
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button onClick={closeDetails}>Close</Button>
            {selectedId !== null && (
              <LinkButton variant="primary" to={`/app/rechecks/${selectedId}/workspace`}>
                Open
              </LinkButton>
            )}
          </div>
        }
      >
        {selectedId !== null && (
          <RecheckDetailPanel recheckId={selectedId} fallbackStatus={selected?.status} />
        )}
      </Drawer>
    </div>
  );
}
