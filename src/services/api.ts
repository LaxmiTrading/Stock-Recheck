/**
 * API client — specification sections 31, 37.
 *
 * Every response uses the documented envelope. Failures become a typed
 * `ApiError` carrying the stable code, the user-facing message and the
 * correlation ID, so error UI can be specific rather than generic.
 *
 * The session lives in an httpOnly cookie, so there is no token handling here
 * at all — the credentials mode is the whole authentication story.
 *
 * `VITE_API_BASE_URL` lets the UI be served from a different origin than the
 * API (GitHub Pages in front of a separately hosted backend). Left unset — the
 * normal single-origin deployment — every request stays relative and same-origin,
 * which is both simpler and safer.
 */

/**
 * Absolute origin of the API, or '' when it is served from this same origin.
 *
 * Baked in at BUILD time by Vite, not read at runtime: `import.meta.env` is
 * statically replaced, so the deployed bundle must be built with the value it
 * will use. A wrong value here fails every request, so it is normalised
 * (trailing slashes stripped) rather than concatenated blindly.
 */
const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

/**
 * Cross-origin requests need `include`; same-origin keeps the tighter
 * `same-origin`. `include` also requires the server to send
 * `Access-Control-Allow-Credentials: true` and a specific allow-origin.
 */
const CREDENTIALS_MODE: RequestCredentials = API_BASE_URL === '' ? 'same-origin' : 'include';

export interface SuccessEnvelope<Data> {
  success: true;
  data: Data;
  correlationId: string;
}

export interface FailureEnvelope {
  success: false;
  error: { code: string; message: string; details: Record<string, unknown> };
  correlationId: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly correlationId: string;

  constructor(params: {
    code: string;
    message: string;
    status: number;
    details?: Record<string, unknown>;
    correlationId: string;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.code = params.code;
    this.status = params.status;
    this.details = params.details ?? {};
    this.correlationId = params.correlationId;
  }

  /** True when re-running the same request could plausibly succeed. */
  get isRetryable(): boolean {
    return (
      this.status >= 500 ||
      this.code === 'ZOHO_RATE_LIMITED' ||
      this.code === 'ZOHO_UNAVAILABLE' ||
      this.code === 'DATABASE_UNAVAILABLE'
    );
  }

  get isAuthError(): boolean {
    return this.code === 'UNAUTHENTICATED' || this.code === 'SESSION_EXPIRED';
  }
}

/** Raised when the network itself failed — distinct from a server error. */
export class NetworkError extends Error {
  constructor(message = 'Could not reach the server. Check your connection and try again.') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  searchParams?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

function buildUrl(path: string, searchParams?: RequestOptions['searchParams']): string {
  const target = `${API_BASE_URL}${path}`;
  if (searchParams === undefined) return target;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? target : `${target}?${query}`;
}

/**
 * Notified whenever the server reports an expired session, so the shell can
 * route to the login screen while preserving any local count (section 38).
 */
type SessionExpiredListener = () => void;
const sessionExpiredListeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export async function apiRequest<Data>(
  path: string,
  options: RequestOptions = {},
): Promise<Data> {
  const method = options.method ?? 'GET';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.searchParams), {
      method,
      headers:
        options.body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: CREDENTIALS_MODE,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NetworkError();
  }

  let payload: SuccessEnvelope<Data> | FailureEnvelope;
  try {
    payload = (await response.json()) as SuccessEnvelope<Data> | FailureEnvelope;
  } catch {
    throw new ApiError({
      code: 'INTERNAL_ERROR',
      message: 'The server returned an unreadable response.',
      status: response.status,
      correlationId: response.headers.get('x-correlation-id') ?? 'unknown',
    });
  }

  if (payload.success) return payload.data;

  const apiError = new ApiError({
    code: payload.error.code,
    message: payload.error.message,
    status: response.status,
    details: payload.error.details,
    correlationId: payload.correlationId,
  });

  if (apiError.isAuthError) {
    for (const listener of sessionExpiredListeners) listener();
  }

  throw apiError;
}

/**
 * Downloads a binary response (the .xlsx endpoints) and triggers a save.
 * Errors still arrive as the JSON envelope, so they are decoded and rethrown.
 */
export async function apiDownload(
  path: string,
  searchParams?: RequestOptions['searchParams'],
): Promise<{ fileName: string }> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, searchParams), {
      method: 'GET',
      credentials: CREDENTIALS_MODE,
    });
  } catch {
    throw new NetworkError();
  }

  if (!response.ok) {
    const failure = (await response.json().catch(() => null)) as FailureEnvelope | null;
    throw new ApiError({
      code: failure?.error.code ?? 'EXPORT_FAILED',
      message: failure?.error.message ?? 'The export could not be generated.',
      status: response.status,
      correlationId: failure?.correlationId ?? 'unknown',
    });
  }

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename\*=UTF-8''([^;]+)|filename="([^"]+)"/.exec(disposition);
  const fileName = decodeURIComponent(match?.[1] ?? match?.[2] ?? 'download.xlsx');

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on the next tick so the download has definitely started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { fileName };
}

/** Stable idempotency keys for create/submit operations (sections 18, 23). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
