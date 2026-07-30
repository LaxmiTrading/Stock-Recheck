/**
 * Zoho OAuth token management — specification section 32.
 *
 * The refresh token lives in an environment variable and NEVER leaves the
 * server. Access tokens are cached in module scope (warm-instance memory) and
 * refreshed slightly before expiry. A refresh lock prevents a stampede when
 * several validation workers hit a 401 at the same moment.
 */

import { ZohoAuthenticationError, ZohoNotConfiguredError } from '../errors';
import { logInfo } from '../http';
import { postToAccountsEndpoint } from './client';

/**
 * Read-only scopes only — section 32 ("Never request full-access scopes").
 *
 * Books puts items under the settings scope; there is no separate
 * `ZohoBooks.items.READ`. This one scope covers items, organizations and
 * locations, which is the entire read surface this application uses.
 *
 * A `ZohoInventory.*` token cannot serve these endpoints: Zoho rejects the
 * cross-product call with HTTP 401 code 57 rather than a scope error.
 */
export const REQUIRED_SCOPES = ['ZohoBooks.settings.READ'] as const;

export function scopeString(): string {
  return REQUIRED_SCOPES.join(',');
}

export interface ZohoCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountsDomain: string;
  apiDomain: string;
  organizationId: string;
}

/** Data-centre → default API domain. Never hardcode the US domain (section 32). */
const API_DOMAIN_BY_ACCOUNTS_HOST: Record<string, string> = {
  'accounts.zoho.in': 'https://www.zohoapis.in',
  'accounts.zoho.com': 'https://www.zohoapis.com',
  'accounts.zoho.eu': 'https://www.zohoapis.eu',
  'accounts.zoho.com.au': 'https://www.zohoapis.com.au',
  'accounts.zoho.jp': 'https://www.zohoapis.jp',
  'accounts.zohocloud.ca': 'https://www.zohoapis.ca',
  'accounts.zoho.sa': 'https://www.zohoapis.sa',
};

export function inferApiDomain(accountsDomain: string): string {
  try {
    const host = new URL(accountsDomain).hostname.toLowerCase();
    return API_DOMAIN_BY_ACCOUNTS_HOST[host] ?? 'https://www.zohoapis.in';
  } catch {
    return 'https://www.zohoapis.in';
  }
}

export function inferDataCenter(accountsDomain: string): string {
  try {
    const host = new URL(accountsDomain).hostname.toLowerCase();
    if (host.endsWith('.in')) return 'IN';
    if (host.endsWith('.eu')) return 'EU';
    if (host.endsWith('.com.au')) return 'AU';
    if (host.endsWith('.jp')) return 'JP';
    if (host.endsWith('.ca')) return 'CA';
    if (host.endsWith('.sa')) return 'SA';
    return 'US';
  } catch {
    return 'IN';
  }
}

/** Reads credentials from the environment, or null when not configured. */
export function readCredentials(): ZohoCredentials | null {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  const organizationId = process.env.ZOHO_ORGANIZATION_ID;

  if (!clientId || !clientSecret || !refreshToken || !organizationId) return null;

  const accountsDomain = process.env.ZOHO_ACCOUNTS_DOMAIN ?? 'https://accounts.zoho.in';
  const apiDomain = process.env.ZOHO_API_DOMAIN || inferApiDomain(accountsDomain);

  return { clientId, clientSecret, refreshToken, accountsDomain, apiDomain, organizationId };
}

export function requireCredentials(): ZohoCredentials {
  const credentials = readCredentials();
  if (credentials === null) throw new ZohoNotConfiguredError();
  return credentials;
}

export function isZohoConfigured(): boolean {
  return readCredentials() !== null;
}

/**
 * Resolves credentials from the environment, falling back to the refresh token
 * captured by the in-app OAuth flow and stored encrypted (migration 0002).
 *
 * ZOHO_REFRESH_TOKEN always wins when present — section 30.3 prefers the
 * environment variable.
 */
export async function resolveCredentials(): Promise<ZohoCredentials | null> {
  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const fromEnvironment = readCredentials();
  if (fromEnvironment !== null) return fromEnvironment;

  const stored = await loadStoredConnection();
  if (stored === null || stored.refreshToken === null) return null;

  const organizationId = process.env.ZOHO_ORGANIZATION_ID ?? stored.organizationId;
  if (organizationId === null) return null;

  const accountsDomain =
    process.env.ZOHO_ACCOUNTS_DOMAIN ?? stored.accountsDomain ?? 'https://accounts.zoho.in';

  return {
    clientId,
    clientSecret,
    refreshToken: stored.refreshToken,
    accountsDomain,
    apiDomain: process.env.ZOHO_API_DOMAIN || stored.apiDomain || inferApiDomain(accountsDomain),
    organizationId,
  };
}

export async function requireResolvedCredentials(): Promise<ZohoCredentials> {
  const credentials = await resolveCredentials();
  if (credentials === null) throw new ZohoNotConfiguredError();
  return credentials;
}

interface StoredConnection {
  refreshToken: string | null;
  organizationId: string | null;
  accountsDomain: string | null;
  apiDomain: string | null;
}

/** Reads and decrypts the stored connection. Server-only. */
async function loadStoredConnection(): Promise<StoredConnection | null> {
  // Imported lazily so modules that only need the pure helpers (and the unit
  // tests) do not pull in the database driver.
  const [{ queryOne }, { decryptSecret }] = await Promise.all([
    import('../database/client'),
    import('../crypto'),
  ]);

  const row = await queryOne<{
    refresh_token_encrypted: string | null;
    organization_id: string | null;
    accounts_domain: string | null;
    api_domain: string | null;
  }>(
    `SELECT refresh_token_encrypted, organization_id, accounts_domain, api_domain
       FROM zoho_connections WHERE singleton LIMIT 1`,
  );

  if (row === null) return null;

  return {
    refreshToken:
      row.refresh_token_encrypted === null ? null : decryptSecret(row.refresh_token_encrypted),
    organizationId: row.organization_id,
    accountsDomain: row.accounts_domain,
    apiDomain: row.api_domain,
  };
}

