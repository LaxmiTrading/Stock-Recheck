/**
 * Screen 4A steps 2-3: worksheet selection and header-row configuration —
 * specification sections 12.2 and 12.3.
 *
 * Both steps live on one route: selecting a sheet and telling us where its
 * headings are is a single decision for the operator, and keeping them
 * together avoids a pointless extra click for the common single-sheet case.
 */

import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card, Field, InlineNotice, TextInput } from '@/components/ui';
import { useImportWizard } from './ImportWizardContext';
import { columnLetter } from './excelParser';

const PREVIEW_ROWS = 15;

export default function SheetSelectPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { draft, workbook, update } = useImportWizard();

  const [selectedName, setSelectedName] = useState<string | null>(draft.selectedSheetName);
  const [headerRow, setHeaderRow] = useState(draft.headerRowNumber);
  const [firstRowIsHeading, setFirstRowIsHeading] = useState(draft.firstRowIsHeading);

  // Auto-select when the workbook has exactly one worksheet (section 12.2).
  useEffect(() => {
    if (selectedName === null && workbook?.worksheets.length === 1) {
      setSelectedName(workbook.worksheets[0]?.name ?? null);
    }
  }, [selectedName, workbook]);

  // The parsed workbook lives in memory only; a refresh sends us back to upload.
  if (workbook === null) return <Navigate to="../upload" replace />;

  const worksheet = workbook.worksheets.find((sheet) => sheet.name === selectedName) ?? null;
  const previewRows = worksheet?.rows.slice(0, PREVIEW_ROWS) ?? [];
  const previewColumnCount = Math.min(worksheet?.columnCount ?? 0, 8);

  const proceed = (): void => {
    if (worksheet === null) return;
    update({
      selectedSheetName: worksheet.name,
      headerRowNumber: headerRow,
      firstRowIsHeading,
      // Section 12.3: changing the header row invalidates the mapping.
      mappedColumnIndex: null,
    });
    navigate('../mapping');
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Choose the worksheet and header row</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          {workbook.worksheets.length === 1
            ? 'This workbook contains a single worksheet, selected below.'
            : 'Select the worksheet that contains the SKUs to check.'}
        </p>
      </div>

      {/* ------------------------------------------------ worksheet list */}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Worksheet</legend>
        {workbook.worksheets.map((sheet) => (
          <label
            key={sheet.name}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              sheet.name === selectedName
                ? 'border-[var(--color-brand)] bg-[var(--color-brand-subtle)]'
                : 'border-[var(--color-border)]'
            }`}
          >
            <input
              type="radio"
              name="worksheet"
              className="mt-1 h-5 w-5 accent-[var(--color-brand)]"
              checked={sheet.name === selectedName}
              onChange={() => setSelectedName(sheet.name)}
            />
            <span className="flex-1">
              <span className="block font-medium">{sheet.name}</span>
              <span className="block text-xs text-[var(--color-ink-subtle)]">
                {sheet.rowCount.toLocaleString()} rows · {sheet.columnCount} columns
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* -------------------------------------------- header configuration */}
      {worksheet !== null && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Header row number"
              hint="The row that contains your column headings."
            >
              {({ inputId, describedBy }) => (
                <TextInput
                  id={inputId}
                  aria-describedby={describedBy}
                  type="number"
                  min={1}
                  max={Math.max(1, worksheet.rowCount)}
                  value={headerRow}
                  onChange={(event) => {
                    const next = Number.parseInt(event.target.value, 10);
                    setHeaderRow(Number.isFinite(next) && next >= 1 ? next : 1);
                  }}
                />
              )}
            </Field>

            <div className="flex items-end">
              <label className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--color-brand)]"
                  checked={firstRowIsHeading}
                  onChange={(event) => setFirstRowIsHeading(event.target.checked)}
                />
                This row contains headings
              </label>
            </div>
          </div>

          {!firstRowIsHeading && (
            <InlineNotice tone="info">
              Data will be read from row {headerRow} onward, and column headings will be shown as
              letters only.
            </InlineNotice>
          )}

          {/* ---------------------------------------------- row preview */}
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[600px] text-left text-sm">
              <caption className="px-3 py-2 text-left text-xs text-[var(--color-ink-subtle)]">
                First {Math.min(PREVIEW_ROWS, previewRows.length)} rows of “{worksheet.name}”
              </caption>
              <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
                <tr>
                  <th scope="col" className="px-3 py-2">
                    Row
                  </th>
                  {Array.from({ length: previewColumnCount }, (_, index) => (
                    <th key={index} scope="col" className="px-3 py-2">
                      {columnLetter(index)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {previewRows.map((row, rowIndex) => {
                  const rowNumber = rowIndex + 1;
                  const isHeaderRow = firstRowIsHeading && rowNumber === headerRow;
                  return (
                    <tr
                      key={rowNumber}
                      className={
                        isHeaderRow
                          ? 'bg-[var(--color-brand-subtle)] font-medium'
                          : 'border-t border-[var(--color-border)]'
                      }
                    >
                      <td className="tabular px-3 py-1.5 text-xs text-[var(--color-ink-subtle)]">
                        {rowNumber}
                        {isHeaderRow && <span className="ml-1 text-[var(--color-brand)]">◀</span>}
                      </td>
                      {Array.from({ length: previewColumnCount }, (_, columnIndex) => (
                        <td key={columnIndex} className="max-w-[220px] truncate px-3 py-1.5">
                          {row[columnIndex] ?? ''}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}

      <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
        <Button onClick={() => navigate('../upload')}>Back</Button>
        <Button variant="primary" disabled={worksheet === null} onClick={proceed}>
          Continue
        </Button>
      </div>
    </div>
  );
}
