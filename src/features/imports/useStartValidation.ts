/**
 * Shared "send rows, then validate" mutation used by both preview screens —
 * specification sections 12.5, 13 and 15.
 *
 * Rows are uploaded in chunks so a 20,000-row sheet stays inside the
 * serverless request-body limit, then validation runs as a single call.
 */

import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ImportSourceType } from '@/domain/failureCodes';
import { ApiError, apiRequest } from '@/services/api';
import { useImportWizard } from './ImportWizardContext';

/** Matches the server-side cap in uploadImportRowsSchema. */
const ROWS_PER_REQUEST = 2000;

export interface StartValidationInput {
  sourceType: ImportSourceType;
  rows: { sourceRowNumber: number; rawValue: string }[];
  sourceFileName?: string | null;
  worksheetName?: string | null;
  mappedSkuColumn?: string | null;
  headerRowNumber?: number | null;
}

export interface ValidationProgressState {
  phase: 'idle' | 'creating' | 'uploading' | 'validating' | 'done' | 'error';
  uploadedRows: number;
  totalRows: number;
  message: string;
  error?: string;
  correlationId?: string;
}

export function useStartValidation(): {
  state: ValidationProgressState;
  start: (input: StartValidationInput) => Promise<void>;
  cancel: () => void;
} {
  const navigate = useNavigate();
  const { update } = useImportWizard();
  const [state, setState] = useState<ValidationProgressState>({
    phase: 'idle',
    uploadedRows: 0,
    totalRows: 0,
    message: '',
  });
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortController?.abort();
    setState((current) => ({ ...current, phase: 'idle', message: 'Validation cancelled.' }));
  }, [abortController]);

  const start = useCallback(
    async (input: StartValidationInput): Promise<void> => {
      const controller = new AbortController();
      setAbortController(controller);

      setState({
        phase: 'creating',
        uploadedRows: 0,
        totalRows: input.rows.length,
        message: 'Preparing rows',
      });

      try {
        const created = await apiRequest<{ importBatchId: string }>('/api/imports', {
          method: 'POST',
          body: {
            sourceType: input.sourceType,
            sourceFileName: input.sourceFileName ?? null,
            worksheetName: input.worksheetName ?? null,
            mappedSkuColumn: input.mappedSkuColumn ?? null,
            headerRowNumber: input.headerRowNumber ?? null,
          },
          signal: controller.signal,
        });

        update({ importBatchId: created.importBatchId });

        // ---- upload in chunks -------------------------------------------
        for (let offset = 0; offset < input.rows.length; offset += ROWS_PER_REQUEST) {
          if (controller.signal.aborted) return;

          const chunk = input.rows.slice(offset, offset + ROWS_PER_REQUEST);
          await apiRequest(`/api/imports/${created.importBatchId}/rows`, {
            method: 'POST',
            body: { rows: chunk },
            signal: controller.signal,
          });

          setState((current) => ({
            ...current,
            phase: 'uploading',
            uploadedRows: Math.min(offset + chunk.length, input.rows.length),
            message: 'Uploading rows',
          }));
        }

        // ---- validate ----------------------------------------------------
        setState((current) => ({
          ...current,
          phase: 'validating',
          message: 'Checking SKUs against Zoho Books',
        }));

        await apiRequest(`/api/imports/${created.importBatchId}/validate`, {
          method: 'POST',
          body: { acknowledgedReadOnly: true },
          signal: controller.signal,
        });

        setState((current) => ({ ...current, phase: 'done', message: 'Validation complete' }));
        navigate('../../import-result');
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;

        setState((current) => ({
          ...current,
          phase: 'error',
          message: 'Validation could not be completed',
          error:
            error instanceof ApiError
              ? error.message
              : 'The import could not be validated. Try again.',
          correlationId: error instanceof ApiError ? error.correlationId : undefined,
        }));
      }
    },
    [navigate, update],
  );

  return { state, start, cancel };
}
