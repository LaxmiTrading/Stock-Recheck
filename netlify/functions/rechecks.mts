/**
 * Stock Recheck endpoints — specification sections 18, 19, 25, 26, 31.
 *
 *   POST /api/rechecks                  create from a validated import
 *   GET  /api/rechecks                  list / history
 *   GET  /api/rechecks/:id              header + progress
 *   GET  /api/rechecks/:id/items        workspace item list
 *   GET  /api/rechecks/:id/scannables   normalized SKU index for the scanner
 *   POST /api/rechecks/:id/cancel       administrator cancellation
 *   POST /api/rechecks/:id/refresh-stock  re-read Zoho stock for unsubmitted items
 *   GET  /api/rechecks/:id/summary      summary screen payload
 *   GET  /api/rechecks/:id/export.xlsx  difference workbook
 */

import type { Config, Context } from '@netlify/functions';
import {
  cancelRecheckRequestSchema,
  createRecheckRequestSchema,
  exportQuerySchema,
  listItemsQuerySchema,
  listRechecksQuerySchema,
} from '../../src/schemas/api';
import {
  buildExportFileName,
  buildExportRows,
  isExportFilter,
  type ExportFilter,
} from '../../src/domain/exportContract';
import {
  calculateCompletionPercentage,
  isRecheckReadOnly,
  RECHECK_STATUSES,
  type RecheckStatus,
} from '../../src/domain/status';
import { clampPageSize, DEFAULT_PAGE_SIZE } from '../../src/domain/settings';
import { isValidBusinessDate } from '../../src/domain/recheckNumber';
import { recordAuditEvent, recordAuditEventInTransaction } from '../shared/audit';
import { requireActorWith, requireUser } from '../shared/auth/session';
import { isUniqueViolation, withTransaction } from '../shared/database/client';
import { createBooksReader, resolveItemSnapshot, ZOHO_CONCURRENCY } from '../shared/zoho/books';
import { mapWithConcurrency } from '../shared/zoho/client';
import { AppError, NotFoundError, ValidationError } from '../shared/errors';
import { buildDifferenceWorkbook } from '../shared/excel/workbook';
import {
  fileResponse,
  jsonSuccess,
  matchRoute,
  parseJsonBody,
  parseSearchParams,
  withErrorHandling,
  type Route,
  type RouteContext,
} from '../shared/http';
import {
  abandonIdempotentOperation,
  beginIdempotentOperation,
  completeIdempotentOperation,
} from '../shared/idempotency';
import { createItemsFromPassedRows, findImportBatch } from '../shared/repositories/imports';
import {
  applyStockRefresh,
  listFilterFacets,
  listItems,
  listItemsForExport,
  listRefreshableItems,
  listScannableItems,
  recalculateRecheckProgress,
  type StockRefreshUpdate,
} from '../shared/repositories/items';
import {
  allocateRecheckNumber,
  cancelRecheck,
  findRecheckById,
  getSummaryTotals,
  insertRecheck,
  listRechecks,
  markImportConsumed,
  type RecheckWithNames,
} from '../shared/repositories/rechecks';
import { getSettings } from '../shared/repositories/settings';
import { enforceRateLimit, EXPORT_RATE_LIMIT } from '../shared/rateLimit';

async function loadRecheck(recheckId: string): Promise<RecheckWithNames> {
  const recheck = await findRecheckById(recheckId);
  if (recheck === null) throw new NotFoundError('Stock Recheck');
  return recheck;
}

