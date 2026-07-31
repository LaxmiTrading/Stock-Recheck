/**
 * Screen 6: common import result — specification section 17.
 *
 * This screen is structurally IDENTICAL whether the source was Excel or
 * pasted text. Only the "Source" line differs.
 */

import { useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IMPORT_SOURCE_LABEL, type ImportSourceType } from '@/domain/failureCodes';
import { ApiError, apiDownload, apiRequest } from '@/services/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  InlineNotice,
  Spinner,
  StatCard,
  Tabs,
  useToast,
} from '@/components/ui';
import { CheckCircleIcon, SearchIcon } from '@/components/icons';
import { useImportWizard } from './ImportWizardContext';

interface PassedRow {
  sourceRow: number;
  itemName: string;
  sku: string;
  zohoStock: number;
  vendor: string | null;
  unit: string | null;
  stockBasisType: string | null;
  stockBasisName: string | null;
}

interface FailedRow {
  sourceRow: number;
  rawValue: string;
  normalizedSku: string;
  failureCode: string;
  failureReason: string;
  duplicateOfRowNumber: number | null;
  retryable: boolean;
}

interface ImportResultResponse {
  importBatchId: string;
  sourceType: ImportSourceType;
  sourceFileName: string | null;
  status: string;
  summary: {
    totalSourceRows: number;
    passed: number;
    failed: number;
    duplicates: number;
    ignoredBlanks: number;
  };
  passedRows: PassedRow[];
  failedRows: FailedRow[];
  hasRetryableFailures: boolean;
}

type TabValue = 'all' | 'passed' | 'failed' | 'duplicates';

