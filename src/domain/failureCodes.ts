/**
 * Import failure codes — specification section 16.
 *
 * Codes are STABLE internal identifiers persisted in `import_rows.failure_code`
 * and emitted in the failed-rows export. Messages are user-facing and may be
 * reworded; codes may not.
 */

export const IMPORT_FAILURE_CODES = [
  'EMPTY_SKU',
  'DUPLICATE_IN_IMPORT',
  'SKU_NOT_FOUND',
  'AMBIGUOUS_SKU',
  'INACTIVE_ITEM',
  'NOT_INVENTORY_TRACKED',
  'STOCK_BASIS_NOT_FOUND',
  'STOCK_QUANTITY_UNAVAILABLE',
  'ZOHO_AUTHENTICATION_FAILED',
  'ZOHO_RATE_LIMITED',
  'ZOHO_TEMPORARILY_UNAVAILABLE',
  'UNEXPECTED_ZOHO_RESPONSE',
  'SKU_TOO_LONG',
] as const;

export type ImportFailureCode = (typeof IMPORT_FAILURE_CODES)[number];

interface FailureDefinition {
  /** User-friendly message. `{row}` is substituted for duplicates. */
  readonly message: string;
  /**
   * Retryable failures are transient Zoho conditions. Only these get a Retry
   * action on the import-result screen (section 17).
   */
  readonly retryable: boolean;
}

const DEFINITIONS: Record<ImportFailureCode, FailureDefinition> = {
  EMPTY_SKU: {
    message: 'The SKU cell is blank.',
    retryable: false,
  },
  DUPLICATE_IN_IMPORT: {
    message: 'This SKU already appeared on row {row}.',
    retryable: false,
  },
  SKU_NOT_FOUND: {
    message: 'No active Zoho Books item was found with this exact SKU.',
    retryable: false,
  },
  AMBIGUOUS_SKU: {
    message: 'More than one Zoho item matched this SKU.',
    retryable: false,
  },
  INACTIVE_ITEM: {
    message: 'The Zoho item is inactive.',
    retryable: false,
  },
  NOT_INVENTORY_TRACKED: {
    message: 'The Zoho item is not configured as a stock-tracked inventory item.',
    retryable: false,
  },
  STOCK_BASIS_NOT_FOUND: {
    message: 'The selected Zoho location or warehouse was not found for this item.',
    retryable: false,
  },
  STOCK_QUANTITY_UNAVAILABLE: {
    message: 'Stock in hand could not be resolved for this item.',
    retryable: false,
  },
  ZOHO_AUTHENTICATION_FAILED: {
    message: 'Zoho authentication must be repaired by an administrator.',
    retryable: true,
  },
  ZOHO_RATE_LIMITED: {
    message: 'Zoho temporarily limited API requests. Retry this row.',
    retryable: true,
  },
  ZOHO_TEMPORARILY_UNAVAILABLE: {
    message: 'Zoho could not be reached. Retry this row.',
    retryable: true,
  },
  UNEXPECTED_ZOHO_RESPONSE: {
    message: 'Zoho returned an unexpected item response.',
    retryable: true,
  },
  SKU_TOO_LONG: {
    message: 'This value is too long to be a SKU.',
    retryable: false,
  },
};

export function isImportFailureCode(value: string): value is ImportFailureCode {
  return Object.prototype.hasOwnProperty.call(DEFINITIONS, value);
}

/**
 * Renders the user-facing reason. `duplicateOfRowNumber` is required for
 * DUPLICATE_IN_IMPORT so the operator can find the accepted occurrence
 * (section 3.2).
 */
export function failureReason(
  code: ImportFailureCode,
  context: { duplicateOfRowNumber?: number | null } = {},
): string {
  const definition = DEFINITIONS[code];
  if (code === 'DUPLICATE_IN_IMPORT') {
    const row = context.duplicateOfRowNumber;
    return row === undefined || row === null
      ? 'This SKU already appeared earlier in this import.'
      : definition.message.replace('{row}', String(row));
  }
  return definition.message;
}

/** Whether the import-result screen should offer a Retry action for this row. */
export function isRetryable(code: ImportFailureCode): boolean {
  return DEFINITIONS[code].retryable;
}

export function retryableCodes(): ImportFailureCode[] {
  return IMPORT_FAILURE_CODES.filter(isRetryable);
}

/** Per-row validation outcome stored in `import_rows.validation_status`. */
export const IMPORT_ROW_STATUSES = ['pending', 'passed', 'failed', 'ignored_blank'] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

/** Lifecycle of the whole import batch. */
export const IMPORT_BATCH_STATUSES = [
  'draft',
  'validating',
  'validated',
  'cancelled',
  'consumed',
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const IMPORT_SOURCE_TYPES = ['excel', 'text'] as const;
export type ImportSourceType = (typeof IMPORT_SOURCE_TYPES)[number];

export const IMPORT_SOURCE_LABEL: Record<ImportSourceType, string> = {
  excel: 'Excel',
  text: 'Pasted text',
};
