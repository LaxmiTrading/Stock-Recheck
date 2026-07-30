/**
 * Import wizard state — specification sections 11-18.
 *
 * The draft lives in React state plus sessionStorage, so an accidental refresh
 * mid-wizard does not lose the operator's work. Parsed workbook CELLS are kept
 * in memory only (they can be large); the lightweight descriptors that let the
 * wizard resume are persisted.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ImportSourceType } from '@/domain/failureCodes';
import type { ParsedWorkbook } from './excelParser';

export interface WizardDraft {
  sourceType: ImportSourceType | null;

  /* Excel path */
  fileName: string | null;
  fileSize: number | null;
  worksheetNames: string[];
  selectedSheetName: string | null;
  headerRowNumber: number;
  firstRowIsHeading: boolean;
  mappedColumnIndex: number | null;

  /* Text path */
  pastedText: string;

  /* Result of the server round trip */
  importBatchId: string | null;
}

const EMPTY_DRAFT: WizardDraft = {
  sourceType: null,
  fileName: null,
  fileSize: null,
  worksheetNames: [],
  selectedSheetName: null,
  headerRowNumber: 1,
  firstRowIsHeading: true,
  mappedColumnIndex: null,
  pastedText: '',
  importBatchId: null,
};

const STORAGE_KEY = 'stock-recheck:import-wizard';

interface WizardContextValue {
  draft: WizardDraft;
  /** In-memory only; undefined after a page refresh. */
  workbook: ParsedWorkbook | null;
  update: (patch: Partial<WizardDraft>) => void;
  setWorkbook: (workbook: ParsedWorkbook | null) => void;
  reset: () => void;
  /** True when the operator has entered data that a Back would discard. */
  hasUnsavedInput: boolean;
}

const WizardContext = createContext<WizardContextValue | null>(null);

function loadDraft(): WizardDraft {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...EMPTY_DRAFT };
    return { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Partial<WizardDraft>) };
  } catch {
    return { ...EMPTY_DRAFT };
  }
}

export function ImportWizardProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [draft, setDraft] = useState<WizardDraft>(loadDraft);
  // A ref, not state: the parsed cells must not trigger re-renders and must
  // never be serialized into sessionStorage.
  const workbookRef = useRef<ParsedWorkbook | null>(null);
  const [workbookVersion, setWorkbookVersion] = useState(0);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    } catch {
      // Private-browsing quota failures are not worth interrupting the import.
    }
  }, [draft]);

  const update = useCallback((patch: Partial<WizardDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const setWorkbook = useCallback((workbook: ParsedWorkbook | null) => {
    workbookRef.current = workbook;
    setWorkbookVersion((version) => version + 1);
  }, []);

  const reset = useCallback(() => {
    workbookRef.current = null;
    setWorkbookVersion((version) => version + 1);
    setDraft({ ...EMPTY_DRAFT });
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const hasUnsavedInput =
    draft.sourceType !== null &&
    (draft.fileName !== null || draft.pastedText.trim().length > 0);

  const value = useMemo<WizardContextValue>(
    () => ({
      draft,
      workbook: workbookRef.current,
      update,
      setWorkbook,
      reset,
      hasUnsavedInput,
    }),
    // workbookVersion forces a new value when the ref contents change.
    [draft, update, setWorkbook, reset, hasUnsavedInput, workbookVersion],
  );

  return <WizardContext.Provider value={value}>{children}</WizardContext.Provider>;
}

export function useImportWizard(): WizardContextValue {
  const context = useContext(WizardContext);
  if (context === null) {
    throw new Error('useImportWizard must be used inside <ImportWizardProvider>');
  }
  return context;
}

/** Step labels for the indicator — section 11. */
export const WIZARD_STEPS = [
  'Select Source',
  'Add SKUs',
  'Review',
  'Validate',
  'Create Recheck',
] as const;

/** Maps a wizard pathname to its step index. */
export function stepIndexForPath(pathname: string): number {
  if (pathname.includes('/import-result')) return 2;
  if (pathname.includes('/confirm')) return 4;
  if (pathname.includes('/validation')) return 3;
  if (pathname.includes('/preview')) return 2;
  if (pathname.includes('/upload') || pathname.includes('/sheet') || pathname.includes('/mapping')) {
    return 1;
  }
  if (pathname.includes('/entry')) return 1;
  return 0;
}
