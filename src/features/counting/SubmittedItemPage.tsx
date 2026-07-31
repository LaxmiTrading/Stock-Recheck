/**
 * Screen 10: submitted item result — specification section 24.
 */

import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { describeQuantityDifference, formatQuantity, formatSignedQuantity } from '@/domain/quantity';
import { formatDateTime } from '@/domain/recheckNumber';
import { ApiError, apiRequest } from '@/services/api';
import { Badge, Button, Card, ErrorState, LinkButton, Spinner } from '@/components/ui';

interface SubmittedResponse {
  item: {
    id: string;
    itemName: string;
    sku: string;
    zohoStock: number;
    countedQuantity: number | null;
    quantityDifference: number | null;
    resultStatus: 'pending' | 'matched' | 'mismatched';
    submittedByName: string | null;
    submittedAt: string | null;
    vendor: string | null;
    unit: string | null;
  };
  recheck: {
    recheckNumber: string;
    name: string;
    status: string;
    isReadOnly: boolean;
    stockBasisType: string;
    stockBasisName: string | null;
    zohoSnapshotAt: string;
  };
}

export default function SubmittedItemPage(): React.JSX.Element {
  const { recheckId = '', itemId = '' } = useParams();
  const navigate = useNavigate();

  const { data, isPending, error } = useQuery({
    queryKey: ['recheck', recheckId, 'item', itemId],
    queryFn: () => apiRequest<SubmittedResponse>(`/api/rechecks/${recheckId}/items/${itemId}`),
  });

  if (isPending) {
    return (
      <div className="flex justify-center py-16">
        <Spinner size={28} label="Loading result" />
      </div>
    );
  }

  if (error !== null || data === undefined) {
    return (
      <ErrorState
        message={error instanceof ApiError ? error.message : 'This result could not be loaded.'}
        correlationId={error instanceof ApiError ? error.correlationId : undefined}
        action={
          <LinkButton variant="primary" to={`/app/rechecks/${recheckId}/workspace`}>
            Back to Recheck
          </LinkButton>
        }
      />
    );
  }

  const { item, recheck } = data;
  const isMatched = item.resultStatus === 'matched';
  const difference = item.quantityDifference ?? 0;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{item.itemName}</h2>
            <p className="font-mono text-[var(--color-ink-muted)]">{item.sku}</p>
          </div>
          <Badge tone={isMatched ? 'success' : 'danger'}>
            {isMatched ? 'Matched' : 'Mismatched'}
          </Badge>
        </div>

        {/* Section 24: prose uses the absolute value; the numeric field keeps
            the sign. */}
        <p
          className={`rounded-lg px-3 py-3 text-sm font-medium ${
            isMatched
              ? 'bg-[var(--color-success-bg)] text-[var(--color-success)]'
              : 'bg-[var(--color-danger-bg)] text-[var(--color-danger)]'
          }`}
        >
          {describeQuantityDifference(difference)}
        </p>

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3">
            <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Zoho Stock</p>
            <p className="tabular text-2xl font-bold">{formatQuantity(item.zohoStock)}</p>
          </div>
          <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3">
            <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Counted</p>
            <p className="tabular text-2xl font-bold">{item.countedQuantity ?? '—'}</p>
          </div>
          <div className="rounded-lg bg-[var(--color-surface-sunken)] p-3">
            <p className="text-xs uppercase text-[var(--color-ink-subtle)]">Difference</p>
            <p
              className={`tabular text-2xl font-bold ${
                isMatched ? '' : 'text-[var(--color-danger)]'
              }`}
            >
              {formatSignedQuantity(difference)}
            </p>
          </div>
        </div>

        <dl className="grid gap-x-4 gap-y-2 border-t border-[var(--color-border)] pt-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Submitted by</dt>
            <dd>{item.submittedByName ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Submission time</dt>
            <dd>{formatDateTime(item.submittedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Stock basis</dt>
            <dd>{recheck.stockBasisName ?? recheck.stockBasisType}</dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--color-ink-subtle)]">Zoho stock read at</dt>
            <dd>{formatDateTime(recheck.zohoSnapshotAt)}</dd>
          </div>
        </dl>
      </Card>

      <div className="flex flex-wrap gap-2">
        {/*
          * Section 24: returns to the workspace filtered to available items and
          * never auto-claims anything.
          *
          * Hidden once the Stock Recheck is completed or cancelled — there is
          * no next item to count, and offering the action would send the
          * operator to a workspace where every control is disabled.
          */}
        {!recheck.isReadOnly && (
          <Button
            variant="primary"
            size="lg"
            onClick={() =>
              navigate(`/app/rechecks/${recheckId}/workspace?status=available`)
            }
          >
            Count Next Item
          </Button>
        )}
        <LinkButton to={`/app/rechecks/${recheckId}/summary`}>View Summary</LinkButton>
        <LinkButton to={`/app/rechecks/${recheckId}/workspace`}>Back to Recheck</LinkButton>
      </div>
    </div>
  );
}
