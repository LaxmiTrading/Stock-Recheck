/**
 * Screen 3: Select import source — specification section 11.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Dialog } from '@/components/ui';
import { ClipboardTextIcon, FileSpreadsheetIcon } from '@/components/icons';
import { useImportWizard } from './ImportWizardContext';

export default function SourcePage(): React.JSX.Element {
  const navigate = useNavigate();
  const { update, reset, hasUnsavedInput } = useImportWizard();
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const choose = (sourceType: 'excel' | 'text'): void => {
    update({ sourceType });
    /*
     * Must be `../`-relative. This component IS the `source` route, so a bare
     * relative target resolves against `/app/rechecks/new/source` and produces
     * `/app/rechecks/new/source/excel/upload`, which matches no route and falls
     * through to the `*` catch-all — silently bouncing the user to the
     * dashboard. Every other step in the wizard navigates the same way.
     */
    navigate(sourceType === 'excel' ? '../excel/upload' : '../text/entry');
  };

  const goBack = (): void => {
    // Section 11: confirm before discarding temporary import data.
    if (hasUnsavedInput) {
      setConfirmDiscard(true);
      return;
    }
    navigate('/app/rechecks');
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="flex flex-col gap-3 border-[var(--color-border-strong)]">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-brand-subtle)] text-[var(--color-brand)]"
          >
            <FileSpreadsheetIcon size={20} />
          </span>
          <h3 className="text-base font-semibold">Upload Excel</h3>
          <p className="flex-1 text-sm text-[var(--color-ink-muted)]">
            Upload a spreadsheet containing one SKU per row. You will map the correct column before
            processing.
          </p>
          <Button variant="primary" fullWidth onClick={() => choose('excel')}>
            Choose Excel
          </Button>
        </Card>

        <Card className="flex flex-col gap-3 border-[var(--color-border-strong)]">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--color-brand-subtle)] text-[var(--color-brand)]"
          >
            <ClipboardTextIcon size={20} />
          </span>
          <h3 className="text-base font-semibold">Paste SKUs</h3>
          <p className="flex-1 text-sm text-[var(--color-ink-muted)]">
            Paste SKUs copied from another spreadsheet, report, or document.
          </p>
          <Button variant="primary" fullWidth onClick={() => choose('text')}>
            Paste SKU List
          </Button>
        </Card>
      </div>

      <div className="flex justify-start border-t border-[var(--color-border)] pt-4">
        <Button onClick={goBack}>Back to Dashboard</Button>
      </div>

      <Dialog
        open={confirmDiscard}
        tone="warning"
        title="Discard this import?"
        description="You have started an import. Going back will discard the data you have entered so far."
        onClose={() => setConfirmDiscard(false)}
        footer={
          <>
            <Button onClick={() => setConfirmDiscard(false)}>Keep editing</Button>
            <Button
              variant="danger"
              onClick={() => {
                reset();
                navigate('/app/rechecks');
              }}
            >
              Discard and leave
            </Button>
          </>
        }
      />
    </div>
  );
}