function serializeRecheck(recheck: RecheckWithNames) {
  return {
    id: recheck.id,
    recheckNumber: recheck.recheck_number,
    name: recheck.name,
    businessDate: recheck.business_date,
    status: recheck.status,
    importSourceType: recheck.import_source_type,
    organization: {
      id: recheck.zoho_organization_id,
      name: recheck.zoho_organization_name,
    },
    stockBasis: {
      type: recheck.stock_basis_type,
      locationId: recheck.stock_location_id,
      locationName: recheck.stock_location_name,
      warehouseId: recheck.stock_warehouse_id,
      warehouseName: recheck.stock_warehouse_name,
    },
    zohoSnapshotAt: recheck.zoho_snapshot_at,
    counts: {
      totalItems: recheck.total_items,
      availableItems: recheck.available_items,
      inProgressItems: recheck.in_progress_items,
      submittedItems: recheck.submitted_items,
      matchedItems: recheck.matched_items,
      mismatchedItems: recheck.mismatched_items,
    },
    completionPercentage: calculateCompletionPercentage({
      submittedItems: recheck.submitted_items,
      totalItems: recheck.total_items,
    }),
    createdBy: recheck.created_by,
    createdByName: recheck.created_by_name,
    createdAt: recheck.created_at,
    startedAt: recheck.started_at,
    completedAt: recheck.completed_at,
    cancelledAt: recheck.cancelled_at,
    cancelledByName: recheck.cancelled_by_name,
    cancellationReason: recheck.cancellation_reason,
    isReadOnly: isRecheckReadOnly(recheck.status),
    version: recheck.version,
  };
}

/* ----------------------------------------------------------------- create */

const createRecheckHandler = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:create');
  const body = await parseJsonBody(request, createRecheckRequestSchema);

  if (!isValidBusinessDate(body.businessDate)) {
    throw new ValidationError('Business date is not a valid calendar date.');
  }

  // Section 18: repeated clicks or a network retry must not create duplicates.
  const reservation = await beginIdempotentOperation<{ recheckId: string }>({
    userId: actor.id,
    operation: 'recheck.create',
    idempotencyKey: body.idempotencyKey,
    requestPayload: { importBatchId: body.importBatchId, name: body.name, businessDate: body.businessDate },
  });

  if (reservation.kind === 'replay') {
    return jsonSuccess(reservation.body, context.correlationId, { status: 200 });
  }
  if (reservation.kind === 'in_flight') {
    throw new AppError(
      'IDEMPOTENCY_CONFLICT',
      'This Stock Recheck is already being created. Wait a moment and refresh.',
      409,
    );
  }

  try {
    const batch = await findImportBatch(body.importBatchId, actor.id);
    if (batch === null) throw new NotFoundError('import');
    if (batch.status === 'consumed') {
      throw new AppError(
        'IMPORT_ALREADY_CONSUMED',
        'This import has already produced a Stock Recheck.',
        409,
      );
    }
    if (batch.status !== 'validated') {
      throw new AppError(
        'IMPORT_NOT_VALIDATED',
        'Validate this import against Zoho before creating a Stock Recheck.',
        409,
      );
    }
    if (batch.passed_rows === 0) {
      throw new AppError(
        'IMPORT_NO_PASSED_ROWS',
        'No rows passed validation, so there is nothing to count.',
        409,
      );
    }

    const settings = await getSettings();

    const result = await withTransaction(async (client) => {
      // Claim the batch first: if another request already consumed it, we stop
      // here rather than creating an empty duplicate recheck.
      const consumed = await markImportConsumed(client, batch.id);
      if (!consumed) {
        throw new AppError(
          'IMPORT_ALREADY_CONSUMED',
          'This import has already produced a Stock Recheck.',
          409,
        );
      }

      const { recheckNumber, sequence } = await allocateRecheckNumber(
        client,
        body.businessDate,
        settings.recheckPrefix,
      );

      const recheck = await insertRecheck(client, {
        recheckNumber,
        name: body.name,
        businessDate: body.businessDate,
        importBatchId: batch.id,
        importSourceType: batch.source_type,
        zohoOrganizationId: batch.zoho_organization_id,
        zohoOrganizationName: batch.zoho_organization_name,
        stockBasis: {
          type: batch.stock_basis_type ?? 'organization',
          locationId: batch.stock_location_id,
          locationName: batch.stock_location_name,
          warehouseId: batch.stock_warehouse_id,
          warehouseName: batch.stock_warehouse_name,
        },
        // Section 2.6: the snapshot instant is the validation time.
        zohoSnapshotAt: batch.validation_finished_at ?? new Date().toISOString(),
        createdBy: actor.id,
      });

      const itemCount = await createItemsFromPassedRows(client, {
        recheckId: recheck.id,
        importBatchId: batch.id,
      });

      await recalculateRecheckProgress(client, recheck.id);

      await recordAuditEventInTransaction(client, {
        eventType: 'recheck.created',
        actorUserId: actor.id,
        actorDisplayName: actor.displayName,
        stockRecheckId: recheck.id,
        metadata: {
          recheckNumber,
          sequence,
          itemCount,
          importBatchId: batch.id,
          sourceType: batch.source_type,
          stockBasisType: batch.stock_basis_type,
        },
        correlationId: context.correlationId,
        requestIp: context.requestIp,
      });

      return { recheckId: recheck.id, recheckNumber, itemCount };
    });

    await completeIdempotentOperation({
      userId: actor.id,
      operation: 'recheck.create',
      idempotencyKey: body.idempotencyKey,
      status: 201,
      body: result,
    });

    return jsonSuccess(result, context.correlationId, { status: 201 });
  } catch (error) {
    // Release the reservation so a corrected retry is not blocked forever.
    await abandonIdempotentOperation({
      userId: actor.id,
      operation: 'recheck.create',
      idempotencyKey: body.idempotencyKey,
    });

    if (isUniqueViolation(error, 'stock_rechecks_number_unique')) {
      throw new AppError(
        'INTERNAL_ERROR',
        'Two Stock Rechecks were created at the same instant. Try again.',
        409,
      );
    }
    throw error;
  }
};