export default function ImportResultPage(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { draft } = useImportWizard();
  const batchId = draft.importBatchId;

  const [tab, setTab] = useState<TabValue>('all');

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['import', batchId, 'result'],
    queryFn: () => apiRequest<ImportResultResponse>(`/api/imports/${batchId}`),
    enabled: batchId !== null,
  });

  const retryMutation = useMutation({
    mutationFn: (sourceRowNumbers?: number[]) =>
      apiRequest(`/api/imports/${batchId}/retry`, {
        method: 'POST',
        body: sourceRowNumbers === undefined ? {} : { sourceRowNumbers },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['import', batchId, 'result'] });
      toast.push({ tone: 'success', title: 'Retry complete', description: 'Rows were re-checked.' });
    },
    onError: (caught) => {
      toast.push({
        tone: 'danger',
        title: 'Retry failed',
        description: caught instanceof ApiError ? caught.message : 'Try again.',
      });
    },
  });

  const duplicateRows = useMemo(
    () => data?.failedRows.filter((row) => row.failureCode === 'DUPLICATE_IN_IMPORT') ?? [],
    [data?.failedRows],
  );

  if (batchId === null) return <Navigate to="../source" replace />;

  if (isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size={28} label="Loading import result" />
      </div>
    );
  }

  if (error !== null) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.message : 'The import result could not be loaded.'}
        correlationId={error instanceof ApiError ? error.correlationId : undefined}
        action={
          <Button variant="primary" onClick={() => void refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  const { summary, passedRows, failedRows } = data;
  // Section 17: passed + failed + ignored blanks must reconcile with the source.
  const reconciles = summary.passed + summary.failed + summary.ignoredBlanks === summary.totalSourceRows;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold">Import Review</h3>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Source: {IMPORT_SOURCE_LABEL[data.sourceType]}
            {data.sourceFileName !== null && ` · ${data.sourceFileName}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {failedRows.length > 0 && (
            <Button
              onClick={() =>
                void apiDownload(`/api/imports/${batchId}/failures.xlsx`).catch((caught) =>
                  toast.push({
                    tone: 'danger',
                    title: 'Download failed',
                    description: caught instanceof ApiError ? caught.message : 'Try again.',
                  }),
                )
              }
            >
              Download Failed Rows
            </Button>
          )}
          {data.hasRetryableFailures && (
            <Button
              onClick={() => retryMutation.mutate(undefined)}
              loading={retryMutation.isPending}
              loadingText="Retrying…"
            >
              Retry All Temporary Failures
            </Button>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------- summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <StatCard label="Total source rows" value={summary.totalSourceRows} />
        <StatCard label="Passed" value={summary.passed} tone="success" />
        <StatCard
          label="Failed"
          value={summary.failed}
          tone={summary.failed > 0 ? 'danger' : 'neutral'}
        />
        <StatCard label="Duplicates" value={summary.duplicates} tone="warning" />
        <StatCard label="Ignored blanks" value={summary.ignoredBlanks} tone="muted" />
      </div>

      {!reconciles && (
        <InlineNotice tone="warning">
          The row counts do not reconcile with the source row count. Review the failed rows before
          creating the Stock Recheck.
        </InlineNotice>
      )}

      {summary.passed === 0 && (
        <InlineNotice tone="danger">
          No rows passed validation, so there is nothing to count. Correct the source and import
          again.
        </InlineNotice>
      )}

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'all', label: 'All', count: summary.totalSourceRows },
          { value: 'passed', label: 'Passed', count: summary.passed },
          { value: 'failed', label: 'Failed', count: summary.failed },
          { value: 'duplicates', label: 'Duplicates', count: duplicateRows.length },
        ]}
      />

      {/* ------------------------------------------------------ passed table */}
      {(tab === 'all' || tab === 'passed') && (
        <section aria-label="Passed rows" className="space-y-2">
          <h4 className="text-sm font-semibold">Passed ({passedRows.length})</h4>
          {passedRows.length === 0 ? (
            <EmptyState
              icon={<SearchIcon size={22} />}
              title="No rows passed"
              message="Every row failed validation. Check the Failed tab for the specific reason on each row."
            />
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
                  <tr>
                    <th scope="col" className="px-3 py-2">Row</th>
                    <th scope="col" className="px-3 py-2">Item Name</th>
                    <th scope="col" className="px-3 py-2">SKU</th>
                    <th scope="col" className="px-3 py-2">Zoho Stock</th>
                    <th scope="col" className="px-3 py-2">Vendor</th>
                    <th scope="col" className="px-3 py-2">Unit</th>
                    <th scope="col" className="px-3 py-2">Stock Basis</th>
                    <th scope="col" className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {passedRows.map((row) => (
                    <tr key={row.sourceRow} className="border-t border-[var(--color-border)]">
                      <td className="tabular px-3 py-2 text-xs text-[var(--color-ink-subtle)]">
                        {row.sourceRow}
                      </td>
                      <td className="px-3 py-2 font-medium">{row.itemName}</td>
                      <td className="px-3 py-2 font-mono">{row.sku}</td>
                      <td className="tabular px-3 py-2">{row.zohoStock}</td>
                      <td className="px-3 py-2">{row.vendor ?? 'Not available in Zoho'}</td>
                      <td className="px-3 py-2">{row.unit ?? 'Not specified'}</td>
                      <td className="px-3 py-2 text-xs">
                        {row.stockBasisName ?? row.stockBasisType ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone="success">Passed</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      )}

      {/* ------------------------------------------------------ failed table */}
      {(tab === 'all' || tab === 'failed' || tab === 'duplicates') && (
        <section aria-label="Failed rows" className="space-y-2">
          <h4 className="text-sm font-semibold">
            {tab === 'duplicates' ? `Duplicates (${duplicateRows.length})` : `Failed (${failedRows.length})`}
          </h4>
          {(tab === 'duplicates' ? duplicateRows : failedRows).length === 0 ? (
            <EmptyState
              icon={<CheckCircleIcon size={22} />}
              title={tab === 'duplicates' ? 'No duplicates' : 'No failures'}
              message={
                tab === 'duplicates'
                  ? 'Every SKU appeared only once in this import.'
                  : 'Every row passed validation against Zoho Books.'
              }
            />
          ) : (
            <Card className="overflow-x-auto p-0">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
                  <tr>
                    <th scope="col" className="px-3 py-2">Row</th>
                    <th scope="col" className="px-3 py-2">Raw Value</th>
                    <th scope="col" className="px-3 py-2">Normalized SKU</th>
                    <th scope="col" className="px-3 py-2">Failure Reason</th>
                    <th scope="col" className="px-3 py-2">Failure Code</th>
                    <th scope="col" className="px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {(tab === 'duplicates' ? duplicateRows : failedRows).map((row) => (
                    <tr key={row.sourceRow} className="border-t border-[var(--color-border)]">
                      <td className="tabular px-3 py-2 text-xs text-[var(--color-ink-subtle)]">
                        {row.sourceRow}
                      </td>
                      <td className="px-3 py-2 font-mono">{row.rawValue || <em>(blank)</em>}</td>
                      <td className="px-3 py-2 font-mono">{row.normalizedSku || <em>—</em>}</td>
                      <td className="px-3 py-2">{row.failureReason}</td>
                      <td className="px-3 py-2">
                        <code className="rounded bg-[var(--color-surface-sunken)] px-1.5 py-0.5 text-xs">
                          {row.failureCode}
                        </code>
                      </td>
                      <td className="px-3 py-2">
                        {/* Section 17: Retry only for retryable failures. */}
                        {row.retryable ? (
                          <Button
                            size="sm"
                            onClick={() => retryMutation.mutate([row.sourceRow])}
                            disabled={retryMutation.isPending}
                          >
                            Retry
                          </Button>
                        ) : (
                          <span className="text-xs text-[var(--color-ink-subtle)]">
                            Fix the source
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </section>
      )}

      {/* ----------------------------------------------------------- actions */}
      <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--color-border)] pt-4">
        <Button
          onClick={() =>
            navigate(data.sourceType === 'excel' ? '../excel/preview' : '../text/entry')
          }
        >
          Back to Edit
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={summary.passed === 0}
          onClick={() => navigate('../confirm')}
        >
          Create Stock Recheck
        </Button>
      </div>

      <p className="text-xs text-[var(--color-ink-subtle)]">
        Editing the source and re-importing recalculates every validation result.
      </p>
    </div>
  );
}
