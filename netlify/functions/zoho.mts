/**
 * Zoho integration endpoints — specification sections 8.4, 28.2, 32.
 *
 *   GET  /api/zoho/status          connection-health payload
 *   GET  /api/zoho/connect         start the OAuth flow (administrator)
 *   GET  /api/zoho/callback        OAuth redirect target
 *   POST /api/zoho/test            safe read request
 *   POST /api/zoho/disconnect      clear the stored connection
 *   GET  /api/zoho/organizations   organization discovery
 *   GET  /api/zoho/locations       location / warehouse discovery
 *
 * SECRETS NEVER LEAVE THE SERVER. No response from this module contains a
 * client secret, refresh token or access token (sections 28.2, 34).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config, Context } from '@netlify/functions';
import { disconnectZohoRequestSchema } from '../../src/schemas/api';
import { recordAuditEvent } from '../shared/audit';
import { requireActorWith, requireUser } from '../shared/auth/session';
import { query, queryOne } from '../shared/database/client';
import { AppError, ForbiddenError, ValidationError } from '../shared/errors';
import {
  jsonSuccess,
  matchRoute,
  parseJsonBody,
  withErrorHandling,
  type Route,
  type RouteContext,
} from '../shared/http';
import { createBooksReader, isMockModeEnabled } from '../shared/zoho/books';
import {
  buildAuthorizationUrl,
  clearStoredRefreshToken,
  exchangeAuthorizationCode,
  inferDataCenter,
  invalidateAccessToken,
  isZohoUsable,
  resolveCredentials,
  scopeString,
  storeRefreshToken,
} from '../shared/zoho/tokens';

function appBaseUrl(): string {
  return process.env.APP_BASE_URL ?? 'http://localhost:8888';
}

function redirectUri(): string {
  return `${appBaseUrl().replace(/\/+$/, '')}/api/zoho/callback`;
}

/* ------------------------------------------------------------ OAuth state */

/**
 * Signed, time-limited `state` value — section 34 ("Safe OAuth state
 * verification"). Signing means we do not need server-side storage and the
 * value cannot be forged.
 */
function signState(nonce: string, issuedAt: number): string {
  const secret = process.env.AUTH_JWT_SECRET ?? '';
  const payload = `${nonce}.${issuedAt}`;
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyState(state: string): boolean {
  const parts = state.split('.');
  if (parts.length !== 3) return false;
  const [nonce, issuedAtRaw, signature] = parts as [string, string, string];

  const issuedAt = Number.parseInt(issuedAtRaw, 10);
  if (!Number.isFinite(issuedAt)) return false;
  // 10-minute window.
  if (Date.now() - issuedAt > 600_000) return false;

  const expected = signState(nonce, issuedAt).split('.')[2] as string;
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signature, 'utf8');
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

/* ----------------------------------------------------------------- status */

interface ConnectionRow {
  organization_id: string | null;
  organization_name: string | null;
  accounts_domain: string | null;
  api_domain: string | null;
  data_center: string | null;
  connection_status: string;
  scope_summary: string | null;
  connected_account: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_code: string | null;
}

async function loadConnection(): Promise<ConnectionRow | null> {
  return queryOne<ConnectionRow>(
    `SELECT organization_id, organization_name, accounts_domain, api_domain, data_center,
            connection_status, scope_summary, connected_account,
            last_success_at, last_failure_at, last_failure_code
       FROM zoho_connections WHERE singleton LIMIT 1`,
  );
}

/**
 * Health payload for the top-header indicator (section 8.4).
 * Available to any signed-in user, but integration DETAIL (organization id,
 * domains, scope) is administrator-only — section 4.5 forbids counters from
 * accessing sensitive integration information.
 */
const statusHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireUser(request);
  const connection = await loadConnection();
  const configured = (await isZohoUsable()) || isMockModeEnabled();

  let state: 'connected' | 'authentication_required' | 'configuration_incomplete' | 'unavailable';
  if (!configured) state = 'configuration_incomplete';
  else if (connection?.connection_status === 'unhealthy') state = 'authentication_required';
  else if (connection?.connection_status === 'disconnected') state = 'configuration_incomplete';
  else state = 'connected';

  const base = {
    state,
    mockMode: isMockModeEnabled(),
    organizationName: connection?.organization_name ?? null,
    lastSuccessAt: connection?.last_success_at ?? null,
  };

  if (actor.role !== 'administrator') {
    return jsonSuccess(base, context.correlationId);
  }

  const credentials = await resolveCredentials();
  return jsonSuccess(
    {
      ...base,
      // Administrator-only detail. Still no tokens or secrets of any kind.
      organizationId: connection?.organization_id ?? credentials?.organizationId ?? null,
      accountsDomain: connection?.accounts_domain ?? credentials?.accountsDomain ?? null,
      apiDomain: connection?.api_domain ?? credentials?.apiDomain ?? null,
      dataCenter:
        connection?.data_center ??
        (credentials === null ? null : inferDataCenter(credentials.accountsDomain)),
      connectedAccount: connection?.connected_account ?? null,
      scopeSummary: connection?.scope_summary ?? scopeString(),
      readOnlyScopes: true,
      lastFailureAt: connection?.last_failure_at ?? null,
      lastFailureCode: connection?.last_failure_code ?? null,
      // Booleans only — the values themselves are never disclosed (28.2).
      hasClientId: (process.env.ZOHO_CLIENT_ID ?? '') !== '',
      hasClientSecret: (process.env.ZOHO_CLIENT_SECRET ?? '') !== '',
      hasRefreshToken: credentials !== null,
      refreshTokenSource:
        (process.env.ZOHO_REFRESH_TOKEN ?? '') !== ''
          ? 'environment'
          : credentials === null
            ? null
            : 'oauth_flow',
    },
    context.correlationId,
  );
};

