/**
 * Request/response schemas shared by the React app and the serverless
 * functions — specification sections 4.1 and 31.
 *
 * Defining them once means the client cannot send a shape the server does not
 * expect, and the server's validation is the same contract the UI was built
 * against (section 44).
 */

import { z } from 'zod';
import { IMPORT_SOURCE_TYPES } from '../domain/failureCodes';
import { ROLES } from '../domain/permissions';
import { EXPORT_FILTERS } from '../domain/exportContract';
import { ITEM_WORKFLOW_STATUSES, RECHECK_STATUSES, RESULT_STATUSES } from '../domain/status';
import { STOCK_BASIS_TYPES } from '../domain/stockBasis';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS, SORT_KEYS } from '../domain/settings';
import { MAX_RECHECK_NAME_LENGTH } from '../domain/recheckNumber';

/* --------------------------------------------------------------- primitives */

export const uuidSchema = z.string().uuid('Expected a valid identifier.');
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format.');

/** Query-string pagination. `z.coerce` handles the string→number conversion. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .catch(DEFAULT_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .transform((value) =>
      (PAGE_SIZE_OPTIONS as readonly number[]).includes(value) ? value : DEFAULT_PAGE_SIZE,
    ),
});

/* ------------------------------------------------------------------- auth */

export const loginRequestSchema = z.object({
  email: z.string().trim().min(1, 'Email is required.').email('Enter a valid email address.'),
  password: z.string().min(1, 'Password is required.'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const forgotPasswordRequestSchema = z.object({
  email: z.string().trim().email('Enter a valid email address.'),
});

export const acceptInviteRequestSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(12, 'Password must be at least 12 characters.').max(200),
});

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(12, 'Password must be at least 12 characters.').max(200),
});

export const changeOwnPasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12).max(200),
});

/* ---------------------------------------------------------------- imports */

export const createImportRequestSchema = z.object({
  sourceType: z.enum(IMPORT_SOURCE_TYPES),
  sourceFileName: z.string().max(400).nullable().optional(),
  worksheetName: z.string().max(200).nullable().optional(),
  mappedSkuColumn: z.string().max(50).nullable().optional(),
  headerRowNumber: z.number().int().min(0).max(10_000).nullable().optional(),
});
export type CreateImportRequest = z.infer<typeof createImportRequestSchema>;

/**
 * Rows are uploaded in chunks so a 20,000-row sheet stays under the serverless
 * request-body limit.
 */
export const uploadImportRowsSchema = z.object({
  rows: z
    .array(
      z.object({
        sourceRowNumber: z.number().int().min(1).max(1_000_000),
        rawValue: z.string().max(1000),
      }),
    )
    .min(1)
    .max(5000, 'Send at most 5000 rows per request.'),
});
export type UploadImportRowsRequest = z.infer<typeof uploadImportRowsSchema>;

export const validateImportRequestSchema = z.object({
  /** Confirms the operator saw the "no data will be updated in Zoho" notice. */
  acknowledgedReadOnly: z.literal(true),
});

export const retryImportRequestSchema = z.object({
  sourceRowNumbers: z.array(z.number().int().min(1)).max(5000).optional(),
});

/* --------------------------------------------------------------- rechecks */

export const createRecheckRequestSchema = z.object({
  importBatchId: uuidSchema,
  name: z
    .string()
    .trim()
    .min(1, 'Recheck name is required.')
    .max(MAX_RECHECK_NAME_LENGTH, `Name must be ${MAX_RECHECK_NAME_LENGTH} characters or fewer.`),
  businessDate: isoDateSchema,
  /** Section 18 requires this acknowledgement checkbox. */
  acknowledgedReadOnly: z.literal(true, {
    errorMap: () => ({ message: 'You must acknowledge that Zoho will not be updated.' }),
  }),
  idempotencyKey: z.string().min(8).max(200),
});
export type CreateRecheckRequest = z.infer<typeof createRecheckRequestSchema>;

export const cancelRecheckRequestSchema = z.object({
  reason: z.string().trim().min(3, 'Provide a reason.').max(500),
});

export const listRechecksQuerySchema = z.object({
  status: z.string().optional(),
  fromDate: isoDateSchema.optional(),
  toDate: isoDateSchema.optional(),
  createdBy: uuidSchema.optional(),
  stockBasisType: z.enum(STOCK_BASIS_TYPES).optional(),
  hasMismatch: z.enum(['true', 'false']).optional(),
  recheckNumber: z.string().max(100).optional(),
  name: z.string().max(200).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  pageSize: z.string().regex(/^\d+$/).optional(),
});

export const listItemsQuerySchema = z.object({
  /**
   * Comma-separated item ids, for fetching a KNOWN set regardless of paging.
   *
   * The amend screen needs exactly the rows the operator selected. Without
   * this it could only request one page of submitted items and filter locally,
   * so on a recheck with more submitted items than fit a page, anything past
   * the first page silently resolved to nothing and the editor opened empty.
   */
  ids: z.string().max(40 * 200).optional(),
  search: z.string().max(200).optional(),
  workflowStatus: z.enum(ITEM_WORKFLOW_STATUSES).optional(),
  resultStatus: z.enum(RESULT_STATUSES).optional(),
  vendor: z.string().max(200).optional(),
  claimedBy: uuidSchema.optional(),
  onlyMine: z.enum(['true', 'false']).optional(),
  sort: z.enum(SORT_KEYS).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  page: z.string().regex(/^\d+$/).optional(),
  pageSize: z.string().regex(/^\d+$/).optional(),
});

/* ----------------------------------------------------------------- claims */

export const heartbeatRequestSchema = z.object({
  claimVersion: z.number().int().min(0),
});

