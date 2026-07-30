/**
 * Text preview screen — specification section 13.
 * Shows the normalized table with a preliminary (pre-Zoho) status per row.
 */

import { useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  assignPreliminaryStatuses,
  parseSkuText,
  PRELIMINARY_STATUS_LABEL,
  type PreliminaryStatus,
} from '@/domain/sku';
import { useSettings } from '@/features/auth/AuthContext';
import { Badge, Button, Card, Dialog, ErrorState, ProgressBar } from '@/components/ui';
import type { StatusTone } from '@/domain/status';
import { useImportWizard } from './ImportWizardContext';
import { useStartValidation } from './useStartValidation';

const STATUS_TONE: Record<PreliminaryStatus, StatusTone> = {
  ready_for_validation: 'success',
  blank: 'muted',
  duplicate_in_list: 'warning',
  invalid_format: 'danger',
};

const PREVIEW_LIMIT = 200;

export default function TextPreviewPage(): React.JSX.Element {
  const navigate = useNavigate();
  const settings = useSettings();
  const { draft } = useImportWizard();
  const { state, start, cancel } = useStartValidation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const entries = useMemo(
    () =>
      assignPreliminaryStatuses(
        parseSkuText(draft.pastedText, { caseSensitive: settings.skuCaseSensitive }),
      ),
    [draft.pastedText, settings.skuCaseSensitive],
  );

  /**
   * Rows sent to the server. Blank fragments are excluded so the reconciliation
   * on the result screen counts real source rows only; duplicates ARE sent so
   * the server reports them with the row of the accepted occurrence.
   */
  const rowsToSend = useMemo(
    () =>
      entries
        .filter((entry) => !entry.isBlank)
        .map((entry) => ({ sourceRowNumber: entry.sequence, rawValue: entry.raw })),
    [entries],
  );

  if (draft.pastedText.trim() === '') return <Navigate to="../entry" replace />;

  const isBusy = state.phase !== 'idle' && state.phase !== 'error';

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Review parsed SKUs</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          These statuses are preliminary. Each SKU is checked against Zoho Books in the next
          step.
        </p>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[600px] text-left text-sm">
          <caption className="px-3 py-2 text-left text-xs text-[var(--color-ink-subtle)]">
            Showing {Math.min(PREVIEW_LIMIT, entries.length)} of {entries.length} parsed values
          </caption>
          <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
            <tr>
              <th scope="col" className="px-3 py-2">
                #
              </th>
              <th scope="col" className="px-3 py-2">
                Raw value
              </th>
              <th scope="col" className="px-3 py-2">
                Normalized SKU
              </th>
              <th scope="col" className="px-3 py-2">
                Preliminary status
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.slice(0, PREVIEW_LIMIT).map((entry) => (
              <tr key={entry.sequence} className="border-t border-[var(--color-border)]">
                <td className="tabular px-3 py-1.5 text-xs text-[var(--color-ink-subtle)]">
                  {entry.sequence}
                </td>
                <td className="px-3 py-1.5 font-mono">{entry.display || <em>(blank)</em>}</td>
                <td className="px-3 py-1.5 font-mono font-medium">
                  {entry.normalized || <em>—</em>}
                </td>
                <td className="px-3 py-1.5">
                  <Badge tone={STATUS_TONE[entry.preliminaryStatus]}>
                    {PRELIMINARY_STATUS_LABEL[entry.preliminaryStatus]}
                    {entry.duplicateOfSequence !== undefined &&
                      ` (first at #${entry.duplicateOfSequence})`}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {isBusy && (
        <Card className="space-y-3">
          <p className="text-sm font-medium">{state.message}…</p>
          <ProgressBar
            value={state.phase === 'validating' ? state.totalRows : state.uploadedRows}
            max={Math.max(1, state.totalRows)}
            label="Progress"
          />
          <Button onClick={cancel}>Cancel Validation</Button>
        </Card>
      )}

      {state.phase === 'error' && (
        <ErrorState message={state.error ?? 'Validation failed.'} correlationId={state.correlationId} />
      )}

      <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--color-border)] pt-4">
        <Button onClick={() => navigate('../entry')} disabled={isBusy}>
          Edit List
        </Button>
        <Button
          variant="primary"
          disabled={rowsToSend.length === 0 || isBusy}
          onClick={() => setConfirmOpen(true)}
        >
          Start Validation
        </Button>
      </div>

      <Dialog
        open={confirmOpen}
        title="Start validation?"
        description={
          <>
            <strong className="tabular">{rowsToSend.length.toLocaleString()}</strong> rows will be
            checked against Zoho Books. <strong>No data will be updated in Zoho.</strong>
          </>
        }
        onClose={() => setConfirmOpen(false)}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmOpen(false);
                void start({ sourceType: 'text', rows: rowsToSend });
              }}
            >
              Start Validation
            </Button>
          </>
        }
      />
    </div>
  );
}
