/**
 * Settings → Zoho Integration — specification section 28.2.
 *
 * This screen NEVER displays a client secret, refresh token or access token.
 * The server only sends booleans indicating whether each is configured.
 */

import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDateTime } from '@/domain/recheckNumber';
import { ApiError, apiRequest } from '@/services/api';
import {
  Badge,
  Button,
  Card,
  Dialog,
  ErrorState,
  Field,
  InlineNotice,
  Spinner,
  TextInput,
  useToast,
} from '@/components/ui';
import type { StatusTone } from '@/domain/status';

interface ZohoStatusResponse {
  state: 'connected' | 'authentication_required' | 'configuration_incomplete' | 'unavailable';
  mockMode: boolean;
  organizationName: string | null;
  organizationId: string | null;
  accountsDomain: string | null;
  apiDomain: string | null;
  dataCenter: string | null;
  connectedAccount: string | null;
  scopeSummary: string | null;
  readOnlyScopes: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  hasClientId: boolean;
  hasClientSecret: boolean;
  hasRefreshToken: boolean;
  refreshTokenSource: 'environment' | 'oauth_flow' | null;
}

const STATE_TONE: Record<ZohoStatusResponse['state'], StatusTone> = {
  connected: 'success',
  authentication_required: 'danger',
  configuration_incomplete: 'warning',
  unavailable: 'danger',
};

const STATE_LABEL: Record<ZohoStatusResponse['state'], string> = {
  connected: 'Connected',
  authentication_required: 'Authentication required',
  configuration_incomplete: 'Configuration incomplete',
  unavailable: 'Zoho unavailable',
};

