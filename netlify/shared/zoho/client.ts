/**
 * Zoho Books HTTP client — specification sections 2.1 and 32.
 *
 * ======================= READ-ONLY GUARANTEE (section 2.1) =================
 * Zoho Books resource endpoints are accessed with GET ONLY.
 *
 * Enforcement is structural, not conventional:
 *   1. `zohoGet` is the ONLY exported request function. There is no post/put/
 *      patch/delete counterpart to call by mistake.
 *   2. `performResourceRequest` asserts `method === 'GET'` before dispatch and
 *      throws `ZohoReadOnlyViolationError` otherwise.
 *   3. Token exchange/refresh POSTs go to the Zoho ACCOUNTS domain through a
 *      separate function (`postToAccountsEndpoint`) that refuses any URL not
 *      on the configured accounts host. Those are authentication calls, not
 *      resource mutations, and section 2.1 explicitly permits them.
 *
 * `tests/unit/zohoReadOnly.test.ts` and `scripts/verify-readonly.ts` assert
 * that no mutating method can reach a Books URL.
 * ==========================================================================
 */

import {
  ZohoAuthenticationError,
  ZohoRateLimitedError,
  ZohoReadOnlyViolationError,
  ZohoUnavailableError,
  ZohoUnexpectedResponseError,
} from '../errors';
import { logInfo } from '../http';

/** Only GET may reach a Books resource endpoint. */
const ALLOWED_RESOURCE_METHOD = 'GET' as const;

/**
 * Every Zoho Accounts host, by data centre. Token exchange and refresh may
 * POST to these and nowhere else (section 2.1). Exact-match only.
 */
const ZOHO_ACCOUNTS_HOSTS: ReadonlySet<string> = new Set([
  'accounts.zoho.in',
  'accounts.zoho.com',
  'accounts.zoho.eu',
  'accounts.zoho.com.au',
  'accounts.zoho.jp',
  'accounts.zoho.sa',
  'accounts.zoho.com.cn',
  'accounts.zohocloud.ca',
]);

export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RETRIES = 3;

export interface ZohoRequestOptions {
  /** Path relative to the API domain, e.g. `/books/v3/items`. */
  path: string;
  searchParams?: Record<string, string | number | undefined>;
  accessToken: string;
  apiDomain: string;
  organizationId: string;
  timeoutMs?: number;
  correlationId: string;
  /** Attempt counter used by the retry logic. */
  attempt?: number;
}

export interface ZohoResponse<Body> {
  body: Body;
  status: number;
  durationMs: number;
}

/** Sleep with jitter for backoff — section 32. */
function backoffDelayMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined) return Math.min(retryAfterSeconds * 1000, 30_000);
  const base = Math.min(1000 * 2 ** attempt, 8000);
  // Full jitter avoids a synchronized retry storm across concurrent rows.
  return Math.floor(Math.random() * base);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/**
 * The single choke point for every Zoho Books request.
 *
 * The method parameter exists solely so the guard has something to assert on;
 * callers cannot supply it.
 */
