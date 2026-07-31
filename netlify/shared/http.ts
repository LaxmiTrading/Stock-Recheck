/**
 * HTTP envelope, routing helpers and the request wrapper — specification
 * sections 31, 34, 37.
 *
 * Every function response uses the same JSON envelope and carries a
 * correlation ID so a user-reported failure can be traced in the logs.
 */

import { randomUUID } from 'node:crypto';
import type { z, ZodType } from 'zod';
import { MethodNotAllowedError, toAppError, ValidationError, type AppError } from './errors';
import { corsHeaders, preflightResponse } from './cors';

export interface SuccessEnvelope<Data> {
  success: true;
  data: Data;
  correlationId: string;
}

export interface FailureEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
  correlationId: string;
}

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // API responses must never be cached by a shared cache.
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

export function newCorrelationId(): string {
  return randomUUID();
}

/** Reuses an inbound correlation ID when the client supplied one. */
export function resolveCorrelationId(request: Request): string {
  const inbound = request.headers.get('x-correlation-id');
  if (inbound !== null && /^[A-Za-z0-9._-]{8,128}$/.test(inbound)) return inbound;
  return newCorrelationId();
}

export function jsonSuccess<Data>(
  data: Data,
  correlationId: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const body: SuccessEnvelope<Data> = { success: true, data, correlationId };
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { ...JSON_HEADERS, 'x-correlation-id': correlationId, ...init.headers },
  });
}

export function jsonFailure(error: AppError, correlationId: string): Response {
  const body: FailureEnvelope = {
    success: false,
    error: {
      code: error.code,
      message: error.exposeMessage
        ? error.message
        : 'Something went wrong on our side. Quote the correlation ID when reporting this.',
      // `internalMessage` is a log-only field and must never reach the client.
      details: stripInternalDetails(error.details),
    },
    correlationId,
  };

  const headers: Record<string, string> = { ...JSON_HEADERS, 'x-correlation-id': correlationId };
  const retryAfter = error.details.retryAfterSeconds;
  if (typeof retryAfter === 'number') headers['retry-after'] = String(Math.ceil(retryAfter));

  return new Response(JSON.stringify(body), { status: error.statusCode, headers });
}

/**
 * Removes log-only fields so they can never reach the client.
 * `internalMessage` carries the original exception text, which may name
 * internal hosts, tables or query fragments.
 */
function stripInternalDetails(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === 'internalMessage') continue;
    safe[key] = value;
  }
  return safe;
}

/** Binary response used by the .xlsx endpoints. */
export function fileResponse(
  bytes: Uint8Array | ArrayBuffer,
  fileName: string,
  correlationId: string,
  contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
): Response {
  // RFC 5987 encoding so non-ASCII names survive.
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');

  /*
   * Wrap the bytes in a Blob before handing them to `Response`.
   *
   * `BodyInit` accepts a typed array at runtime, but the DOM and Node lib
   * definitions describe it differently, so passing the view (or its
   * `ArrayBufferLike` buffer, which may be a SharedArrayBuffer as far as the
   * type system knows) fails to compile in one project or the other. `Blob`
   * is accepted by both definitions with no cast, and the explicit headers
   * below still take precedence over the Blob's own type.
   */
  const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Copy into an array explicitly backed by a plain ArrayBuffer. TypeScript 5.7
  // made typed arrays generic over their buffer, so a `Uint8Array<ArrayBufferLike>`
  // is not assignable to `BlobPart` (its buffer could in principle be shared);
  // `new Uint8Array(length)` is always `Uint8Array<ArrayBuffer>`.
  const body = new Uint8Array(source.byteLength);
  body.set(source);

  return new Response(new Blob([body]), {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'cache-control': 'no-store, max-age=0',
      'x-correlation-id': correlationId,
      'x-content-type-options': 'nosniff',
    },
  });
}

/* ------------------------------------------------------------- body parsing */

/** 6 MB — Netlify's own request body ceiling for synchronous functions. */
export const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;

/**
 * Parses and validates a JSON request body against a Zod schema.
 * Section 31: "Validate every request on the server."
 */
