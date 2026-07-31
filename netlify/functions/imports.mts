/**
 * Import endpoints — specification sections 12-17, 31.
 *
 *   POST /api/imports                    create a draft batch
 *   POST /api/imports/:id/rows           upload parsed source rows (chunked)
 *   POST /api/imports/:id/validate       run the Zoho validation algorithm
 *   GET  /api/imports/:id                fetch the import-result payload
 *   POST /api/imports/:id/retry          retry retryable failures
 *   POST /api/imports/:id/cancel         abandon the draft
 *   GET  /api/imports/:id/failures.xlsx  download the failed-rows workbook
 *
 * Importing is an administrator capability (section 4.5) and is enforced here,
 * not merely by hiding the menu item.
 */

import type { Config, Context } from '@netlify/functions';
import {
  createImportRequestSchema,
  retryImportRequestSchema,
  uploadImportRowsSchema,
  validateImportRequestSchema,
} from '../../src/schemas/api';
import {
  failureReason,
  isImportFailureCode,
  retryableCodes,
  type ImportFailureCode,
} from '../../src/domain/failureCodes';
import { buildFailedRowsFileName } from '../../src/domain/exportContract';
import { isStockBasisComplete } from '../../src/domain/stockBasis';
import { recordAuditEvent } from '../shared/audit';
import { requireActorWith } from '../shared/auth/session';
import { withTransaction } from '../shared/database/client';
import { AppError, NotFoundError, PayloadTooLargeError, ValidationError } from '../shared/errors';
import { buildFailedRowsWorkbook } from '../shared/excel/workbook';
import {
  fileResponse,
  jsonSuccess,
  matchRoute,
  parseJsonBody,
  withErrorHandling,
  type Route,
  type RouteContext,
} from '../shared/http';
import {
  applyRowOutcomes,
  createImportBatch,
  findImportBatch,
  insertImportRows,
  listImportRows,
  listRetryableRows,
  refreshBatchCounters,
  setBatchStatus,
  setBatchStockBasis,
  type ImportBatchRow,
} from '../shared/repositories/imports';
import { defaultStockBasis, getSettings } from '../shared/repositories/settings';
import { enforceRateLimit, IMPORT_VALIDATION_RATE_LIMIT } from '../shared/rateLimit';
import { validateImportRows, type SourceRow } from '../shared/validation/importValidator';
import { createBooksReader } from '../shared/zoho/books';
import { resolveCredentials } from '../shared/zoho/tokens';
import { toNormalizedSku } from '../../src/domain/sku';

/** Loads a batch the actor is allowed to see, or throws 404. */
async function loadBatch(batchId: string, actorId: string): Promise<ImportBatchRow> {
  const batch = await findImportBatch(batchId, actorId);
  if (batch === null) throw new NotFoundError('import');
  return batch;
}

/* ------------------------------------------------------- create the batch */

const createImport = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:import');
  const body = await parseJsonBody(request, createImportRequestSchema);

  const batch = await createImportBatch({
    sourceType: body.sourceType,
    sourceFileName: body.sourceFileName ?? null,
    worksheetName: body.worksheetName ?? null,
    mappedSkuColumn: body.mappedSkuColumn ?? null,
    headerRowNumber: body.headerRowNumber ?? null,
    createdBy: actor.id,
  });

  await recordAuditEvent({
    eventType: 'import.started',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    metadata: { sourceType: body.sourceType, sourceFileName: body.sourceFileName ?? null },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return jsonSuccess({ importBatchId: batch.id, status: batch.status }, context.correlationId, {
    status: 201,
  });
};

/* --------------------------------------------------------- upload the rows */

const uploadRows = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:import');
  const batchId = context.params.id as string;
  const batch = await loadBatch(batchId, actor.id);

  if (batch.status !== 'draft') {
    throw new ValidationError('This import can no longer accept rows.');
  }

  const body = await parseJsonBody(request, uploadImportRowsSchema);
  const settings = await getSettings();

  // Section 34: enforce the configured row ceiling server-side, not just in
  // the browser.
  const existing = await listImportRows(batchId);
  if (existing.length + body.rows.length > settings.maxImportRows) {
    throw new PayloadTooLargeError(
      `This import would exceed the configured limit of ${settings.maxImportRows} rows.`,
      { maxImportRows: settings.maxImportRows, attempted: existing.length + body.rows.length },
    );
  }

  const rows = body.rows.map((row) => {
    const normalized = toNormalizedSku(row.rawValue, {
      caseSensitive: settings.skuCaseSensitive,
    });
    return {
      sourceRowNumber: row.sourceRowNumber,
      rawSku: row.rawValue,
      displaySku: row.rawValue.trim(),
      normalizedSku: normalized,
    };
  });

  const inserted = await insertImportRows(batchId, rows);

  return jsonSuccess(
    { inserted, totalRows: existing.length + inserted },
    context.correlationId,
  );
};