/** Persists the refresh token from the OAuth callback, encrypted at rest. */
export async function storeRefreshToken(params: {
  refreshToken: string;
  organizationId: string | null;
  accountsDomain: string;
  apiDomain: string;
}): Promise<void> {
  const [{ query }, { encryptSecret }] = await Promise.all([
    import('../database/client'),
    import('../crypto'),
  ]);

  await query(
    `UPDATE zoho_connections
        SET refresh_token_encrypted = $1,
            refresh_token_updated_at = NOW(),
            organization_id = COALESCE($2, organization_id),
            accounts_domain = $3,
            api_domain = $4
      WHERE singleton`,
    [
      encryptSecret(params.refreshToken),
      params.organizationId,
      params.accountsDomain,
      params.apiDomain,
    ],
  );
}

/** Clears the stored token on disconnect. */
export async function clearStoredRefreshToken(): Promise<void> {
  const { query } = await import('../database/client');
  await query(
    `UPDATE zoho_connections
        SET refresh_token_encrypted = NULL, refresh_token_updated_at = NULL
      WHERE singleton`,
  );
}

/** True when Zoho can be reached, counting the stored token as configured. */
export async function isZohoUsable(): Promise<boolean> {
  return (await resolveCredentials()) !== null;
}

/* ------------------------------------------------------------ token cache */

interface CachedToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  apiDomain: string;
}

let cachedToken: CachedToken | null = null;
/** In-flight refresh, shared by all concurrent callers (the "lock"). */
let refreshInFlight: Promise<CachedToken> | null = null;

/** Refresh this many ms before the real expiry — section 32. */
const EXPIRY_SAFETY_MARGIN_MS = 120_000;

interface RefreshResponse {
  access_token?: string;
  expires_in?: number;
  api_domain?: string;
  error?: string;
}

async function refreshAccessToken(
  credentials: ZohoCredentials,
  correlationId: string,
): Promise<CachedToken> {
  logInfo('zoho.token_refresh', { correlationId });

  const body = await postToAccountsEndpoint<RefreshResponse>({
    accountsDomain: credentials.accountsDomain,
    path: '/oauth/v2/token',
    correlationId,
    form: {
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: 'refresh_token',
    },
  });

  if (body.error !== undefined || typeof body.access_token !== 'string') {
    // Never log the error body itself — it can echo credentials.
    logInfo('zoho.token_refresh_failed', { correlationId, reason: body.error ?? 'no_token' });
    throw new ZohoAuthenticationError();
  }

  const lifetimeSeconds = typeof body.expires_in === 'number' ? body.expires_in : 3600;

  return {
    accessToken: body.access_token,
    // Respect Zoho's stated expiry, refreshing slightly early.
    expiresAt: Date.now() + lifetimeSeconds * 1000 - EXPIRY_SAFETY_MARGIN_MS,
    // Prefer the domain Zoho reports over anything we guessed.
    apiDomain: body.api_domain ?? credentials.apiDomain,
  };
}

/**
 * Returns a valid access token, refreshing when needed.
 *
 * Concurrent callers share one in-flight refresh, so N parallel validation
 * workers produce ONE token request rather than N (section 32, "Avoid
 * concurrent refresh storms by using a lock").
 */
export async function getAccessToken(
  correlationId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<{ accessToken: string; apiDomain: string }> {
  const credentials = await requireResolvedCredentials();

  if (
    options.forceRefresh !== true &&
    cachedToken !== null &&
    cachedToken.expiresAt > Date.now()
  ) {
    return { accessToken: cachedToken.accessToken, apiDomain: cachedToken.apiDomain };
  }

  if (refreshInFlight === null) {
    refreshInFlight = refreshAccessToken(credentials, correlationId)
      .then((token) => {
        cachedToken = token;
        return token;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }

  const token = await refreshInFlight;
  return { accessToken: token.accessToken, apiDomain: token.apiDomain };
}

/** Drops the cached token, e.g. after a 401 or on disconnect. */
export function invalidateAccessToken(): void {
  cachedToken = null;
}

/* --------------------------------------------------- authorization-code flow */

export function buildAuthorizationUrl(params: {
  clientId: string;
  accountsDomain: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL('/oauth/v2/auth', params.accountsDomain);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('scope', scopeString());
  url.searchParams.set('redirect_uri', params.redirectUri);
  // `offline` is required to receive a refresh token.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', params.state);
  return url.toString();
}

export interface TokenExchangeResult {
  refreshToken: string;
  accessToken: string;
  apiDomain: string;
  expiresIn: number;
}

/** Exchanges the authorization code for tokens (POST to Accounts — permitted). */
export async function exchangeAuthorizationCode(params: {
  code: string;
  clientId: string;
  clientSecret: string;
  accountsDomain: string;
  redirectUri: string;
}): Promise<TokenExchangeResult> {
  const body = await postToAccountsEndpoint<
    RefreshResponse & { refresh_token?: string }
  >({
    accountsDomain: params.accountsDomain,
    path: '/oauth/v2/token',
    form: {
      grant_type: 'authorization_code',
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
      code: params.code,
    },
  });

  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new ZohoAuthenticationError();
  }

  return {
    refreshToken: body.refresh_token,
    accessToken: body.access_token,
    apiDomain: body.api_domain ?? inferApiDomain(params.accountsDomain),
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
  };
}