/* ---------------------------------------------------------------- connect */

const connectHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireActorWith(request, 'zoho:configure');

  const clientId = process.env.ZOHO_CLIENT_ID;
  if (clientId === undefined || clientId === '') {
    throw new ValidationError(
      'ZOHO_CLIENT_ID is not set. Add the Zoho client credentials to the environment before connecting.',
    );
  }

  const accountsDomain = process.env.ZOHO_ACCOUNTS_DOMAIN ?? 'https://accounts.zoho.in';
  const state = signState(randomBytes(16).toString('base64url'), Date.now());

  const authorizationUrl = buildAuthorizationUrl({
    clientId,
    accountsDomain,
    redirectUri: redirectUri(),
    state,
  });

  // The client opens this URL; we do not redirect here so the SPA keeps control.
  return jsonSuccess(
    { authorizationUrl, redirectUri: redirectUri(), scopes: scopeString() },
    context.correlationId,
  );
};

/* --------------------------------------------------------------- callback */

const callbackHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  const settingsUrl = `${appBaseUrl().replace(/\/+$/, '')}/app/admin/settings/zoho`;

  const redirectWith = (params: Record<string, string>): Response =>
    new Response(null, {
      status: 302,
      headers: {
        location: `${settingsUrl}?${new URLSearchParams(params).toString()}`,
        'cache-control': 'no-store',
      },
    });

  if (error !== null) return redirectWith({ zoho: 'error', reason: error });
  if (code === null || state === null) return redirectWith({ zoho: 'error', reason: 'missing_code' });
  if (!verifyState(state)) return redirectWith({ zoho: 'error', reason: 'invalid_state' });

  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const accountsDomain = process.env.ZOHO_ACCOUNTS_DOMAIN ?? 'https://accounts.zoho.in';

  if (clientId === undefined || clientSecret === undefined) {
    return redirectWith({ zoho: 'error', reason: 'client_not_configured' });
  }

  try {
    const tokens = await exchangeAuthorizationCode({
      code,
      clientId,
      clientSecret,
      accountsDomain,
      redirectUri: redirectUri(),
    });

    await query(
      `UPDATE zoho_connections
          SET accounts_domain = $1, api_domain = $2, data_center = $3,
              connection_status = 'connected', scope_summary = $4,
              connected_at = NOW(), last_success_at = NOW(),
              last_failure_at = NULL, last_failure_code = NULL
        WHERE singleton`,
      [accountsDomain, tokens.apiDomain, inferDataCenter(accountsDomain), scopeString()],
    );

    // The refresh token is persisted ENCRYPTED and server-side only. It is
    // never logged (section 29), never returned to the browser (section 32)
    // and never placed in a URL (section 34). Setting ZOHO_REFRESH_TOKEN in
    // the environment takes precedence over this stored copy (section 30.3).
    await storeRefreshToken({
      refreshToken: tokens.refreshToken,
      organizationId: process.env.ZOHO_ORGANIZATION_ID ?? null,
      accountsDomain,
      apiDomain: tokens.apiDomain,
    });

    invalidateAccessToken();

    await recordAuditEvent({
      eventType: 'zoho.connected',
      metadata: { apiDomain: tokens.apiDomain, dataCenter: inferDataCenter(accountsDomain) },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });

    return redirectWith({ zoho: 'connected' });
  } catch {
    await query(
      `UPDATE zoho_connections
          SET connection_status = 'unhealthy',
              last_failure_at = NOW(), last_failure_code = 'OAUTH_EXCHANGE_FAILED'
        WHERE singleton`,
    );
    await recordAuditEvent({
      eventType: 'zoho.connection_failed',
      metadata: { stage: 'authorization_code_exchange' },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });
    return redirectWith({ zoho: 'error', reason: 'exchange_failed' });
  }
};

/* ------------------------------------------------------------------- test */

const testHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireActorWith(request, 'zoho:configure');
  const startedAt = Date.now();

  try {
    const reader = await createBooksReader();
    const result = await reader.testConnection(context.correlationId);

    await query(
      `UPDATE zoho_connections
          SET connection_status = 'connected', organization_name = COALESCE($1, organization_name),
              organization_id = COALESCE($2, organization_id),
              last_success_at = NOW(), last_failure_at = NULL, last_failure_code = NULL
        WHERE singleton`,
      [result.organizationName, (await resolveCredentials())?.organizationId ?? null],
    );

    return jsonSuccess(
      {
        success: true,
        organizationName: result.organizationName,
        responseMs: result.responseMs,
        testedAt: new Date().toISOString(),
        mockMode: reader.isMock,
      },
      context.correlationId,
    );
  } catch (error) {
    const code = error instanceof AppError ? error.code : 'ZOHO_UNAVAILABLE';
    await query(
      `UPDATE zoho_connections
          SET connection_status = 'unhealthy', last_failure_at = NOW(), last_failure_code = $1
        WHERE singleton`,
      [code],
    );
    await recordAuditEvent({
      eventType: 'zoho.connection_failed',
      metadata: { code, durationMs: Date.now() - startedAt },
      correlationId: context.correlationId,
      requestIp: context.requestIp,
    });
    throw error;
  }
};

/* ------------------------------------------------------------- disconnect */

const disconnectHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  const actor = await requireActorWith(request, 'zoho:configure');
  await parseJsonBody(request, disconnectZohoRequestSchema);

  await query(
    `UPDATE zoho_connections
        SET connection_status = 'disconnected', organization_name = NULL,
            last_failure_at = NULL, last_failure_code = NULL
      WHERE singleton`,
  );
  await clearStoredRefreshToken();
  invalidateAccessToken();

  await recordAuditEvent({
    eventType: 'zoho.disconnected',
    actorUserId: actor.id,
    actorDisplayName: actor.displayName,
    correlationId: context.correlationId,
    requestIp: context.requestIp,
  });

  // Section 28.2: disconnecting must not delete historical Stock Rechecks.
  return jsonSuccess(
    {
      disconnected: true,
      historicalDataPreserved: true,
      note: 'Existing Stock Rechecks and their snapshots are unchanged. New imports are blocked until Zoho is reconnected.',
    },
    context.correlationId,
  );
};

/* --------------------------------------------------- discovery endpoints */

const organizationsHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireActorWith(request, 'zoho:configure');
  const reader = await createBooksReader();
  const organizations = await reader.listOrganizations(context.correlationId);

  return jsonSuccess(
    {
      organizations: organizations.map((organization) => ({
        id: organization.organization_id ?? '',
        name: organization.name ?? '',
        isDefault: organization.is_default_org ?? false,
        currencyCode: organization.currency_code ?? null,
        timeZone: organization.time_zone ?? null,
      })),
    },
    context.correlationId,
  );
};

const locationsHandler = async (request: Request, context: RouteContext): Promise<Response> => {
  await requireActorWith(request, 'zoho:configure');
  const reader = await createBooksReader();
  const { locations, warehouses } = await reader.listLocations(context.correlationId);

  return jsonSuccess(
    {
      locations: locations.map((location) => ({
        id: location.location_id ?? '',
        name: location.location_name ?? '',
        type: location.type ?? null,
        isActive: (location.status ?? 'active') === 'active',
        isPrimary: location.is_primary ?? false,
      })),
      warehouses: warehouses.map((warehouse) => ({
        id: warehouse.warehouse_id ?? '',
        name: warehouse.warehouse_name ?? '',
        type: 'warehouse',
        isActive: (warehouse.status ?? 'active') === 'active',
        isPrimary: warehouse.is_primary ?? false,
      })),
    },
    context.correlationId,
  );
};

/* ------------------------------------------------------------------ route */

const routes: Route[] = [
  { method: 'GET', pattern: '/api/zoho/status', handler: statusHandler },
  { method: 'GET', pattern: '/api/zoho/connect', handler: connectHandler },
  { method: 'GET', pattern: '/api/zoho/callback', handler: callbackHandler },
  { method: 'POST', pattern: '/api/zoho/test', handler: testHandler },
  { method: 'POST', pattern: '/api/zoho/disconnect', handler: disconnectHandler },
  { method: 'GET', pattern: '/api/zoho/organizations', handler: organizationsHandler },
  { method: 'GET', pattern: '/api/zoho/locations', handler: locationsHandler },
];

const handler = withErrorHandling('zoho', async (request, context) => {
  const match = matchRoute(routes, request);
  if (match === null) throw new ForbiddenError('Unknown Zoho endpoint.');
  return match.handler(request, { ...context, params: match.params });
});

export default async (request: Request, context: Context): Promise<Response> =>
  handler(request, { params: context.params, ip: context.ip });

export const config: Config = {
  path: [
    '/api/zoho/status',
    '/api/zoho/connect',
    '/api/zoho/callback',
    '/api/zoho/test',
    '/api/zoho/disconnect',
    '/api/zoho/organizations',
    '/api/zoho/locations',
  ],
};
