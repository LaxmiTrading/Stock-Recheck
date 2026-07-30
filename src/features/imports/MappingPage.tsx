/**
 * Screen 4A step 4: column mapping — specification section 12.4.
 * SKU is the only required application field.
 */

import { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, Card, InlineNotice, Select } from '@/components/ui';
import { useImportWizard } from './ImportWizardContext';
import { autoDetectSkuColumn, buildColumnOptions } from './excelParser';

export default function MappingPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { draft, workbook, update } = useImportWizard();

  const worksheet =
    workbook?.worksheets.find((sheet) => sheet.name === draft.selectedSheetName) ?? null;

  const options = useMemo(
    () =>
      worksheet === null
        ? []
        : buildColumnOptions(worksheet, draft.headerRowNumber, draft.firstRowIsHeading),
    [worksheet, draft.headerRowNumber, draft.firstRowIsHeading],
  );

  const [selectedIndex, setSelectedIndex] = useState<number | null>(draft.mappedColumnIndex);
  const [autoDetected, setAutoDetected] = useState(false);

  // Section 12.4: attempt auto-detection but never finalize it automatically.
  useEffect(() => {
    if (selectedIndex !== null || options.length === 0) return;
    const detected = autoDetectSkuColumn(options);
    if (detected !== null) {
      setSelectedIndex(detected);
      setAutoDetected(true);
    }
  }, [options, selectedIndex]);

  if (workbook === null || worksheet === null) return <Navigate to="../upload" replace />;

  const proceed = (): void => {
    if (selectedIndex === null) return;
    update({ mappedColumnIndex: selectedIndex });
    navigate('../preview');
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Map the SKU column</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Tell us which spreadsheet column holds the SKU. Nothing else is required.
        </p>
      </div>

      {autoDetected && selectedIndex !== null && (
        <InlineNotice tone="info">
          We pre-selected column {options[selectedIndex]?.letter} based on its heading. Confirm it is
          correct before continuing.
        </InlineNotice>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
            <tr>
              <th scope="col" className="px-3 py-2">
                Application field
              </th>
              <th scope="col" className="px-3 py-2">
                Required
              </th>
              <th scope="col" className="px-3 py-2">
                Spreadsheet column
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-t border-[var(--color-border)]">
              <th scope="row" className="px-3 py-3 text-left font-medium">
                SKU
              </th>
              <td className="px-3 py-3">Yes</td>
              <td className="px-3 py-3">
                <Select
                  aria-label="Spreadsheet column containing the SKU"
                  value={selectedIndex ?? ''}
                  onChange={(event) => {
                    setAutoDetected(false);
                    const value = event.target.value;
                    setSelectedIndex(value === '' ? null : Number.parseInt(value, 10));
                  }}
                >
                  <option value="">Select a column…</option>
                  {options.map((option) => (
                    <option key={option.index} value={option.index}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {selectedIndex !== null && options[selectedIndex] !== undefined && (
        <Card className="bg-[var(--color-surface-raised)]">
          <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Sample values</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {(options[selectedIndex]?.samples ?? []).map((sample) => (
              <li
                key={sample}
                className="rounded bg-[var(--color-surface)] px-2 py-1 font-mono text-sm"
              >
                {sample}
              </li>
            ))}
            {(options[selectedIndex]?.samples.length ?? 0) === 0 && (
              <li className="text-sm text-[var(--color-ink-subtle)]">
                This column appears to be empty below the header row.
              </li>
            )}
          </ul>
        </Card>
      )}

      <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
        <Button onClick={() => navigate('../sheet')}>Back</Button>
        <Button variant="primary" disabled={selectedIndex === null} onClick={proceed}>
          Continue to Preview
        </Button>
      </div>
    </div>
  );
}
