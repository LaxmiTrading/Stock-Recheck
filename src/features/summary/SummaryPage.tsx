/**
 * Screen 11: summary and Excel export — specification section 25.
 *
 * Labelled "Current Summary" while incomplete and "Final Summary" once every
 * item has been submitted. The workbook format never changes with the filter.
 */

import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  EXPORT_FILTER_LABEL,
  EXPORT_FILTERS,
  exportButtonLabel,
  type ExportFilter,
} from '@/domain/exportContract';
import { formatQuantity, formatSignedQuantity } from '@/domain/quantity';
import { formatDateTime } from '@/domain/recheckNumber';
import { describeStockBasis } from '@/domain/stockBasis';
import { RECHECK_STATUS_LABEL, recheckStatusTone } from '@/domain/status';
import type { SummaryItemsResponse, SummaryResponse } from './types';
import { PAGE_SIZE_OPTIONS } from '@/domain/settings';
import { ApiError, apiDownload, apiRequest } from '@/services/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineNotice,
  LinkButton,
  Pagination,
  Select,
  Spinner,
  StatCard,
  Tabs,
  useToast,
} from '@/components/ui';
import { ArrowLeftIcon, DownloadIcon, SearchIcon } from '@/components/icons';

type TabValue = 'all' | 'matched' | 'mismatched' | 'not_counted' | 'in_progress';