/* ------------------------------------------------------------- validation */

const runValidation = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:import');
  const batchId = context.params.id as string;
  const batch = await loadBatch(batchId, actor.id);

  await parseJsonBody(request, validateImportRequestSchema);
  await enforceRateLimit(IMPORT_VALIDATION_RATE_LIMIT, actor.id, context.correlationId);

  if (batch.status === 'consumed') {
    throw new AppError(
      'IMPORT_ALREADY_CONSUMED',
      'This import has already produced a Stock Recheck.',
      409,
    );
  }

  const settings = await getSettings();
  const stockBasis = defaultStockBasis(settings);
  if (!isStockBasisComplete(stockBasis)) {
    throw new ValidationError(
      'The stock basis is incomplete. Configure a location or warehouse in Settings before importing.',
    );
  }

  const reader = await createBooksReader();
  const credentials = await resolveCredentials();

  const sourceRows = await listImportRows(batchId);
  if (sourceRows.length === 0) {
    throw new ValidationError('This import has no rows to validate.');
  }

  await setBatchStatus(batchId, 'validating', { started: true });

  // Resolve the organization name once so it can be stored on every snapshot.
  let organizationName: string | null = null;
  try {
    const organizations = await reader.listOrganizations(context.correlationId);
    organizationName =
      organizations.find(
        (organization) => organization.organization_id === credentials?.organizationId,
      )?.name ??
      organizations[0]?.name ??
      null;
  } catch {
    // A failure here must not abort validation; the org name is cosmetic.
    organizationName = null;
  }

  const rows: SourceRow[] = sourceRows.map((row) => ({
    sourceRowNumber: row.source_row_number,
    rawSku: row.raw_sku,
    displaySku: row.display_sku,
    normalizedSku: row.normalized_sku,
  }));

  const summary = await validateImportRows(rows, {
    reader,
    stockBasis,
    organizationId: credentials?.organizationId ?? null,
    organizationName,
    caseSensitive: settings.skuCaseSensitive,
    correlationId: context.correlationId,
  });

  await withTransaction(async (client) => {
    await applyRowOutcomes(
      client,
      batchId,
      summary.results.map((result) => ({
        sourceRowNumber: result.sourceRowNumber,
        status: result.status,
        failureCode: result.failureCode,
        failureReason: result.failureReason,
        duplicateOfRowNumber: result.duplicateOfRowNumber,
        zohoItemId: result.zohoItemId,
        snapshot: result.snapshot,
      })),
    );
    await refreshBatchCounters(client, batchId);
  });

  await setBatchStockBasis(batchId, stockBasis, {
    id: credentials?.organizationId ?? null,
    name: organizationName,
  });
  await setBatchStatus(batchId, 'validated', { finished: true });

  await recordAuditEvent({
    eventType: summary.abortedReason === null ? 'import.completed' : 'import.failed',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    metadata: {
      importBatchId: batchId,
      passed: summary.passed,
      failed: summary.failed,
      duplicates: summary.duplicates,
      ignoredBlanks: summary.ignoredBlanks,
      abortedReason: summary.abortedReason,
    },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return jsonSuccess(
    {
      importBatchId: batchId,
      totalSourceRows: summary.totalSourceRows,
      passed: summary.passed,
      failed: summary.failed,
      duplicates: summary.duplicates,
      ignoredBlanks: summary.ignoredBlanks,
      abortedReason: summary.abortedReason,
      usedMockData: reader.isMock,
    },
    context.correlationId,
  );
};

/* ------------------------------------------------------------ read result */

function toResultPayload(batch: ImportBatchRow, rows: Awaited<ReturnType<typeof listImportRows>>) {
  const passed = rows
    .filter((row) => row.validation_status === 'passed')
    .map((row) => ({
      sourceRow: row.source_row_number,
      itemName: row.resolved_snapshot_json?.itemName ?? '',
      sku: row.resolved_snapshot_json?.sku ?? row.display_sku,
      zohoStock: row.resolved_snapshot_json?.stockInHand ?? 0,
      vendor: row.resolved_snapshot_json?.vendorName ?? null,
      unit: row.resolved_snapshot_json?.unit ?? null,
      stockBasisType: row.resolved_snapshot_json?.stockBasisType ?? batch.stock_basis_type,
      stockBasisName:
        row.resolved_snapshot_json?.stockLocationName ??
        row.resolved_snapshot_json?.stockWarehouseName ??
        null,
    }));

  const failed = rows
    .filter((row) => row.validation_status === 'failed')
    .map((row) => {
      const code = row.failure_code;
      const isKnownCode = code !== null && isImportFailureCode(code);
      return {
        sourceRow: row.source_row_number,
        rawValue: row.raw_sku,
        normalizedSku: row.normalized_sku,
        failureCode: code ?? 'UNEXPECTED_ZOHO_RESPONSE',
        failureReason: row.failure_reason ?? 'This row could not be validated.',
        duplicateOfRowNumber: row.duplicate_of_row_number,
        retryable: isKnownCode ? retryableCodes().includes(code as ImportFailureCode) : false,
      };
    });

  const ignoredBlanks = rows
    .filter((row) => row.validation_status === 'ignored_blank')
    .map((row) => ({ sourceRow: row.source_row_number, rawValue: row.raw_sku }));

  return {
    importBatchId: batch.id,
    sourceType: batch.source_type,
    sourceFileName: batch.source_file_name,
    worksheetName: batch.worksheet_name,
    mappedSkuColumn: batch.mapped_sku_column,
    headerRowNumber: batch.header_row_number,
    status: batch.status,
    summary: {
      totalSourceRows: batch.total_source_rows,
      passed: batch.passed_rows,
      failed: batch.failed_rows,
      duplicates: batch.duplicate_rows,
      ignoredBlanks: batch.ignored_blank_rows,
    },
    stockBasis: {
      type: batch.stock_basis_type,
      locationId: batch.stock_location_id,
      locationName: batch.stock_location_name,
      warehouseId: batch.stock_warehouse_id,
      warehouseName: batch.stock_warehouse_name,
    },
    organization: {
      id: batch.zoho_organization_id,
      name: batch.zoho_organization_name,
    },
    snapshotAt: batch.validation_finished_at,
    passedRows: passed,
    failedRows: failed,
    ignoredBlankRows: ignoredBlanks,
    hasRetryableFailures: failed.some((row) => row.retryable),
  };
}

const getImport = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:import');
  const batchId = context.params.id as string;
  const batch = await loadBatch(batchId, actor.id);
  const rows = await listImportRows(batchId);

  return jsonSuccess(toResultPayload(batch, rows), context.correlationId);
};