async function performResourceRequest<Body>(
  method: string,
  options: ZohoRequestOptions,
): Promise<ZohoResponse<Body>> {
  // ---- READ-ONLY TRIPWIRE (section 2.1) --------------------------------
  if (method !== ALLOWED_RESOURCE_METHOD) {
    throw new ZohoReadOnlyViolationError(method, options.path);
  }

  const url = new URL(options.path, options.apiDomain);
  url.searchParams.set('organization_id', options.organizationId);
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  // Second tripwire: never allow a resource call to target the accounts host.
  if (/accounts\.zoho\./i.test(url.hostname)) {
    throw new ZohoReadOnlyViolationError(method, url.toString());
  }

  const attempt = options.attempt ?? 0;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: ALLOWED_RESOURCE_METHOD,
      headers: {
        Authorization: `Zoho-oauthtoken ${options.accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (error) {
    clearTimeout(timeout);
    const isAbort = error instanceof Error && error.name === 'AbortError';

    // Section 32: retry safe GETs with bounded backoff.
    if (attempt < MAX_RETRIES) {
      await sleep(backoffDelayMs(attempt));
      return performResourceRequest<Body>(method, { ...options, attempt: attempt + 1 });
    }
    throw new ZohoUnavailableError(
      isAbort ? 'Zoho did not respond in time. Retry shortly.' : 'Zoho could not be reached.',
    );
  } finally {
    clearTimeout(timeout);
  }

  const durationMs = Date.now() - startedAt;

  if (response.status === 401) {
    // The caller refreshes once and retries once (section 32).
    throw new ZohoAuthenticationError();
  }

  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfter(response);
    if (attempt < MAX_RETRIES) {
      logInfo('zoho.rate_limited_retry', {
        correlationId: options.correlationId,
        attempt,
        retryAfterSeconds,
      });
      await sleep(backoffDelayMs(attempt, retryAfterSeconds));
      return performResourceRequest<Body>(method, { ...options, attempt: attempt + 1 });
    }
    throw new ZohoRateLimitedError(retryAfterSeconds);
  }

  if (response.status >= 500) {
    if (attempt < MAX_RETRIES) {
      await sleep(backoffDelayMs(attempt));
      return performResourceRequest<Body>(method, { ...options, attempt: attempt + 1 });
    }
    throw new ZohoUnavailableError('Zoho reported a server error. Retry shortly.');
  }

  let body: Body;
  try {
    body = (await response.json()) as Body;
  } catch {
    throw new ZohoUnexpectedResponseError('Zoho returned a response that was not valid JSON.');
  }

  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'message' in body
        ? String((body as { message: unknown }).message)
        : `Zoho returned HTTP ${response.status}.`;
    throw new ZohoUnexpectedResponseError(message);
  }

  return { body, status: response.status, durationMs };
}

/**
 * The ONLY way application code talks to Zoho Books.
 * There is deliberately no mutating counterpart in this module.
 */
export async function zohoGet<Body>(options: ZohoRequestOptions): Promise<ZohoResponse<Body>> {
  return performResourceRequest<Body>(ALLOWED_RESOURCE_METHOD, options);
}

/**
 * POSTs to the Zoho ACCOUNTS host for OAuth token exchange and refresh.
 *
 * Section 2.1: "OAuth token exchange and token refresh may use POST against
 * the Zoho Accounts authentication endpoint. These authentication requests are
 * not inventory updates."
 *
 * The host allow-list makes it impossible to point this at an Inventory API.
 */
export async function postToAccountsEndpoint<Body>(params: {
  accountsDomain: string;
  path: string;
  form: Record<string, string>;
  timeoutMs?: number;
  /** Threaded through so a failed token call is traceable to its request. */
  correlationId?: string;
}): Promise<Body> {
  const url = new URL(params.path, params.accountsDomain);

  // Hard allow-list of EXACT hostnames.
  //
  // A pattern such as /^accounts\.zoho\.[a-z.]+$/ is NOT safe here: the
  // character class admits dots, so `accounts.zoho.in.attacker.example.com`
  // would match and the client secret would be posted to the attacker.
  // Exact membership is the only correct test.
  if (!ZOHO_ACCOUNTS_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ZohoReadOnlyViolationError(
      'POST',
      `${url.hostname} is not a recognized Zoho Accounts host; token requests are restricted to the known accounts domains.`,
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    params.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params.form).toString(),
      signal: controller.signal,
    });

    let body: Body;
    try {
      body = (await response.json()) as Body;
    } catch {
      throw new ZohoUnexpectedResponseError('Zoho Accounts returned a non-JSON response.');
    }

    if (!response.ok) {
      /*
       * Log WHY before throwing.
       *
       * `ZohoAuthenticationError` carries a fixed operator-facing message, so
       * without this the only record of a failed token call was "Zoho
       * authentication must be repaired" — true, but it never says whether the
       * client secret is wrong, the refresh token was revoked, or the data
       * centre is mismatched. The caller's own `token_refresh_failed` log only
       * runs when Zoho answers 200 with an error body, which it does NOT do for
       * every failure mode.
       *
       * Only the short error enum (`invalid_client`, `invalid_code`, …) and the
       * status are recorded. The rest of the body is never logged: it can echo
       * the credentials that were just posted (section 29).
       */
      const errorCode = (body as { error?: unknown }).error;
      logInfo('zoho.accounts_request_failed', {
        correlationId: params.correlationId ?? 'zoho-accounts',
        path: params.path,
        status: response.status,
        reason: typeof errorCode === 'string' ? errorCode : 'unspecified',
      });
      throw new ZohoAuthenticationError();
    }
    return body;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ZohoUnavailableError('Zoho Accounts did not respond in time.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Runs tasks with bounded concurrency — section 32 ("Limit concurrent Zoho
 * requests") and section 40 ("Controlled Zoho concurrency").
 */
export async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  concurrency: number,
  worker: (item: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as Input, index);
    }
  });

  await Promise.all(runners);
  return results;
}
