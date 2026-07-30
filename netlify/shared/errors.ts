/**
 * Centralized error codes and error types — specification sections 31, 34, 37.
 *
 * Every failure the API can produce maps to a STABLE code plus a user-facing
 * message that suggests a next action. "Something went wrong" is only used
 * when nothing more specific is knowable (section 37).
 */

export const ERROR_CODES = [
  /* Authentication / authorization */
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_DISABLED',
  'FORBIDDEN',
  'INVITE_INVALID',
  'INVITE_EXPIRED',

  /* Request shape */
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'IDEMPOTENCY_CONFLICT',

  /* Domain conflicts */
  'ITEM_ALREADY_CLAIMED',
  'CLAIM_NOT_OWNED',
  'CLAIM_EXPIRED',
  'ITEM_ALREADY_SUBMITTED',
  'RECHECK_READ_ONLY',
  'RECHECK_CANCELLED',
  'IMPORT_NOT_VALIDATED',
  'IMPORT_NO_PASSED_ROWS',
  'IMPORT_ALREADY_CONSUMED',
  // Floor: refusing to remove the only administrator.
  'LAST_ADMINISTRATOR',
  // Ceiling: refusing to create a second one (migration 0003).
  'ADMINISTRATOR_LIMIT',
  'DUPLICATE_EMAIL',

  /* Integrations */
  'ZOHO_NOT_CONFIGURED',
  'ZOHO_AUTHENTICATION_FAILED',
  'ZOHO_RATE_LIMITED',
  'ZOHO_UNAVAILABLE',
  'ZOHO_UNEXPECTED_RESPONSE',
  'ZOHO_READ_ONLY_VIOLATION',

  /* Infrastructure */
  'DATABASE_UNAVAILABLE',
  'EXPORT_FAILED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type ErrorDetails = Record<string, unknown>;

/** Base class for every deliberate API failure. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: ErrorDetails;
  /** When true the message is safe to show verbatim to the user. */
  readonly exposeMessage: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details: ErrorDetails = {},
    exposeMessage = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.exposeMessage = exposeMessage;
  }
}

/* --------------------------------------------------------- concrete errors */

export class UnauthenticatedError extends AppError {
  constructor(message = 'Sign in to continue.') {
    super('UNAUTHENTICATED', message, 401);
  }
}

export class SessionExpiredError extends AppError {
  constructor(message = 'Your session expired. Sign in again to continue.') {
    super('SESSION_EXPIRED', message, 401);
  }
}

/**
 * Deliberately generic — section 9 forbids revealing whether an email exists.
 */
export class InvalidCredentialsError extends AppError {
  constructor() {
    super('INVALID_CREDENTIALS', 'Email or password is incorrect.', 401);
  }
}

export class AccountDisabledError extends AppError {
  constructor() {
    super('ACCOUNT_DISABLED', 'This account has been disabled. Contact an administrator.', 403);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super('FORBIDDEN', message, 403);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'The submitted data is not valid.', details: ErrorDetails = {}) {
    super('VALIDATION_FAILED', message, 400, details);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'resource') {
    super('NOT_FOUND', `The requested ${resource} was not found.`, 404);
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(method: string) {
    super('METHOD_NOT_ALLOWED', `${method} is not supported on this endpoint.`, 405);
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message: string, details: ErrorDetails = {}) {
    super('PAYLOAD_TOO_LARGE', message, 413, details);
  }
}

export class RateLimitedError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(
      'RATE_LIMITED',
      `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
      429,
      { retryAfterSeconds },
    );
  }
}

/* ----------------------------------------------------------- claim errors */

export class ItemAlreadyClaimedError extends AppError {
  constructor(claimedByName?: string) {
    super(
      'ITEM_ALREADY_CLAIMED',
      claimedByName === undefined
        ? 'This item was just claimed by another user.'
        : `This item was just claimed by ${claimedByName}.`,
      409,
      claimedByName === undefined ? {} : { claimedByName },
    );
  }
}

export class ClaimNotOwnedError extends AppError {
  constructor(message = 'You do not hold the active claim on this item.') {
    super('CLAIM_NOT_OWNED', message, 409);
  }
}

export class ClaimExpiredError extends AppError {
  constructor() {
    super(
      'CLAIM_EXPIRED',
      'Your previous claim expired. This local count has not been submitted.',
      409,
    );
  }
}

export class ItemAlreadySubmittedError extends AppError {
  constructor() {
    super('ITEM_ALREADY_SUBMITTED', 'This item has already been submitted.', 409);
  }
}

export class RecheckReadOnlyError extends AppError {
  constructor(status: string) {
    super(
      'RECHECK_READ_ONLY',
      status === 'cancelled'
        ? 'This Stock Recheck was cancelled and is read-only.'
        : 'This Stock Recheck is complete and is read-only.',
      409,
      { status },
    );
  }
}

/* ------------------------------------------------------------ zoho errors */

export class ZohoNotConfiguredError extends AppError {
  constructor() {
    super(
      'ZOHO_NOT_CONFIGURED',
      'Zoho is not connected. An administrator must connect Zoho before importing.',
      503,
    );
  }
}

export class ZohoAuthenticationError extends AppError {
  constructor() {
    super(
      'ZOHO_AUTHENTICATION_FAILED',
      'Zoho authentication must be repaired by an administrator.',
      502,
    );
  }
}

export class ZohoRateLimitedError extends AppError {
  constructor(retryAfterSeconds?: number) {
    super(
      'ZOHO_RATE_LIMITED',
      'Zoho temporarily limited API requests. Retry shortly.',
      502,
      retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
    );
  }
}

export class ZohoUnavailableError extends AppError {
  constructor(message = 'Zoho could not be reached. Retry shortly.') {
    super('ZOHO_UNAVAILABLE', message, 502);
  }
}

export class ZohoUnexpectedResponseError extends AppError {
  constructor(message = 'Zoho returned an unexpected response.') {
    super('ZOHO_UNEXPECTED_RESPONSE', message, 502);
  }
}

/**
 * Thrown by the Zoho client's own guard when a mutating HTTP method is
 * attempted against an Inventory resource endpoint — section 2.1.
 *
 * This is a programming-error tripwire: reaching it means a code change tried
 * to violate the read-only guarantee, so it must fail loudly rather than be
 * handled.
 */
export class ZohoReadOnlyViolationError extends AppError {
  constructor(method: string, url: string) {
    super(
      'ZOHO_READ_ONLY_VIOLATION',
      'Blocked a non-read request to Zoho Books. This application is read-only.',
      500,
      { method, url },
      false,
    );
  }
}

/* -------------------------------------------------- infrastructure errors */

export class DatabaseUnavailableError extends AppError {
  constructor(message = 'The database is not reachable right now. Try again shortly.') {
    super('DATABASE_UNAVAILABLE', message, 503);
  }
}

export class ExportFailedError extends AppError {
  constructor(message = 'The export could not be generated. Try again.') {
    super('EXPORT_FAILED', message, 500);
  }
}

/* -------------------------------------------------------------- utilities */

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Converts any thrown value into an AppError. Unknown failures collapse to a
 * generic 500 whose message never leaks internals to the client — the details
 * go to the server log alongside the correlation ID instead.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  const message = error instanceof Error ? error.message : String(error);
  return new AppError(
    'INTERNAL_ERROR',
    'Something went wrong on our side. Quote the correlation ID when reporting this.',
    500,
    { internalMessage: message },
    true,
  );
}