/* ------------------------------------------------------------------ retry */

const retryImport = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:import');
  const batchId = context.params.id as string;
  const batch = await loadBatch(batchId, actor.id);
  const body = await parseJsonBody(request, retryImportRequestSchema);

  await enforceRateLimit(IMPORT_VALIDATION_RATE_LIMIT, actor.id, context.correlationId);

  // Only rows whose failure is transient may be retried (section 17).
  const candidates = await listRetryableRows(batchId, retryableCodes());
  const targeted =
    body.sourceRowNumbers === undefined
      ? candidates
      : candidates.filter((row) => body.sourceRowNumbers?.includes(row.source_row_number));

  if (targeted.length === 0) {
    return jsonSuccess(
      { retried: 0, message: 'There are no retryable rows in this import.' },
      context.correlationId,
    );
  }

  const settings = await getSettings();
  const stockBasis = defaultStockBasis(settings);
  const reader = await createBooksReader();
  const credentials = await resolveCredentials();

  const summary = await validateImportRows(
    targeted.map((row) => ({
      sourceRowNumber: row.source_row_number,
      rawSku: row.raw_sku,
      displaySku: row.display_sku,
      normalizedSku: row.normalized_sku,
    })),
    {
      reader,
      stockBasis,
      organizationId: credentials?.organizationId ?? null,
      organizationName: batch.zoho_organization_name,
      caseSensitive: settings.skuCaseSensitive,
      correlationId: context.correlationId,
    },
  );

  await withTransaction(async (client) => {
    await applyRowOutcomes(
      client,
      batchId,
      summary.results.map((result) => ({
        sourceRowNumber: result.sourceRowNumber,
        status: result.status,
        failureCode: result.failureCode,
        failureReason: result.failureReason,
        duplicateOfRowNumber: result.duplicateOfRowNumber,
        zohoItemId: result.zohoItemId,
        snapshot: result.snapshot,
      })),
    );
    await refreshBatchCounters(client, batchId);
  });

  return jsonSuccess(
    { retried: targeted.length, passed: summary.passed, failed: summary.failed },
    context.correlationId,
  );
};

