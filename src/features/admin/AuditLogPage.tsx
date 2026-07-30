/**
 * Audit log — specification section 29. Administrator only.
 *
 * The server redacts metadata before persisting, so nothing shown here can
 * contain a token, password or client secret.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AUDIT_EVENT_LABEL, isAuditEventType, type AuditEventType } from '@/domain/audit';
import { formatDateTime } from '@/domain/recheckNumber';
import { PAGE_SIZE_OPTIONS } from '@/domain/settings';
import { ApiError, apiRequest } from '@/services/api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Pagination,
  Select,
  Spinner,
  TextInput,
} from '@/components/ui';
import { ScrollTextIcon } from '@/components/icons';

interface AuditEvent {
  id: string;
  eventType: string;
  actorUserId: string | null;
  actorDisplayName: string | null;
  recheckId: string | null;
  itemId: string | null;
  metadata: Record<string, unknown>;
  correlationId: string | null;
  createdAt: string;
}

interface AuditResponse {
  events: AuditEvent[];
  eventTypes: readonly string[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

/** Events that change access or destroy work are worth visually flagging. */
const HIGH_SIGNAL_EVENTS = new Set([
  'user.disabled',
  'user.role_changed',
  'zoho.disconnected',
  'recheck.cancelled',
  'item.claim_force_released',
  'item.reopened',
  'settings.stock_basis_changed',
]);

export default function AuditLogPage(): React.JSX.Element {
  const [eventType, setEventType] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => setPage(1), [eventType, fromDate, toDate, pageSize]);

  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['admin', 'audit', { eventType, fromDate, toDate, page, pageSize }],
    queryFn: () =>
      apiRequest<AuditResponse>('/api/admin/audit-events', {
        searchParams: {
          eventType: eventType || undefined,
          fromDate: fromDate === '' ? undefined : `${fromDate}T00:00:00Z`,
          toDate: toDate === '' ? undefined : `${toDate}T23:59:59Z`,
          page,
          pageSize,
        },
      }),
    placeholderData: (previous) => previous,
  });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold">Audit Log</h2>
        <p className="text-sm text-[var(--color-ink-muted)]">
          Significant server-side events. Tokens, passwords and secrets are never recorded.
        </p>
      </div>

      <Card className="grid gap-3 md:grid-cols-3">
        <Field label="Event type">
          {({ inputId }) => (
            <Select
              id={inputId}
              value={eventType}
              onChange={(event) => setEventType(event.target.value)}
            >
              <option value="">All events</option>
              {(data?.eventTypes ?? []).map((type) => (
                <option key={type} value={type}>
                  {isAuditEventType(type) ? AUDIT_EVENT_LABEL[type as AuditEventType] : type}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="From date">
          {({ inputId }) => (
            <TextInput
              id={inputId}
              type="date"
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
            />
          )}
        </Field>
        <Field label="To date">
          {({ inputId }) => (
            <TextInput
              id={inputId}
              type="date"
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
            />
          )}
        </Field>
      </Card>

      {isPending ? (
        <div className="flex justify-center py-12">
          <Spinner size={28} label="Loading audit events" />
        </div>
      ) : error !== null ? (
        <ErrorState
          message={error instanceof ApiError ? error.message : 'The audit log could not be loaded.'}
          correlationId={error instanceof ApiError ? error.correlationId : undefined}
          action={
            <Button variant="primary" onClick={() => void refetch()}>
              Try again
            </Button>
          }
        />
      ) : data.events.length === 0 ? (
        <EmptyState
          icon={<ScrollTextIcon size={22} />}
          title="No audit events"
          message="No events match these filters. Widen the date range to see more."
        />
      ) : (
        <>
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-[var(--color-surface-raised)] text-xs uppercase text-[var(--color-ink-subtle)]">
                <tr>
                  <th scope="col" className="px-3 py-2">Time</th>
                  <th scope="col" className="px-3 py-2">Event</th>
                  <th scope="col" className="px-3 py-2">Actor</th>
                  <th scope="col" className="px-3 py-2">Correlation ID</th>
                  <th scope="col" className="px-3 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event) => {
                  const label = isAuditEventType(event.eventType)
                    ? AUDIT_EVENT_LABEL[event.eventType as AuditEventType]
                    : event.eventType;
                  const isOpen = expanded === event.id;

                  return (
                    <tr key={event.id} className="border-t border-[var(--color-border)] align-top">
                      <td className="whitespace-nowrap px-3 py-2 text-xs">
                        {formatDateTime(event.createdAt)}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={HIGH_SIGNAL_EVENTS.has(event.eventType) ? 'warning' : 'neutral'}>
                          {label}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">{event.actorDisplayName ?? 'System'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-[var(--color-ink-subtle)]">
                        {event.correlationId?.slice(0, 8) ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        {Object.keys(event.metadata).length === 0 ? (
                          <span className="text-xs text-[var(--color-ink-subtle)]">—</span>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              onClick={() => setExpanded(isOpen ? null : event.id)}
                              aria-expanded={isOpen}
                            >
                              {isOpen ? 'Hide' : 'Show'}
                            </Button>
                            {isOpen && (
                              <pre className="mt-2 max-w-md overflow-x-auto rounded bg-[var(--color-surface-sunken)] p-2 text-xs">
                                {JSON.stringify(event.metadata, null, 2)}
                              </pre>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          <Pagination
            page={data.pagination.page}
            pageSize={data.pagination.pageSize}
            total={data.pagination.total}
            totalPages={data.pagination.totalPages}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            pageSizeOptions={PAGE_SIZE_OPTIONS}
          />
        </>
      )}
    </div>
  );
}
