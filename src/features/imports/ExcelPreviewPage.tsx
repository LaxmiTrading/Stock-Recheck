/**
 * Screen 4A step 5: Excel preview — specification section 12.5.
 * Shows normalized values while retaining the raw value for error reporting.
 */

import { useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { normalizeSku } from '@/domain/sku';
import { useSettings } from '@/features/auth/AuthContext';
import { Button, Card, Dialog, ErrorState, InlineNotice, ProgressBar } from '@/components/ui';
import { useImportWizard } from './ImportWizardContext';
import { columnLetter, extractSkuColumn } from './excelParser';
import { useStartValidation } from './useStartValidation';

const PREVIEW_LIMIT = 50;

export default function ExcelPreviewPage(): React.JSX.Element {
  const navigate = useNavigate();
  const settings = useSettings();
  const { draft, workbook } = useImportWizard();
  const { state, start, cancel } = useStartValidation();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const worksheet =
    workbook?.worksheets.find((sheet) => sheet.name === draft.selectedSheetName) ?? null;

  const rows = useMemo(() => {
    if (worksheet === null || draft.mappedColumnIndex === null) return [];
    return extractSkuColumn(
      worksheet,
      draft.mappedColumnIndex,
      draft.headerRowNumber,
      draft.firstRowIsHeading,
    );
  }, [worksheet, draft.mappedColumnIndex, draft.headerRowNumber, draft.firstRowIsHeading]);

  const previewRows = useMemo(
    () =>
      rows.slice(0, PREVIEW_LIMIT).map((row) => ({
        ...row,
        ...normalizeSku(row.rawValue, { caseSensitive: settings.skuCaseSensitive }),
      })),
    [rows, settings.skuCaseSensitive],
  );

  if (workbook === null || worksheet === null || draft.mappedColumnIndex === null) {
    return <Navigate to="../upload" replace />;
  }

  // Captured after the guard so the narrowing survives into the callbacks below.
  const mappedColumnIndex: number = draft.mappedColumnIndex;
  const isBusy = state.phase !== 'idle' && state.phase !== 'error';

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Review before validation</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Confirm the right column was mapped. Values are shown normalized; the original text is
          kept for error reporting.
        </p>
      </div>

      <Card className="bg-[var(--color-surface-raised)]">
        <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Source file</dt>
            <dd className="truncate font-medium">{draft.fileName}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Worksheet</dt>
            <dd className="font-medium">{worksheet.name}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Header row</dt>
            <dd className="font-medium">
              {draft.firstRowIsHeading ? draft.headerRowNumber : 'No header row'}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Mapped SKU column</dt>
            <dd className="font-medium">{columnLetter(mappedColumnIndex)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Detected data rows</dt>
            <dd className="tabular font-medium">{rows.length.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">SKU matching</dt>
            <dd className="font-medium">
              {settings.skuCaseSensitive ? 'Case-sensitive' : 'Case-insensitive'}
            </dd>
          </div>
        </dl>
      </Card>

      {rows.length === 0 && (
        <InlineNotice tone="warning">
          No data rows were found below the header row. Go back and check the worksheet and header
          row settings.
        </InlineNotice>
      )}

      {previewRows.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[560px] text-left text-sm">
            <caption className="px-3 py-2 text-left text-xs text-[var(--color-ink-subtle)]">
              First {previewRows.length} of {rows.length.toLocaleString()} parsed values
            </caption>
            <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
              <tr>
                <th scope="col" className="px-3 py-2">
                  Source row
                </th>
                <th scope="col" className="px-3 py-2">
                  Raw value
                </th>
                <th scope="col" className="px-3 py-2">
                  Normalized SKU
                </th>
              </tr>
            </thead>
            <tbody>
              {previewRows.map((row) => (
                <tr key={row.sourceRowNumber} className="border-t border-[var(--color-border)]">
                  <td className="tabular px-3 py-1.5 text-xs text-[var(--color-ink-subtle)]">
                    {row.sourceRowNumber}
                  </td>
                  <td className="px-3 py-1.5 font-mono">{row.display || <em>(blank)</em>}</td>
                  <td className="px-3 py-1.5 font-mono font-medium">
                    {row.normalized || <em>(blank)</em>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {isBusy && (
        <Card className="space-y-3">
          <p className="text-sm font-medium">{state.message}…</p>
          <ProgressBar
            value={state.phase === 'validating' ? state.totalRows : state.uploadedRows}
            max={Math.max(1, state.totalRows)}
            label={
              state.phase === 'validating'
                ? 'Checking against Zoho'
                : `${state.uploadedRows.toLocaleString()} of ${state.totalRows.toLocaleString()} rows uploaded`
            }
          />
          <Button onClick={cancel}>Cancel Validation</Button>
        </Card>
      )}

      {state.phase === 'error' && (
        <ErrorState message={state.error ?? 'Validation failed.'} correlationId={state.correlationId} />
      )}

      <div className="flex flex-wrap justify-between gap-2 border-t border-[var(--color-border)] pt-4">
        <Button onClick={() => navigate('../mapping')} disabled={isBusy}>
          Edit Mapping
        </Button>
        <Button
          variant="primary"
          disabled={rows.length === 0 || isBusy}
          onClick={() => setConfirmOpen(true)}
        >
          Start Validation
        </Button>
      </div>

      {/* Section 12.5: confirm the read-only guarantee before sending. */}
      <Dialog
        open={confirmOpen}
        title="Start validation?"
        description={
          <>
            <strong className="tabular">{rows.length.toLocaleString()}</strong> rows will be checked
            against Zoho Books. <strong>No data will be updated in Zoho.</strong>
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
                void start({
                  sourceType: 'excel',
                  rows,
                  sourceFileName: draft.fileName,
                  worksheetName: worksheet.name,
                  mappedSkuColumn: columnLetter(mappedColumnIndex),
                  headerRowNumber: draft.firstRowIsHeading ? draft.headerRowNumber : null,
                });
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