/* ----------------------------------------------------------------- cancel */

const cancelImport = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:import');
  const batchId = context.params.id as string;
  const batch = await loadBatch(batchId, actor.id);

  if (batch.status === 'consumed') {
    throw new AppError(
      'IMPORT_ALREADY_CONSUMED',
      'This import already produced a Stock Recheck and cannot be cancelled.',
      409,
    );
  }

  await setBatchStatus(batchId, 'cancelled');
  await recordAuditEvent({
    eventType: 'import.cancelled',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    metadata: { importBatchId: batchId },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  // Section 15: cancelling must NOT create a Stock Recheck.
  return jsonSuccess({ cancelled: true, recheckCreated: false }, context.correlationId);
};

/* ------------------------------------------------- failed-rows workbook -- */

const downloadFailures = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:import');
  const batchId = context.params.id as string;
  await loadBatch(batchId, actor.id);

  const rows = await listImportRows(batchId, 'failed');
  const bytes = await buildFailedRowsWorkbook(
    rows.map((row) => {
      const code = row.failure_code ?? 'UNEXPECTED_ZOHO_RESPONSE';
      return {
        sourceRow: row.source_row_number,
        rawValue: row.raw_sku,
        normalizedSku: row.normalized_sku,
        failureCode: code,
        failureReason:
          row.failure_reason ??
          (isImportFailureCode(code)
            ? failureReason(code, { duplicateOfRowNumber: row.duplicate_of_row_number })
            : 'This row could not be validated.'),
      };
    }),
  );

  await recordAuditEvent({
    eventType: 'export.generated',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    metadata: { kind: 'import_failures', importBatchId: batchId, rowCount: rows.length },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return fileResponse(bytes, buildFailedRowsFileName(batchId), context.correlationId);
};

/* ------------------------------------------------------------------ route */

const routes: Route[] = [
  { method: 'POST', pattern: '/api/imports', handler: createImport },
  { method: 'POST', pattern: '/api/imports/:id/rows', handler: uploadRows },
  { method: 'POST', pattern: '/api/imports/:id/validate', handler: runValidation },
  { method: 'GET', pattern: '/api/imports/:id', handler: getImport },
  { method: 'POST', pattern: '/api/imports/:id/retry', handler: retryImport },
  { method: 'POST', pattern: '/api/imports/:id/cancel', handler: cancelImport },
  { method: 'GET', pattern: '/api/imports/:id/failures.xlsx', handler: downloadFailures },
];

const handler = withErrorHandling('imports', async (request, context) => {
  const match = matchRoute(routes, request);
  if (match === null) throw new NotFoundError('endpoint');
  return match.handler(request, { ...context, params: match.params });
});

export default async (request: Request, context: Context): Promise<Response> =>
  handler(request, { params: context.params, ip: context.ip });

export const config: Config = {
  path: [
    '/api/imports',
    '/api/imports/:id',
    '/api/imports/:id/rows',
    '/api/imports/:id/validate',
    '/api/imports/:id/retry',
    '/api/imports/:id/cancel',
    '/api/imports/:id/failures.xlsx',
  ],
};