export default function SummaryPage({
  exportFocus = false,
}: {
  exportFocus?: boolean;
}): React.JSX.Element {
  const { recheckId = '' } = useParams();
  const toast = useToast();

  const [tab, setTab] = useState<TabValue>('all');
  const [filter, setFilter] = useState<ExportFilter>('all_submitted');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [downloading, setDownloading] = useState(false);

  const summaryQuery = useQuery({
    queryKey: ['recheck', recheckId, 'summary'],
    queryFn: () => apiRequest<SummaryResponse>(`/api/rechecks/${recheckId}/summary`),
  });

  const itemFilters = useMemo(() => {
    switch (tab) {
      case 'matched':
        return { resultStatus: 'matched' as const };
      case 'mismatched':
        return { resultStatus: 'mismatched' as const };
      case 'not_counted':
        return { workflowStatus: 'available' as const };
      case 'in_progress':
        return { workflowStatus: 'counting_in_progress' as const };
      case 'all':
        return {};
    }
  }, [tab]);

  const itemsQuery = useQuery({
    queryKey: ['recheck', recheckId, 'summary-items', { tab, page, pageSize }],
    queryFn: () =>
      apiRequest<SummaryItemsResponse>(`/api/rechecks/${recheckId}/items`, {
        searchParams: { ...itemFilters, page, pageSize, sort: 'item_name' },
      }),
    placeholderData: (previous) => previous,
  });

  const download = async (): Promise<void> => {
    setDownloading(true);
    try {
      const { fileName } = await apiDownload(`/api/rechecks/${recheckId}/export.xlsx`, { filter });
      toast.push({ tone: 'success', title: 'Export downloaded', description: fileName });
    } catch (error) {
      toast.push({
        tone: 'danger',
        title: 'Export failed',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    } finally {
      setDownloading(false);
    }
  };

  if (summaryQuery.isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} label="Loading summary" />
      </div>
    );
  }

  if (summaryQuery.error !== null || summaryQuery.data === undefined) {
    return (
      <ErrorState
        message={
          summaryQuery.error instanceof ApiError
            ? summaryQuery.error.message
            : 'The summary could not be loaded.'
        }
        correlationId={
          summaryQuery.error instanceof ApiError ? summaryQuery.error.correlationId : undefined
        }
        action={<LinkButton to="/app/rechecks">Back to Rechecks</LinkButton>}
      />
    );
  }

  const { recheck, totals, isComplete, message } = summaryQuery.data;
  const items = itemsQuery.data?.items ?? [];
  const pagination = itemsQuery.data?.pagination;

  return (
    <div className="space-y-5">
      <header className="space-y-2">
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
            <h2 className="text-xl font-semibold">
              {isComplete ? 'Final Summary' : 'Current Summary'}
            </h2>
            <p className="text-sm text-[var(--color-ink-muted)]">
              {recheck.name} · {recheck.businessDate}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={recheckStatusTone(recheck.status)}>
              {RECHECK_STATUS_LABEL[recheck.status]}
            </Badge>
            <LinkButton to={`/app/rechecks/${recheckId}/workspace`}>Back to workspace</LinkButton>
          </div>
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="inline text-[var(--color-ink-subtle)]">Organization: </dt>
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
          <div>
            <dt className="inline text-[var(--color-ink-subtle)]">Completion: </dt>
            <dd className="tabular inline">{recheck.completionPercentage}%</dd>
          </div>
        </dl>
      </header>

      <InlineNotice tone={isComplete ? 'success' : 'info'}>{message}</InlineNotice>

      {/* ---------------------------------------------------- summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <StatCard label="Total Items" value={totals.totalItems} />
        <StatCard label="Submitted" value={totals.submitted} tone="success" />
        <StatCard label="Remaining" value={totals.remaining} />
        <StatCard label="Counting" value={totals.countingInProgress} tone="info" />
        <StatCard label="Matched" value={totals.matched} tone="success" />
        <StatCard
          label="Mismatched"
          value={totals.mismatched}
          tone={totals.mismatched > 0 ? 'danger' : 'neutral'}
        />
        <StatCard
          label="Total Positive Diff"
          value={formatSignedQuantity(totals.totalPositiveDifference)}
          tone={totals.totalPositiveDifference > 0 ? 'warning' : 'neutral'}
        />
        {/* Section 25: the negative total stays negative. */}
        <StatCard
          label="Total Negative Diff"
          value={formatSignedQuantity(totals.totalNegativeDifference)}
          tone={totals.totalNegativeDifference < 0 ? 'danger' : 'neutral'}
        />
      </div>

      {/* --------------------------------------------------------- export */}
      <Card
        className={`space-y-3 ${exportFocus ? 'border-[var(--color-brand)] ring-2 ring-[var(--color-brand)]' : ''}`}
      >
        <h3 className="text-base font-semibold">Download difference workbook</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          The workbook always contains exactly three columns — Item Name, SKU and Qty Difference —
          regardless of the filter.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Export filter
            <Select
              value={filter}
              onChange={(event) => setFilter(event.target.value as ExportFilter)}
              className="w-auto"
            >
              {EXPORT_FILTERS.map((option) => (
                <option key={option} value={option}>
                  {EXPORT_FILTER_LABEL[option]}
                </option>
              ))}
            </Select>
          </label>
          <Button
            variant="primary"
            size="lg"
            icon={<DownloadIcon size={17} />}
            loading={downloading}
            loadingText="Preparing…"
            disabled={totals.submitted === 0}
            onClick={() => void download()}
          >
            {exportButtonLabel(isComplete)}
          </Button>
        </div>
        {totals.submitted === 0 && (
          <p className="text-xs text-[var(--color-ink-subtle)]">
            No items have been submitted yet, so there is nothing to export.
          </p>
        )}
      </Card>

      {/* ---------------------------------------------------- summary table */}
      <Tabs
        value={tab}
        onChange={(next) => {
          setTab(next);
          setPage(1);
        }}
        tabs={[
          { value: 'all', label: 'All', count: totals.totalItems },
          { value: 'matched', label: 'Matched', count: totals.matched },
          { value: 'mismatched', label: 'Mismatched', count: totals.mismatched },
          { value: 'not_counted', label: 'Not Counted', count: totals.remaining },
          { value: 'in_progress', label: 'Counting', count: totals.countingInProgress },
        ]}
      />

      {itemsQuery.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner size={28} label="Loading items" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<SearchIcon size={22} />}
          title="No items in this view"
          message="Try a different tab to see the rest of this Stock Recheck."
        />
      ) : (
        <>
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
                <tr>
                  <th scope="col" className="px-3 py-2">Item Name</th>
                  <th scope="col" className="px-3 py-2">SKU</th>
                  <th scope="col" className="px-3 py-2">Zoho Stock</th>
                  <th scope="col" className="px-3 py-2">Counted</th>
                  <th scope="col" className="px-3 py-2">Qty Difference</th>
                  <th scope="col" className="px-3 py-2">Result</th>
                  <th scope="col" className="px-3 py-2">Submitted By</th>
                  <th scope="col" className="px-3 py-2">Submitted Time</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-t border-[var(--color-border)]">
                    <td className="px-3 py-2 font-medium">{item.itemName}</td>
                    <td className="px-3 py-2 font-mono">{item.sku}</td>
                    <td className="tabular px-3 py-2">
                      {item.zohoStock === null ? '—' : formatQuantity(item.zohoStock)}
                    </td>
                    <td className="tabular px-3 py-2">{item.countedQuantity ?? '—'}</td>
                    <td className="tabular px-3 py-2 font-semibold">
                      {item.quantityDifference === null
                        ? '—'
                        : formatSignedQuantity(item.quantityDifference)}
                    </td>
                    <td className="px-3 py-2">
                      {item.resultStatus === 'pending' ? (
                        <Badge tone="neutral">Pending</Badge>
                      ) : (
                        <Badge tone={item.resultStatus === 'matched' ? 'success' : 'danger'}>
                          {item.resultStatus === 'matched' ? 'Matched' : 'Mismatched'}
                        </Badge>
                      )}
                    </td>
                    <td className="px-3 py-2">{item.submittedByName ?? '—'}</td>
                    <td className="px-3 py-2 text-xs">{formatDateTime(item.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

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
    </div>
  );
}
