/**
 * Screen 4A step 1: Excel upload — specification section 12.1.
 */

import { useRef, useState, type DragEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { DEFAULT_MAX_FILE_SIZE_BYTES, DEFAULT_MAX_IMPORT_ROWS } from '@/domain/settings';
import { Button, Card, Dialog, InlineNotice, Spinner } from '@/components/ui';
import { useImportWizard } from './ImportWizardContext';
import { formatBytes, parseWorkbook, WorkbookParseError } from './excelParser';

export default function ExcelUploadPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { draft, workbook, update, setWorkbook } = useImportWizard();
  const inputRef = useRef<HTMLInputElement>(null);

  const [error, setError] = useState<string>();
  const [parsing, setParsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  // These come from admin settings; the defaults double as the display copy
  // until the settings query resolves.
  const limits = {
    maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
    maxRows: DEFAULT_MAX_IMPORT_ROWS,
  };

  const handleFile = async (file: File): Promise<void> => {
    setError(undefined);
    setParsing(true);
    try {
      const parsed = await parseWorkbook(file, limits);
      setWorkbook(parsed);
      update({
        fileName: parsed.fileName,
        fileSize: parsed.fileSize,
        worksheetNames: parsed.worksheets.map((sheet) => sheet.name),
        // A single-worksheet workbook is selected automatically (section 12.2),
        // but its name is still displayed on the next screen.
        selectedSheetName:
          parsed.worksheets.length === 1 ? (parsed.worksheets[0]?.name ?? null) : null,
        mappedColumnIndex: null,
      });
    } catch (caught) {
      // Section 12.1: show a SPECIFIC error, never a generic one.
      setError(
        caught instanceof WorkbookParseError
          ? caught.message
          : 'This file could not be read. Try saving it again as .xlsx.',
      );
      setWorkbook(null);
      update({ fileName: null, fileSize: null, worksheetNames: [] });
    } finally {
      setParsing(false);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) void handleFile(file);
  };

  const removeFile = (): void => {
    setWorkbook(null);
    update({
      fileName: null,
      fileSize: null,
      worksheetNames: [],
      selectedSheetName: null,
      mappedColumnIndex: null,
    });
    setError(undefined);
  };

  const hasFile = draft.fileName !== null && workbook !== null;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-base font-semibold">Upload a spreadsheet</h3>
        <p className="text-sm text-[var(--color-ink-muted)]">
          The file is read in your browser. Only the SKU column you map is sent to the server.
        </p>
      </div>

      {error !== undefined && (
        <div role="alert">
          <InlineNotice tone="danger">{error}</InlineNotice>
        </div>
      )}

      {!hasFile ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex flex-col items-center gap-3 rounded-[var(--radius-card)] border-2 border-dashed px-6 py-12 text-center transition-colors ${
            dragging
              ? 'border-[var(--color-brand)] bg-[var(--color-brand-subtle)]'
              : 'border-[var(--color-border-strong)]'
          }`}
        >
          {parsing ? (
            <>
              <Spinner size={28} label="Reading workbook" />
              <p className="text-sm">Reading the workbook…</p>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="text-3xl">
                ⬆
              </span>
              <p className="font-medium">Drag and drop your spreadsheet here</p>
              <dl className="text-xs text-[var(--color-ink-subtle)]">
                <div>
                  <dt className="inline">Accepted formats: </dt>
                  <dd className="inline">.xlsx, .xls, .csv</dd>
                </div>
                <div>
                  <dt className="inline">Maximum file size: </dt>
                  <dd className="inline">{formatBytes(limits.maxFileSizeBytes)}</dd>
                </div>
                <div>
                  <dt className="inline">Maximum rows: </dt>
                  <dd className="inline">{limits.maxRows.toLocaleString()}</dd>
                </div>
              </dl>
              <Button variant="primary" onClick={() => inputRef.current?.click()}>
                Browse Files
              </Button>
            </>
          )}

          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            className="sr-only-focusable absolute"
            aria-label="Choose a spreadsheet to upload"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void handleFile(file);
              // Reset so choosing the same file twice still fires onChange.
              event.target.value = '';
            }}
          />
        </div>
      ) : (
        <Card className="flex flex-wrap items-center justify-between gap-4 bg-[var(--color-surface-raised)]">
          <div className="min-w-0">
            <p className="truncate font-medium">{draft.fileName}</p>
            <p className="text-xs text-[var(--color-ink-subtle)]">
              {formatBytes(draft.fileSize ?? 0)} ·{' '}
              {draft.worksheetNames.length === 1
                ? '1 worksheet'
                : `${draft.worksheetNames.length} worksheets`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={removeFile}>Remove</Button>
            <Button onClick={() => setConfirmReplace(true)}>Replace</Button>
            <Button variant="primary" onClick={() => navigate('../sheet')}>
              Continue
            </Button>
          </div>
        </Card>
      )}

      <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
        <Button onClick={() => navigate('../../source')}>Back</Button>
        <Button variant="primary" disabled={!hasFile} onClick={() => navigate('../sheet')}>
          Continue
        </Button>
      </div>

      <Dialog
        open={confirmReplace}
        tone="warning"
        title="Replace this file?"
        description="The current file, worksheet selection and column mapping will be discarded."
        onClose={() => setConfirmReplace(false)}
        footer={
          <>
            <Button onClick={() => setConfirmReplace(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmReplace(false);
                removeFile();
                inputRef.current?.click();
              }}
            >
              Choose a different file
            </Button>
          </>
        }
      />
    </div>
  );
}