export const releaseClaimRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const forceReleaseRequestSchema = z.object({
  /** Section 19 requires a reason for an administrator force-release. */
  reason: z.string().trim().min(3, 'A reason is required.').max(500),
});

/* ------------------------------------------------------------- submission */

export const submitCountRequestSchema = z.object({
  /** Zero is explicitly valid — section 21. */
  countedQuantity: z
    .number()
    .int('Counted quantity must be a whole number.')
    .min(0, 'Counted quantity cannot be negative.')
    .max(1_000_000, 'Counted quantity is implausibly large.'),
  claimVersion: z.number().int().min(0),
  idempotencyKey: z.string().min(8).max(200),
});
export type SubmitCountRequest = z.infer<typeof submitCountRequestSchema>;

export const reopenItemRequestSchema = z.object({
  reason: z.string().trim().min(3, 'A written reason is required.').max(1000),
  idempotencyKey: z.string().min(8).max(200),
});

/**
 * Editing the counted quantity on an already-submitted item.
 *
 * The reason is mandatory and lands in the audit trail — a silent correction of
 * a submitted figure is exactly what an audit needs to be able to see.
 */
export const amendCountRequestSchema = z.object({
  countedQuantity: z
    .number()
    .int('Counted quantity must be a whole number.')
    .min(0, 'Counted quantity cannot be negative.')
    .max(100_000_000),
  reason: z.string().trim().min(3, 'A written reason is required.').max(1000),
  idempotencyKey: z.string().min(8).max(200),
});
export type AmendCountRequest = z.infer<typeof amendCountRequestSchema>;

/**
 * Multi-select claim from the workspace table.
 *
 * The upper bound is a deliberate guard: each identifier costs one conditional
 * UPDATE plus, on failure, one lookup, and the whole batch runs inside a single
 * function invocation with a platform timeout.
 */
export const bulkClaimRequestSchema = z.object({
  itemIds: z
    .array(z.string().uuid())
    .min(1, 'Select at least one item.')
    .max(100, 'Claim at most 100 items at a time.'),
});
export type BulkClaimRequest = z.infer<typeof bulkClaimRequestSchema>;

/* --------------------------------------------------------------- exports */

export const exportQuerySchema = z.object({
  filter: z.enum(EXPORT_FILTERS).optional(),
});

/* ----------------------------------------------------------------- admin */

export const inviteUserRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(320),
  displayName: z.string().trim().min(1, 'Name is required.').max(200),
  role: z.enum(ROLES),
});

export const updateUserRequestSchema = z.object({
  role: z.enum(ROLES).optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});

export const disableUserRequestSchema = z.object({
  releaseActiveClaim: z.boolean().optional().default(false),
  reason: z.string().trim().max(500).optional(),
});

export const auditQuerySchema = z.object({
  eventType: z.string().max(100).optional(),
  actorUserId: uuidSchema.optional(),
  recheckId: uuidSchema.optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  pageSize: z.string().regex(/^\d+$/).optional(),
});

export const updateSettingsRequestSchema = z
  .object({
    businessName: z.string().trim().min(1).max(200).optional(),
    businessTimezone: z.string().min(1).max(100).optional(),
    dateFormat: z.string().min(1).max(50).optional(),
    recheckPrefix: z.string().regex(/^[A-Za-z0-9]{1,10}$/).optional(),
    maxImportRows: z.number().int().min(1).max(100_000).optional(),
    maxFileSizeBytes: z.number().int().min(1024).max(52_428_800).optional(),
    skuCaseSensitive: z.boolean().optional(),
    defaultSort: z.enum(SORT_KEYS).optional(),
    scannerSoundEnabled: z.boolean().optional(),

    defaultStockBasisType: z.enum(STOCK_BASIS_TYPES).optional(),
    defaultLocationId: z.string().max(100).nullable().optional(),
    defaultLocationName: z.string().max(200).nullable().optional(),
    defaultWarehouseId: z.string().max(100).nullable().optional(),
    defaultWarehouseName: z.string().max(200).nullable().optional(),

    claimLeaseSeconds: z.number().int().min(60).max(86_400).optional(),
    heartbeatSeconds: z.number().int().min(5).max(3600).optional(),
    staleClaimGraceSeconds: z.number().int().min(0).max(3600).optional(),
    countersMayReleaseOwnClaims: z.boolean().optional(),
    adminsMayForceRelease: z.boolean().optional(),

    blindCountEnabled: z.boolean().optional(),
    scannerSuccessSound: z.boolean().optional(),
    scannerErrorSound: z.boolean().optional(),
    scannerSuccessFlash: z.boolean().optional(),
    scannerErrorFlash: z.boolean().optional(),
    scannerRequireEnter: z.boolean().optional(),
    scannerAutoSelectInvalid: z.boolean().optional(),
    scannerPreventSleep: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.claimLeaseSeconds === undefined ||
      value.heartbeatSeconds === undefined ||
      value.heartbeatSeconds * 3 <= value.claimLeaseSeconds,
    {
      message: 'Heartbeat interval must be at most one third of the claim lease.',
      path: ['heartbeatSeconds'],
    },
  );

export const testZohoRequestSchema = z.object({}).optional();

export const disconnectZohoRequestSchema = z.object({
  confirmation: z.literal('DISCONNECT', {
    errorMap: () => ({ message: 'Type DISCONNECT to confirm.' }),
  }),
});

/* --------------------------------------------------- response value types */

export const recheckStatusSchema = z.enum(RECHECK_STATUSES);
export const workflowStatusSchema = z.enum(ITEM_WORKFLOW_STATUSES);
export const resultStatusSchema = z.enum(RESULT_STATUSES);