export default function ZohoSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const oauthResult = searchParams.get('zoho');

  const statusQuery = useQuery({
    queryKey: ['zoho', 'status', 'admin'],
    queryFn: () => apiRequest<ZohoStatusResponse>('/api/zoho/status'),
  });

  const connectMutation = useMutation({
    mutationFn: () => apiRequest<{ authorizationUrl: string }>('/api/zoho/connect'),
    onSuccess: (result) => {
      // Full navigation: the OAuth consent screen must own the window.
      window.location.href = result.authorizationUrl;
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Could not start the Zoho connection',
        description: error instanceof ApiError ? error.message : 'Try again.',
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: () =>
      apiRequest<{ organizationName: string | null; responseMs: number; testedAt: string }>(
        '/api/zoho/test',
        { method: 'POST', body: {} },
      ),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ['zoho'] });
      toast.push({
        tone: 'success',
        title: 'Connection successful',
        description: `${result.organizationName ?? 'Organization'} responded in ${result.responseMs} ms.`,
      });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Connection test failed',
        description: error instanceof ApiError ? error.message : 'Zoho could not be reached.',
      });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      apiRequest('/api/zoho/disconnect', { method: 'POST', body: { confirmation: 'DISCONNECT' } }),
    onSuccess: async () => {
      setDisconnectOpen(false);
      setConfirmation('');
      await queryClient.invalidateQueries({ queryKey: ['zoho'] });
      toast.push({
        tone: 'muted',
        title: 'Zoho disconnected',
        description: 'Historical Stock Rechecks are unchanged. New imports are blocked.',
      });
    },
  });

  if (statusQuery.isPending) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size={28} label="Loading connection status" />
      </div>
    );
  }

  if (statusQuery.error !== null) {
    return (
      <ErrorState
        message={
          statusQuery.error instanceof ApiError
            ? statusQuery.error.message
            : 'The connection status could not be loaded.'
        }
      />
    );
  }

  const status = statusQuery.data;

  return (
    <div className="space-y-4">
      {oauthResult === 'connected' && (
        <InlineNotice tone="success">
          Zoho was connected successfully. Run a connection test to confirm read access.
        </InlineNotice>
      )}
      {oauthResult === 'error' && (
        <InlineNotice tone="danger">
          The Zoho connection could not be completed ({searchParams.get('reason') ?? 'unknown reason'}
          ). Check the client credentials and try again.
        </InlineNotice>
      )}

      {status.mockMode && (
        <InlineNotice tone="warning">
          Mock inventory mode is enabled. All item data is local fixture data and no Zoho request is
          made. Never enable this in production.
        </InlineNotice>
      )}

      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Badge tone={STATE_TONE[status.state]}>{STATE_LABEL[status.state]}</Badge>
            <span className="text-sm text-[var(--color-ink-muted)]">
              {status.organizationName ?? 'No organization resolved'}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              loading={testMutation.isPending}
              loadingText="Testing…"
              onClick={() => testMutation.mutate()}
            >
              Test Connection
            </Button>
            <Button
              variant="primary"
              loading={connectMutation.isPending}
              onClick={() => connectMutation.mutate()}
            >
              {status.hasRefreshToken ? 'Reconnect' : 'Connect Zoho'}
            </Button>
            <Button
              variant="danger"
              disabled={!status.hasRefreshToken}
              onClick={() => setDisconnectOpen(true)}
            >
              Disconnect
            </Button>
          </div>
        </div>

        <dl className="grid gap-x-6 gap-y-3 border-t border-[var(--color-border)] pt-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Organization ID</dt>
            <dd className="font-mono">{status.organizationId ?? 'Not configured'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Data centre</dt>
            <dd>{status.dataCenter ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Accounts server</dt>
            <dd className="break-all font-mono text-xs">{status.accountsDomain ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">API domain</dt>
            <dd className="break-all font-mono text-xs">{status.apiDomain ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Last successful call</dt>
            <dd>{formatDateTime(status.lastSuccessAt)}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Last failed call</dt>
            <dd>
              {formatDateTime(status.lastFailureAt)}
              {status.lastFailureCode !== null && (
                <span className="ml-1 text-xs text-[var(--color-danger)]">
                  ({status.lastFailureCode})
                </span>
              )}
            </dd>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <dt className="text-xs uppercase text-[var(--color-ink-subtle)]">Scopes</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-[var(--color-surface-sunken)] px-2 py-0.5 text-xs">
                {status.scopeSummary ?? '—'}
              </code>
              <Badge tone="success">Read-only</Badge>
            </dd>
          </div>
        </dl>
      </Card>

      {/* Section 28.2: booleans only. The values are never displayed. */}
      <Card className="space-y-2">
        <h3 className="text-sm font-semibold">Credential status</h3>
        <p className="text-xs text-[var(--color-ink-subtle)]">
          Values are never displayed here or sent to the browser.
        </p>
        <ul className="space-y-1 text-sm">
          <li className="flex items-center gap-2">
            <Badge tone={status.hasClientId ? 'success' : 'danger'}>
              {status.hasClientId ? 'Set' : 'Missing'}
            </Badge>
            ZOHO_CLIENT_ID
          </li>
          <li className="flex items-center gap-2">
            <Badge tone={status.hasClientSecret ? 'success' : 'danger'}>
              {status.hasClientSecret ? 'Set' : 'Missing'}
            </Badge>
            ZOHO_CLIENT_SECRET
          </li>
          <li className="flex items-center gap-2">
            <Badge tone={status.hasRefreshToken ? 'success' : 'warning'}>
              {status.hasRefreshToken ? 'Set' : 'Missing'}
            </Badge>
            Refresh token
            {status.refreshTokenSource !== null && (
              <span className="text-xs text-[var(--color-ink-subtle)]">
                (
                {status.refreshTokenSource === 'environment'
                  ? 'from ZOHO_REFRESH_TOKEN'
                  : 'captured by the in-app OAuth flow, stored encrypted'}
                )
              </span>
            )}
          </li>
        </ul>
      </Card>

      <InlineNotice tone="info">
        This integration requests read scopes only and issues GET requests exclusively against Zoho
        Inventory. No stock adjustment, document or item is ever created or modified.
      </InlineNotice>

      <Dialog
        open={disconnectOpen}
        tone="danger"
        title="Disconnect Zoho?"
        description="New imports will be blocked until Zoho is reconnected. Existing Stock Rechecks and their snapshots are NOT deleted."
        onClose={() => setDisconnectOpen(false)}
        footer={
          <>
            <Button onClick={() => setDisconnectOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={confirmation !== 'DISCONNECT'}
              loading={disconnectMutation.isPending}
              onClick={() => disconnectMutation.mutate()}
            >
              Disconnect Zoho
            </Button>
          </>
        }
      >
        <Field label="Type DISCONNECT to confirm" required>
          {({ inputId }) => (
            <TextInput
              id={inputId}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="DISCONNECT"
            />
          )}
        </Field>
      </Dialog>

      {oauthResult !== null && (
        <Button size="sm" onClick={() => setSearchParams({})}>
          Dismiss message
        </Button>
      )}
    </div>
  );
}
