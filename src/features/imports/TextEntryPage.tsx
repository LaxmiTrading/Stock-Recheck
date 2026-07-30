/**
 * Screen 4B: text-box import — specification section 13.
 *
 * Accepts values separated by newlines, tabs, commas or semicolons — never by
 * plain spaces, because a SKU may contain an internal space.
 */

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { assignPreliminaryStatuses, parseSkuText } from '@/domain/sku';
import { useSettings } from '@/features/auth/AuthContext';
import { Button, Card, Dialog, Field, InlineNotice, TextArea } from '@/components/ui';
import { useImportWizard } from './ImportWizardContext';

const PLACEHOLDER = `Paste one SKU per line

Example:
SKU-1001
SKU-1002
SKU-1003`;

export default function TextEntryPage(): React.JSX.Element {
  const navigate = useNavigate();
  const settings = useSettings();
  const { draft, update } = useImportWizard();

  const [text, setText] = useState(draft.pastedText);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState<string>();

  const stats = useMemo(() => {
    const entries = parseSkuText(text, { caseSensitive: settings.skuCaseSensitive });
    const withStatus = assignPreliminaryStatuses(entries);
    return {
      total: entries.length,
      nonEmpty: entries.filter((entry) => !entry.isBlank).length,
      duplicates: withStatus.filter((entry) => entry.preliminaryStatus === 'duplicate_in_list')
        .length,
      blanks: entries.filter((entry) => entry.isBlank).length,
    };
  }, [text, settings.skuCaseSensitive]);

  const pasteFromClipboard = async (): Promise<void> => {
    setClipboardNotice(undefined);
    try {
      if (navigator.clipboard?.readText === undefined) {
        throw new Error('unsupported');
      }
      const clipboardText = await navigator.clipboard.readText();
      // Section 13: paste into the field but never auto-submit.
      setText((current) => (current === '' ? clipboardText : `${current}\n${clipboardText}`));
    } catch {
      setClipboardNotice(
        'Your browser did not allow clipboard access. Click into the box and press Ctrl+V (⌘V on macOS) instead.',
      );
    }
  };

  const proceed = (): void => {
    update({ pastedText: text, sourceType: 'text' });
    navigate('../preview');
  };

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Paste your SKU list</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Values may be separated by new lines, tabs, commas or semicolons. Spaces are never treated
          as separators, so a SKU can contain one.
        </p>
      </div>

      {clipboardNotice !== undefined && (
        <InlineNotice tone="warning">{clipboardNotice}</InlineNotice>
      )}

      <Field label="SKUs" hint="One SKU per line is the clearest format.">
        {({ inputId, describedBy }) => (
          <TextArea
            id={inputId}
            aria-describedby={describedBy}
            rows={12}
            className="font-mono"
            placeholder={PLACEHOLDER}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </Field>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void pasteFromClipboard()}>Paste from Clipboard</Button>
        <Button
          onClick={() => {
            if (text.trim() === '') return;
            setConfirmClear(true);
          }}
          disabled={text === ''}
        >
          Clear
        </Button>
      </div>

      <Card className="bg-[var(--color-surface-raised)]">
        <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Parsed count</p>
        <dl className="tabular mt-2 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Total parsed</dt>
            <dd className="text-lg font-semibold">{stats.total}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Non-empty</dt>
            <dd className="text-lg font-semibold">{stats.nonEmpty}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Potential duplicates</dt>
            <dd className="text-lg font-semibold">{stats.duplicates}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Blank fragments ignored</dt>
            <dd className="text-lg font-semibold">{stats.blanks}</dd>
          </div>
        </dl>
      </Card>

      <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
        <Button onClick={() => navigate('../../source')}>Back</Button>
        <Button variant="primary" disabled={stats.nonEmpty === 0} onClick={proceed}>
          Continue to Preview
        </Button>
      </div>

      <Dialog
        open={confirmClear}
        tone="warning"
        title="Clear all pasted SKUs?"
        description="Everything in the text box will be removed."
        onClose={() => setConfirmClear(false)}
        footer={
          <>
            <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                setText('');
                update({ pastedText: '' });
                setConfirmClear(false);
              }}
            >
              Clear
            </Button>
          </>
        }
      />
    </div>
  );
}
