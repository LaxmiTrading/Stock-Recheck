/**
 * Screen 5: validation progress — specification section 15.
 *
 * Validation itself runs server-side in a single call. This route exists so a
 * refresh mid-validation lands somewhere sensible: it polls the batch and
 * forwards to the result screen once validation has finished.
 */

import { useEffect } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/services/api';
import { Button, Card, ProgressBar, Spinner } from '@/components/ui';
import { useImportWizard } from './ImportWizardContext';

interface ImportStatusResponse {
  status: 'draft' | 'validating' | 'validated' | 'cancelled' | 'consumed';
  summary: {
    totalSourceRows: number;
    passed: number;
    failed: number;
    duplicates: number;
    ignoredBlanks: number;
  };
}

/** Section 15 stage list, shown so the operator knows work is progressing. */
const STAGES = [
  'Preparing rows',
  'Removing blanks',
  'Detecting duplicates',
  'Checking local Zoho cache',
  'Fetching items from Zoho',
  'Fetching item details',
  'Resolving brand and manufacturer',
  'Resolving stock basis',
  'Building result',
] as const;

export default function ValidationPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { draft } = useImportWizard();
  const batchId = draft.importBatchId;

  const { data } = useQuery({
    queryKey: ['import', batchId, 'status'],
    queryFn: () => apiRequest<ImportStatusResponse>(`/api/imports/${batchId}`),
    enabled: batchId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === 'validating' || query.state.data === undefined ? 2000 : false,
  });

  useEffect(() => {
    if (data?.status === 'validated') navigate('../import-result', { replace: true });
  }, [data?.status, navigate]);

  if (batchId === null) return <Navigate to="../source" replace />;

  const processed = (data?.summary.passed ?? 0) + (data?.summary.failed ?? 0);
  const total = data?.summary.totalSourceRows ?? 0;

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Spinner size={24} label="Validating" />
        <div>
          <h3 className="text-base font-semibold">Validating against Zoho Books</h3>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Reading item data only. Nothing is written to Zoho.
          </p>
        </div>
      </div>

      <ProgressBar
        value={processed}
        max={Math.max(1, total)}
        label={`${processed.toLocaleString()} of ${total.toLocaleString()} rows processed`}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Processed</p>
          <p className="tabular text-xl font-semibold">{processed}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Total</p>
          <p className="tabular text-xl font-semibold">{total}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Passed</p>
          <p className="tabular text-xl font-semibold text-[var(--color-success)]">
            {data?.summary.passed ?? 0}
          </p>
        </Card>
        <Card>
          <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Failed</p>
          <p className="tabular text-xl font-semibold text-[var(--color-danger)]">
            {data?.summary.failed ?? 0}
          </p>
        </Card>
      </div>

      <Card className="bg-[var(--color-surface-raised)]">
        <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Stages</p>
        <ol className="mt-2 space-y-1 text-sm text-[var(--color-ink-muted)]">
          {STAGES.map((stage) => (
            <li key={stage} className="flex items-center gap-2">
              <span aria-hidden="true">·</span>
              {stage}
            </li>
          ))}
        </ol>
      </Card>

      <div className="flex justify-end border-t border-[var(--color-border)] pt-4">
        <Button onClick={() => navigate('../import-result')}>Go to results</Button>
      </div>
    </div>
  );
}