/* ------------------------------------------------------------------- list */

const listRechecksHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireUser(request);
  const params = parseSearchParams(request, listRechecksQuerySchema);

  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10));
  const pageSize = clampPageSize(Number.parseInt(params.pageSize ?? String(DEFAULT_PAGE_SIZE), 10));

  const statuses =
    params.status === undefined
      ? undefined
      : params.status
          .split(',')
          .map((value) => value.trim())
          .filter((value): value is RecheckStatus =>
            (RECHECK_STATUSES as readonly string[]).includes(value),
          );

  const { rechecks, total } = await listRechecks({
    statuses,
    fromDate: params.fromDate,
    toDate: params.toDate,
    createdBy: params.createdBy,
    stockBasisType: params.stockBasisType,
    hasMismatch: params.hasMismatch === undefined ? undefined : params.hasMismatch === 'true',
    recheckNumber: params.recheckNumber,
    name: params.name,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  return jsonSuccess(
    {
      rechecks: rechecks.map(serializeRecheck),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    },
    context.correlationId,
  );
};

/* -------------------------------------------------------------------- get */

const getRecheckHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireUser(request);
  const recheck = await loadRecheck(context.params.id as string);
  return jsonSuccess({ recheck: serializeRecheck(recheck) }, context.correlationId);
};

/* ------------------------------------------------------------------ items */

const listItemsHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireUser(request);
  const recheckId = context.params.id as string;
  const recheck = await loadRecheck(recheckId);
  const params = parseSearchParams(request, listItemsQuerySchema);
  const settings = await getSettings();

  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10));
  const pageSize = clampPageSize(Number.parseInt(params.pageSize ?? String(DEFAULT_PAGE_SIZE), 10));

  const { items, total } = await listItems({
    recheckId,
    search: params.search,
    workflowStatus: params.workflowStatus,
    resultStatus: params.resultStatus,
    vendor: params.vendor,
    brand: params.brand,
    manufacturer: params.manufacturer,
    claimedBy: params.claimedBy,
    onlyMine: params.onlyMine === 'true' ? actor.id : undefined,
    sortKey: params.sort ?? settings.defaultSort,
    sortDirection: params.direction ?? 'asc',
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const facets = await listFilterFacets(recheckId);

  // Section 21: with blind count enabled the Zoho quantity is withheld until
  // the item has been submitted.
  const hideZohoStock = settings.blindCountEnabled;

  return jsonSuccess(
    {
      items: items.map((item) => ({
        id: item.id,
        itemName: item.item_name,
        sku: item.sku,
        normalizedSku: item.normalized_sku,
        zohoStock:
          hideZohoStock && item.workflow_status !== 'submitted' ? null : item.zoho_stock_quantity,
        vendor: item.vendor_name,
        brand: item.brand_name,
        manufacturer: item.manufacturer_name,
        unit: item.unit,
        workflowStatus: item.workflow_status,
        resultStatus: item.result_status,
        claimedBy: item.claimed_by,
        claimedByName: item.claimed_by_name,
        claimedAt: item.claimed_at,
        claimExpiresAt: item.claim_expires_at,
        claimVersion: item.claim_version,
        isClaimedByMe: item.claimed_by === actor.id,
        countedQuantity: item.counted_quantity,
        quantityDifference: item.quantity_difference,
        submittedByName: item.submitted_by_name,
        submittedAt: item.submitted_at,
      })),
      facets,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      recheckStatus: recheck.status,
      isReadOnly: isRecheckReadOnly(recheck.status),
    },
    context.correlationId,
  );
};

/**
 * Normalized-SKU index for the counting screen — section 3.3.
 * Carries no counts or claim data, only what the scanner needs to name a
 * sibling item in a wrong-scan message.
 */
const listScannablesHandler = async (
  request: Request,
  context: RouteContext,
): Promise<Response> => {
  await requireUser(request);
  const recheckId = context.params.id as string;
  await loadRecheck(recheckId);
  const items = await listScannableItems(recheckId);

  return jsonSuccess(
    {
      items: items.map((item) => ({
        id: item.id,
        itemName: item.item_name,
        sku: item.sku,
        normalizedSku: item.normalized_sku,
      })),
    },
    context.correlationId,
  );
};

/* ----------------------------------------------------------------- cancel */

const cancelRecheckHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:cancel');
  const recheckId = context.params.id as string;
  const body = await parseJsonBody(request, cancelRecheckRequestSchema);

  const recheck = await loadRecheck(recheckId);
  if (isRecheckReadOnly(recheck.status)) {
    throw new AppError(
      'RECHECK_READ_ONLY',
      recheck.status === 'completed'
        ? 'A completed Stock Recheck cannot be cancelled.'
        : 'This Stock Recheck is already cancelled.',
      409,
    );
  }

  // Cancellation never deletes submitted historical data (section 19).
  const cancelled = await cancelRecheck({
    recheckId,
    actorId: actor.id,
    reason: body.reason,
  });
  if (cancelled === null) throw new NotFoundError('Stock Recheck');

  await recordAuditEvent({
    eventType: 'recheck.cancelled',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    stockRecheckId: recheckId,
    metadata: {
      reason: body.reason,
      submittedItemsPreserved: recheck.submitted_items,
      claimsReleased: cancelled.releasedClaims.length,
    },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  /*
   * One entry per claim the cancellation broke. The counter loses their
   * in-progress work, so the log has to name whose claim went and on what —
   * a single aggregate count on the cancellation event would not.
   */
  for (const claim of cancelled.releasedClaims) {
    await recordAuditEvent({
      eventType: 'item.claim_force_released',
      actorUserId: actor.id,
      actorDisplayName: actor.displayName,
      stockRecheckId: recheckId,
      stockRecheckItemId: claim.id,
      metadata: {
        reason: 'Stock Recheck cancelled',
        previousOwnerId: claim.previous_owner,
        sku: claim.sku,
      },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });
  }

  return jsonSuccess(
    {
      cancelled: true,
      submittedItemsPreserved: recheck.submitted_items,
      claimsReleased: cancelled.releasedClaims.length,
    },
    context.correlationId,
  );
};

/* ---------------------------------------------------------- stock refresh */

/**
 * Re-reads the Zoho stock figure for every item that has NOT been submitted.
 *
 * The original design took one reading when the Stock Recheck was created and
 * never revisited it. On a count that runs across a shift that reading drifts:
 * goods arrive, orders ship, and every remaining row is then measured against a
 * figure that stopped being true hours ago.
 *
 * What this does NOT touch is the important part. A submitted row keeps the
 * figure its result was computed against — section 2.2 makes the Zoho snapshot
 * part of the permanent record of that submission, and section 2.5 defines the
 * stored difference as counted minus THAT figure. Refreshing it would silently
 * restate finished work.
 *
 * Still GET-only against Zoho (section 2.1): this reads stock and writes the
 * result into our own database. Nothing is ever sent to Zoho.
 */
const refreshStockHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:import');
  const recheckId = context.params.id as string;

  const recheck = await findRecheckById(recheckId);
  if (recheck === null) throw new NotFoundError('Stock Recheck');
  if (isRecheckReadOnly(recheck.status)) {
    throw new AppError(
      'RECHECK_READ_ONLY',
      'This Stock Recheck is closed, so its stock figures can no longer be updated.',
      409,
    );
  }

  const items = await listRefreshableItems(recheckId);
  if (items.length === 0) {
    return jsonSuccess(
      { updated: 0, skippedSubmitted: recheck.submitted_items, unresolved: [], refreshedAt: null },
      context.correlationId,
    );
  }

  const settings = await getSettings();
  const reader = await createBooksReader();
  const stockBasis = {
    type: recheck.stock_basis_type,
    locationId: recheck.stock_location_id,
    locationName: recheck.stock_location_name,
    warehouseId: recheck.stock_warehouse_id,
    warehouseName: recheck.stock_warehouse_name,
  };

  const unresolved: { sku: string; reason: string }[] = [];
  const updates: StockRefreshUpdate[] = [];

  await mapWithConcurrency(items, ZOHO_CONCURRENCY, async (item) => {
    try {
      const lookup = await reader.lookupBySku(item.normalized_sku, context.correlationId);
      if (lookup.kind !== 'found') {
        unresolved.push({ sku: item.sku, reason: lookup.kind === 'ambiguous' ? 'AMBIGUOUS_SKU' : 'SKU_NOT_FOUND' });
        return;
      }

      const resolution = resolveItemSnapshot({
        item: lookup.item,
        stockBasis,
        caseSensitive: settings.skuCaseSensitive,
      });
      if (!resolution.ok) {
        unresolved.push({ sku: item.sku, reason: resolution.failure });
        return;
      }

      updates.push({
        itemId: item.id,
        stockQuantity: resolution.item.stockInHand,
        snapshot: lookup.item,
      });
    } catch (error) {
      // One unreachable SKU must not abandon the rest of the refresh.
      unresolved.push({
        sku: item.sku,
        reason: error instanceof AppError ? error.code : 'ZOHO_TEMPORARILY_UNAVAILABLE',
      });
    }
  });

  const updated = await applyStockRefresh(recheckId, updates);

  await recordAuditEvent({
    eventType: 'recheck.stock_refreshed',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    stockRecheckId: recheckId,
    metadata: {
      updated,
      considered: items.length,
      skippedSubmitted: recheck.submitted_items,
      unresolved: unresolved.length,
    },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return jsonSuccess(
    {
      updated,
      considered: items.length,
      skippedSubmitted: recheck.submitted_items,
      unresolved,
      refreshedAt: new Date().toISOString(),
    },
    context.correlationId,
  );
};

/* ---------------------------------------------------------------- summary */

const summaryHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireUser(request);
  const recheckId = context.params.id as string;
  const recheck = await loadRecheck(recheckId);
  const totals = await getSummaryTotals(recheckId);

  const isComplete = recheck.status === 'completed';

  return jsonSuccess(
    {
      recheck: serializeRecheck(recheck),
      totals: {
        totalItems: totals.total_items,
        submitted: totals.submitted_items,
        remaining: totals.remaining_items,
        countingInProgress: totals.in_progress_items,
        matched: totals.matched_items,
        mismatched: totals.mismatched_items,
        totalPositiveDifference: totals.total_positive_difference,
        // Section 25: the negative total stays negative.
        totalNegativeDifference: totals.total_negative_difference,
      },
      isComplete,
      message: isComplete
        ? 'All items have been counted. This Stock Recheck is complete.'
        : `This is a current summary. ${totals.remaining_items} items have not yet been submitted.`,
    },
    context.correlationId,
  );
};

/* ----------------------------------------------------------------- export */

const exportHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'recheck:export');
  const recheckId = context.params.id as string;
  const recheck = await loadRecheck(recheckId);

  await enforceRateLimit(EXPORT_RATE_LIMIT, actor.id, context.correlationId);

  const params = parseSearchParams(request, exportQuerySchema);
  const filter: ExportFilter =
    params.filter !== undefined && isExportFilter(params.filter) ? params.filter : 'all_submitted';

  const items = await listItemsForExport(recheckId);
  const rows = buildExportRows(
    items.map((item) => ({
      itemName: item.item_name,
      sku: item.sku,
      quantityDifference: item.quantity_difference,
      resultStatus: item.result_status,
      submittedAt: item.submitted_at,
    })),
    filter,
  );

  const bytes = await buildDifferenceWorkbook(rows);

  await recordAuditEvent({
    eventType: 'export.generated',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    stockRecheckId: recheckId,
    metadata: { kind: 'difference', filter, rowCount: rows.length },
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  return fileResponse(
    bytes,
    buildExportFileName(recheck.recheck_number, recheck.business_date),
    context.correlationId,
  );
};

/* ------------------------------------------------------------------ route */

const routes: Route[] = [
  { method: 'POST', pattern: '/api/rechecks', handler: createRecheckHandler },
  { method: 'GET', pattern: '/api/rechecks', handler: listRechecksHandler },
  { method: 'GET', pattern: '/api/rechecks/:id', handler: getRecheckHandler },
  { method: 'GET', pattern: '/api/rechecks/:id/items', handler: listItemsHandler },
  { method: 'GET', pattern: '/api/rechecks/:id/scannables', handler: listScannablesHandler },
  { method: 'POST', pattern: '/api/rechecks/:id/cancel', handler: cancelRecheckHandler },
  { method: 'POST', pattern: '/api/rechecks/:id/refresh-stock', handler: refreshStockHandler },
  { method: 'GET', pattern: '/api/rechecks/:id/summary', handler: summaryHandler },
  { method: 'GET', pattern: '/api/rechecks/:id/export.xlsx', handler: exportHandler },
];

const handler = withErrorHandling('rechecks', async (request, context) => {
  const match = matchRoute(routes, request);
  if (match === null) throw new NotFoundError('endpoint');
  return match.handler(request, { ...context, params: match.params });
});

export default async (request: Request, context: Context): Promise<Response> =>
  handler(request, { params: context.params, ip: context.ip });

export const config: Config = {
  path: [
    '/api/rechecks',
    '/api/rechecks/:id',
    '/api/rechecks/:id/items',
    '/api/rechecks/:id/scannables',
    '/api/rechecks/:id/cancel',
    // Must be listed here as well as in `routes` above: Netlify only invokes
    // this function for paths declared in the config, so a route the internal
    // router handles but the config omits returns 404 without ever running.
    '/api/rechecks/:id/refresh-stock',
    '/api/rechecks/:id/summary',
    '/api/rechecks/:id/export.xlsx',
  ],
};