export async function parseJsonBody<Schema extends ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ValidationError('Request body must be JSON.');
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError('Request body is not valid JSON.');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('The submitted data is not valid.', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

/** Validates query-string parameters against a schema. */
export function parseSearchParams<Schema extends ZodType>(
  request: Request,
  schema: Schema,
): z.infer<Schema> {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) raw[key] = value;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid query parameters.', {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

export function assertMethod(request: Request, allowed: readonly string[]): void {
  if (!allowed.includes(request.method)) {
    throw new MethodNotAllowedError(request.method);
  }
}

/* ------------------------------------------------------------- log helper */

export interface LogContext {
  correlationId: string;
  route?: string;
  method?: string;
  userId?: string;
  [key: string]: unknown;
}

/**
 * Production-safe structured logging (section 44).
 * Never pass tokens, passwords, secrets or full auth headers (section 29).
 */
export function logInfo(message: string, context: LogContext): void {
  console.log(JSON.stringify({ level: 'info', message, ...context }));
}

export function logError(message: string, context: LogContext & { error?: unknown }): void {
  const { error, ...rest } = context;
  console.error(
    JSON.stringify({
      level: 'error',
      message,
      ...rest,
      errorMessage: error instanceof Error ? error.message : error === undefined ? undefined : String(error),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined,
    }),
  );
}

/* --------------------------------------------------------- route handling */

export interface RouteContext {
  correlationId: string;
  params: Record<string, string | undefined>;
  requestIp: string | null;
}

export type RouteHandler = (request: Request, context: RouteContext) => Promise<Response>;

/**
 * Wraps a handler with correlation-ID assignment, uniform error mapping and
 * structured logging. Every exported Netlify function body goes through this.
 */
export function withErrorHandling(routeName: string, handler: RouteHandler) {
  return async (
    request: Request,
    netlifyContext: { params?: Record<string, string | undefined>; ip?: string },
  ): Promise<Response> => {
    const correlationId = resolveCorrelationId(request);
    const startedAt = Date.now();
    // Logged on every outcome: without the actual pathname a 404/405 in
    // production is untraceable, because the route name alone does not say
    // which URL failed to match.
    const pathname = (() => {
      try {
        return new URL(request.url).pathname;
      } catch {
        return request.url;
      }
    })();
    const requestIp =
      netlifyContext.ip ??
      request.headers.get('x-nf-client-connection-ip') ??
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      null;

    /*
     * Preflight is answered before the handler runs. A browser sends OPTIONS
     * with no cookie and no body, so routing it into a handler would only
     * produce a 401 or a 405 and fail the actual request that follows.
     * Returns null unless a cross-site frontend is configured.
     */
    const preflight = preflightResponse(request);
    if (preflight !== null) {
      logInfo('request.preflight', {
        correlationId,
        route: routeName,
        path: pathname,
        status: preflight.status,
      });
      return preflight;
    }

    /*
     * Applied to EVERY outcome below, including errors. A 401 or 500 without
     * these headers is unreadable to the browser, so the operator would see an
     * opaque network failure instead of the real message.
     */
    const withCors = (response: Response): Response => {
      const extra = corsHeaders(request);
      if (Object.keys(extra).length === 0) return response;
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(extra)) headers.set(key, value);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    };

    try {
      const response = withCors(
        await handler(request, {
          correlationId,
          params: netlifyContext.params ?? {},
          requestIp,
        }),
      );

      logInfo('request.completed', {
        correlationId,
        route: routeName,
        path: pathname,
        method: request.method,
        status: response.status,
        durationMs: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      const appError = toAppError(error);

      // 5xx are genuine faults worth a stack trace; 4xx are expected outcomes.
      if (appError.statusCode >= 500) {
        logError('request.failed', {
          correlationId,
          route: routeName,
          path: pathname,
          method: request.method,
          code: appError.code,
          status: appError.statusCode,
          durationMs: Date.now() - startedAt,
          error,
        });
      } else {
        logInfo('request.rejected', {
          correlationId,
          route: routeName,
          path: pathname,
          method: request.method,
          code: appError.code,
          status: appError.statusCode,
          durationMs: Date.now() - startedAt,
        });
      }

      // Errors need the CORS headers too, or the browser hides the message.
      return withCors(jsonFailure(appError, correlationId));
    }
  };
}

/**
 * Minimal path router used inside a function that serves several routes.
 * Patterns use `:param` segments and are matched against the URL pathname.
 */
export interface Route {
  method: string;
  pattern: string;
  handler: RouteHandler;
  /**
   * Optional per-parameter format constraints. When omitted, every `:param`
   * must be a UUID — see `PARAM_DEFAULT_PATTERN`.
   */
  constraints?: Record<string, RegExp>;
}

/**
 * Every path parameter in this API is a database UUID, so that is the default
 * constraint.
 *
 * Enforcing it in the ROUTER rather than the handler means a malformed
 * identifier is a clean 404 instead of reaching a repository and failing deep
 * in Postgres with "invalid input syntax for type uuid" (a 500 for what is
 * really a bad request). It also stops unrelated paths — `/api/admin/users/
 * index.html`, say — from matching a `:id` route and producing a misleading
 * 405.
 */
const PARAM_DEFAULT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function matchRoute(
  routes: readonly Route[],
  request: Request,
): { handler: RouteHandler; params: Record<string, string> } | null {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const segments = pathname.split('/').filter((segment) => segment.length > 0);

  let methodMismatch = false;

  for (const route of routes) {
    const patternSegments = route.pattern.split('/').filter((segment) => segment.length > 0);
    if (patternSegments.length !== segments.length) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let index = 0; index < patternSegments.length; index += 1) {
      const patternSegment = patternSegments[index] as string;
      const actualSegment = segments[index] as string;

      if (patternSegment.startsWith(':')) {
        const name = patternSegment.slice(1);
        const value = decodeURIComponent(actualSegment);
        const constraint = route.constraints?.[name] ?? PARAM_DEFAULT_PATTERN;
        if (!constraint.test(value)) {
          matched = false;
          break;
        }
        params[name] = value;
      } else if (patternSegment !== actualSegment) {
        matched = false;
        break;
      }
    }

    if (!matched) continue;
    if (route.method !== request.method) {
      methodMismatch = true;
      continue;
    }
    return { handler: route.handler, params };
  }

  if (methodMismatch) throw new MethodNotAllowedError(request.method);
  return null;
}
