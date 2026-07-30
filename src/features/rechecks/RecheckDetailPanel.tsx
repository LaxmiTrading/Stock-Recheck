/**
 * Right-hand detail panel for a Stock Recheck.
 *
 * This is the detail surface for the list: selecting a row opens it here rather
 * than navigating away, so the operator keeps their filter, their search and
 * their scroll position while comparing one Recheck against the next.
 *
 * It carries the primary action (Open) in a pinned footer, so the panel is a
 * complete stop — read the numbers, then either start counting or close.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  EXPORT_FILTER_LABEL,
  EXPORT_FILTERS,
  type ExportFilter,
} from '@/domain/exportContract';
import { formatSignedQuantity } from '@/domain/quantity';
import { formatDateTime } from '@/domain/recheckNumber';
import { describeStockBasis } from '@/domain/stockBasis';
import { RECHECK_STATUS_LABEL, recheckStatusTone, type RecheckStatus } from '@/domain/status';
import { ApiError, apiDownload, apiRequest } from '@/services/api';
import type { SummaryResponse } from '@/features/summary/types';
import {
  Badge,
  Button,
  ErrorState,
  InlineNotice,
  LinkButton,
  ProgressBar,
  Select,
  Spinner,
  useToast,
} from '@/components/ui';
import { DownloadIcon, ExternalLinkIcon } from '@/components/icons';

/* --------------------------------------------------------------- fragments */

function Fact({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--color-ink-subtle)]">{label}</dt>
      <dd className="truncate text-sm">{value}</dd>
    </div>
  );
}

/**
 * A compact metric. The panel is narrow, so these are denser than the StatCard
 * used on the full-width screens — a grid of eight full cards would push the
 * export control below the fold on a laptop.
 */
function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'success' | 'danger' | 'info' | 'warning';
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2">
      <div
        className={clsx(
          'tabular text-lg font-semibold leading-tight',
          tone === 'success' && 'text-[var(--color-success)]',
          tone === 'danger' && 'text-[var(--color-danger)]',
          tone === 'info' && 'text-[var(--color-info)]',
          tone === 'warning' && 'text-[var(--color-warning)]',
        )}
      >
        {value}
      </div>
      <div className="text-xs text-[var(--color-ink-subtle)]">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

export function RecheckDetailPanel({
  recheckId,
  fallbackStatus,
}: {
  recheckId: string;
  /** Shown in the header while the summary request is still in flight. */
  fallbackStatus?: RecheckStatus;
}): React.JSX.Element {
  const toast = useToast();
  const [filter, setFilter] = useState<ExportFilter>('all_submitted');
  const [downloading, setDownloading] = useState(false);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['recheck', recheckId, 'summary'],
    queryFn: () => apiRequest<SummaryResponse>(`/api/rechecks/${recheckId}/summary`),
  });

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const { fileName } = await apiDownload(`/api/rechecks/${recheckId}/export.xlsx`, { filter });
      toast.push({ tone: 'success', title: 'Export downloaded', description: fileName });
    } catch (downloadError) {
      toast.push({
        tone: 'danger',
        title: 'Export failed',
        description: downloadError instanceof ApiError ? downloadError.message : 'Try again.',
      });
    } finally {
      setDownloading(false);
    }
  };

  if (isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={26} label="Loading details" />
      </div>
    );
  }

  if (error !== null || data === undefined) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.message : 'The details could not be loaded.'}
        correlationId={error instanceof ApiError ? error.correlationId : undefined}
        action={
          <Button variant="primary" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const { recheck, totals, isComplete, message } = data;
  const status = recheck.status ?? fallbackStatus;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={recheckStatusTone(status)}>{RECHECK_STATUS_LABEL[status]}</Badge>
        <span className="text-xs text-[var(--color-ink-subtle)]">
          {isComplete ? 'Final Summary' : 'Current Summary'}
        </span>
      </div>

      <ProgressBar
        value={totals.submitted}
        max={totals.totalItems}
        label={`${totals.submitted} of ${totals.totalItems} submitted`}
      />

      <InlineNotice tone={isComplete ? 'success' : 'info'}>{message}</InlineNotice>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-subtle)]">
          Progress
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Total" value={totals.totalItems} />
          <Metric label="Submitted" value={totals.submitted} tone="success" />
          <Metric label="Remaining" value={totals.remaining} />
          <Metric label="Counting" value={totals.countingInProgress} tone="info" />
          <Metric label="Matched" value={totals.matched} tone="success" />
          <Metric
            label="Mismatched"
            value={totals.mismatched}
            tone={totals.mismatched > 0 ? 'danger' : undefined}
          />
          <Metric
            label="Positive diff"
            value={formatSignedQuantity(totals.totalPositiveDifference)}
            tone={totals.totalPositiveDifference > 0 ? 'warning' : undefined}
          />
          {/* Section 25: the negative total stays negative. */}
          <Metric
            label="Negative diff"
            value={formatSignedQuantity(totals.totalNegativeDifference)}
            tone={totals.totalNegativeDifference < 0 ? 'danger' : undefined}
          />
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-subtle)]">
          Details
        </h3>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Fact label="Business date" value={recheck.businessDate} />
          <Fact label="Completion" value={`${recheck.completionPercentage}%`} />
          <Fact label="Organization" value={recheck.organization.name ?? 'Not available'} />
          <Fact label="Stock basis" value={describeStockBasis(recheck.stockBasis)} />
          <Fact label="Stock last read" value={formatDateTime(recheck.zohoSnapshotAt)} />
        </dl>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-ink-subtle)]">
          Export
        </h3>
        <p className="mb-2 text-xs text-[var(--color-ink-muted)]">
          Always three columns — Item Name, SKU and Qty Difference — whatever the filter.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={filter}
            onChange={(event) => setFilter(event.target.value as ExportFilter)}
            aria-label="Export filter"
            className="w-auto min-h-[36px] flex-1 py-1"
          >
            {EXPORT_FILTERS.map((option) => (
              <option key={option} value={option}>
                {EXPORT_FILTER_LABEL[option]}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            icon={<DownloadIcon size={15} />}
            loading={downloading}
            loadingText="Preparing…"
            disabled={totals.submitted === 0}
            onClick={() => void download()}
          >
            Export
          </Button>
        </div>
        {totals.submitted === 0 && (
          <p className="mt-2 text-xs text-[var(--color-ink-subtle)]">
            Nothing has been submitted yet, so there is nothing to export.
          </p>
        )}
      </section>

      <LinkButton
        to={`/app/rechecks/${recheckId}/summary`}
        size="sm"
        variant="ghost"
        icon={<ExternalLinkIcon size={15} />}
        className="px-0"
      >
        Open the full summary table
      </LinkButton>
    </div>
  );
}
