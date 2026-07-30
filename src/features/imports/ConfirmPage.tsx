/**
 * Screen 7: create Stock Recheck confirmation — specification section 18.
 *
 * Creation is idempotent: the key is generated once when the screen mounts, so
 * a double click or a network retry can never produce two Stock Rechecks.
 */

import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  businessDateInTimeZone,
  formatRecheckDisplayName,
  MAX_RECHECK_NAME_LENGTH,
} from '@/domain/recheckNumber';
import { describeStockBasis, STOCK_BASIS_TYPE_LABEL, type StockBasisType } from '@/domain/stockBasis';
import { useSettings } from '@/features/auth/AuthContext';
import { ApiError, apiRequest, newIdempotencyKey } from '@/services/api';
import {
  Button,
  Card,
  Checkbox,
  ErrorState,
  Field,
  InlineNotice,
  Spinner,
  TextInput,
} from '@/components/ui';
import { useImportWizard } from './ImportWizardContext';

interface ImportSummaryResponse {
  summary: { passed: number; failed: number; totalSourceRows: number };
  sourceType: 'excel' | 'text';
  stockBasis: {
    type: StockBasisType | null;
    locationId: string | null;
    locationName: string | null;
    warehouseId: string | null;
    warehouseName: string | null;
  };
  organization: { id: string | null; name: string | null };
  snapshotAt: string | null;
}

export default function ConfirmPage(): React.JSX.Element {
  const navigate = useNavigate();
  const settings = useSettings();
  const { draft, reset } = useImportWizard();
  const batchId = draft.importBatchId;

  // Generated ONCE per mount — this is what makes creation idempotent.
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const today = businessDateInTimeZone(new Date(), settings.businessTimezone);
  const [businessDate, setBusinessDate] = useState(today);
  const [name, setName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [nameError, setNameError] = useState<string>();

  const { data, isPending } = useQuery({
    queryKey: ['import', batchId, 'confirm'],
    queryFn: () => apiRequest<ImportSummaryResponse>(`/api/imports/${batchId}`),
    enabled: batchId !== null,
  });

  // Prefill the name once the business date is known.
  const defaultName = formatRecheckDisplayName(businessDate, 1, settings.businessTimezone);
  const effectiveName = name === '' ? defaultName : name;

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ recheckId: string; recheckNumber: string; itemCount: number }>(
        '/api/rechecks',
        {
          method: 'POST',
          body: {
            importBatchId: batchId,
            name: effectiveName.trim(),
            businessDate,
            acknowledgedReadOnly: true,
            idempotencyKey,
          },
        },
      ),
    onSuccess: (result) => {
      reset();
      navigate(`/app/rechecks/${result.recheckId}/workspace`, { replace: true });
    },
  });

  if (batchId === null) return <Navigate to="../source" replace />;

  if (isPending || data === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size={28} label="Loading import summary" />
      </div>
    );
  }

  const submit = (): void => {
    const trimmed = effectiveName.trim();
    if (trimmed.length === 0) {
      setNameError('Recheck name is required.');
      return;
    }
    if (trimmed.length > MAX_RECHECK_NAME_LENGTH) {
      setNameError(`Name must be ${MAX_RECHECK_NAME_LENGTH} characters or fewer.`);
      return;
    }
    setNameError(undefined);
    createMutation.mutate();
  };

  const stockBasis = {
    type: data.stockBasis.type ?? 'organization',
    locationId: data.stockBasis.locationId,
    locationName: data.stockBasis.locationName,
    warehouseId: data.stockBasis.warehouseId,
    warehouseName: data.stockBasis.warehouseName,
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Confirm and create</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Review the details below. Creating the Stock Recheck records the Zoho stock read during validation.
        </p>
      </div>

      {createMutation.error !== null && (
        <ErrorState
          message={
            createMutation.error instanceof ApiError
              ? createMutation.error.message
              : 'The Stock Recheck could not be created.'
          }
          correlationId={
            createMutation.error instanceof ApiError
              ? createMutation.error.correlationId
              : undefined
          }
        />
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Field
          label="Recheck name"
          hint={`Maximum ${MAX_RECHECK_NAME_LENGTH} characters.`}
          error={nameError}
          required
        >
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              value={effectiveName}
              maxLength={MAX_RECHECK_NAME_LENGTH}
              error={nameError !== undefined}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>

        <Field
          label="Business date"
          hint={`Interpreted in ${settings.businessTimezone}.`}
        >
          {({ inputId, describedBy }) => (
            <TextInput
              id={inputId}
              aria-describedby={describedBy}
              type="date"
              value={businessDate}
              onChange={(event) => setBusinessDate(event.target.value)}
            />
          )}
        </Field>
      </div>

      {/* ------------------------------------------------------ stock basis */}
      <Card className="bg-[var(--color-surface-raised)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Stock basis</p>
            <p className="mt-1 font-medium">{describeStockBasis(stockBasis)}</p>
            <dl className="mt-2 space-y-0.5 text-sm text-[var(--color-ink-muted)]">
              <div>
                <dt className="inline">Organization: </dt>
                <dd className="inline">{data.organization.name ?? 'Not available'}</dd>
              </div>
              <div>
                <dt className="inline">Basis type: </dt>
                <dd className="inline">{STOCK_BASIS_TYPE_LABEL[stockBasis.type]}</dd>
              </div>
            </dl>
          </div>
          <Link
            to="/app/admin/settings/stock-basis"
            className="text-sm font-medium text-[var(--color-brand)] hover:underline"
          >
            Edit Settings
          </Link>
        </div>
      </Card>

      {/* --------------------------------------------------- import summary */}
      <Card>
        <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Import summary</p>
        <dl className="tabular mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Items that will be created</dt>
            <dd className="text-lg font-semibold text-[var(--color-success)]">
              {data.summary.passed}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Failed rows (excluded)</dt>
            <dd className="text-lg font-semibold">{data.summary.failed}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Stock read at</dt>
            <dd className="text-sm font-medium">
              {data.snapshotAt === null ? '—' : new Date(data.snapshotAt).toLocaleString()}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Source type</dt>
            <dd className="text-sm font-medium capitalize">{data.sourceType}</dd>
          </div>
        </dl>
      </Card>

      <InlineNotice tone="info">
        The Zoho stock quantity recorded now is the one every count is compared against. If stock
        moves while the count is running, use <strong>Update stock details</strong> in the workspace
        to re-read it — that refreshes only items still available or being counted, and never an
        item that has already been submitted.
      </InlineNotice>

      {/* Section 18: this acknowledgement is required. */}
      <Card className="border-[var(--color-border-strong)]">
        <Checkbox
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
          label="I understand that this application will only read from Zoho and will not update Zoho inventory."
        />
      </Card>

      <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--color-border)] pt-4">
        <Button onClick={() => navigate('../import-result')} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="lg"
          disabled={!acknowledged || data.summary.passed === 0}
          loading={createMutation.isPending}
          loadingText="Creating…"
          onClick={submit}
        >
          Create Recheck
        </Button>
      </div>
    </div>
  );
}
