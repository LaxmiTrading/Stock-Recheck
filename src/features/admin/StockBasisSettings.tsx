/**
 * Settings → Stock Basis — specification section 28.3.
 *
 * Changing the default affects only NEWLY created Stock Rechecks; existing
 * ones keep the basis stored on them.
 */

import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  isStockBasisComplete,
  STOCK_BASIS_TYPES,
  STOCK_BASIS_TYPE_LABEL,
  stockBasisValidationMessage,
  type StockBasisType,
} from '@/domain/stockBasis';
import type { AppSettings } from '@/domain/settings';
import { ApiError, apiRequest } from '@/services/api';
import {
  Badge,
  Button,
  Card,
  InlineNotice,
  Select,
  Spinner,
  useToast,
} from '@/components/ui';
import { useSettingsMutation, useSettingsQuery } from './useSettingsForm';

interface LocationOption {
  id: string;
  name: string;
  type: string | null;
  isActive: boolean;
  isPrimary: boolean;
}

export default function StockBasisSettings(): React.JSX.Element {
  const { data, isPending } = useSettingsQuery();
  const save = useSettingsMutation();
  const toast = useToast();
  const [form, setForm] = useState<Partial<AppSettings>>({});

  useEffect(() => {
    if (data !== undefined) setForm(data.settings);
  }, [data]);

  const locationsQuery = useQuery({
    queryKey: ['zoho', 'locations'],
    queryFn: () =>
      apiRequest<{ locations: LocationOption[]; warehouses: LocationOption[] }>(
        '/api/zoho/locations',
      ),
    retry: false,
  });

  const testMutation = useMutation({
    mutationFn: () => apiRequest<{ organizationName: string | null }>('/api/zoho/test', {
      method: 'POST',
      body: {},
    }),
    onSuccess: () => {
      toast.push({
        tone: 'success',
        title: 'Stock resolution reachable',
        description: 'Zoho responded to a read request with the current configuration.',
      });
    },
    onError: (error) => {
      toast.push({
        tone: 'danger',
        title: 'Test failed',
        description: error instanceof ApiError ? error.message : 'Zoho could not be reached.',
      });
    },
  });

  if (isPending || data === undefined) {
    return (
      <div className="flex justify-center py-12">
        <Spinner size={28} label="Loading settings" />
      </div>
    );
  }

  const basisType = form.defaultStockBasisType ?? 'organization';
  const basis = {
    type: basisType,
    locationId: form.defaultLocationId ?? null,
    locationName: form.defaultLocationName ?? null,
    warehouseId: form.defaultWarehouseId ?? null,
    warehouseName: form.defaultWarehouseName ?? null,
  };
  const issue = stockBasisValidationMessage(basis);

  const locations = locationsQuery.data?.locations ?? [];
  const warehouses = locationsQuery.data?.warehouses ?? [];

  const selectedOption =
    basisType === 'location'
      ? locations.find((option) => option.id === basis.locationId)
      : basisType === 'warehouse'
        ? warehouses.find((option) => option.id === basis.warehouseId)
        : undefined;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (issue !== null) return;
        save.mutate({
          defaultStockBasisType: basisType,
          defaultLocationId: basisType === 'location' ? basis.locationId : null,
          defaultLocationName: basisType === 'location' ? basis.locationName : null,
          defaultWarehouseId: basisType === 'warehouse' ? basis.warehouseId : null,
          defaultWarehouseName: basisType === 'warehouse' ? basis.warehouseName : null,
        });
      }}
    >
      <InlineNotice tone="info">
        The stock basis decides which Zoho quantity becomes the snapshot. Stock from multiple
        locations is never summed unless Organization-wide is explicitly selected.
      </InlineNotice>

      <Card className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Default stock basis</legend>
          {STOCK_BASIS_TYPES.map((type) => (
            <label
              key={type}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                type === basisType
                  ? 'border-[var(--color-brand)] bg-[var(--color-brand-subtle)]'
                  : 'border-[var(--color-border)]'
              }`}
            >
              <input
                type="radio"
                name="basis"
                className="mt-1 h-5 w-5 accent-[var(--color-brand)]"
                checked={type === basisType}
                onChange={() =>
                  setForm((current) => ({
                    ...current,
                    defaultStockBasisType: type as StockBasisType,
                  }))
                }
              />
              <span>
                <span className="block font-medium">{STOCK_BASIS_TYPE_LABEL[type]}</span>
                <span className="block text-xs text-[var(--color-ink-subtle)]">
                  {type === 'organization'
                    ? 'Uses the organization-level stock-on-hand figure.'
                    : type === 'location'
                      ? 'Uses only the matched location’s stock-in-hand.'
                      : 'Uses only the matched warehouse’s stock-in-hand.'}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        {basisType !== 'organization' && (
          <>
            {locationsQuery.isError ? (
              <InlineNotice tone="warning">
                The location list could not be loaded from Zoho. Connect Zoho first, then return to
                this screen.
              </InlineNotice>
            ) : (
              <label className="flex flex-col gap-1.5 text-sm font-medium">
                {basisType === 'location' ? 'Zoho location' : 'Zoho warehouse'}
                <Select
                  value={(basisType === 'location' ? basis.locationId : basis.warehouseId) ?? ''}
                  onChange={(event) => {
                    const options = basisType === 'location' ? locations : warehouses;
                    const chosen = options.find((option) => option.id === event.target.value);
                    setForm((current) =>
                      basisType === 'location'
                        ? {
                            ...current,
                            defaultLocationId: chosen?.id ?? null,
                            defaultLocationName: chosen?.name ?? null,
                          }
                        : {
                            ...current,
                            defaultWarehouseId: chosen?.id ?? null,
                            defaultWarehouseName: chosen?.name ?? null,
                          },
                    );
                  }}
                >
                  <option value="">Select…</option>
                  {(basisType === 'location' ? locations : warehouses).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                      {option.isPrimary ? ' (primary)' : ''}
                      {option.isActive ? '' : ' — inactive'}
                    </option>
                  ))}
                </Select>
              </label>
            )}

            {selectedOption !== undefined && (
              <Card className="bg-[var(--color-surface-raised)]">
                <dl className="grid gap-2 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-[var(--color-ink-subtle)]">ID</dt>
                    <dd className="font-mono text-xs">{selectedOption.id}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[var(--color-ink-subtle)]">Name</dt>
                    <dd>{selectedOption.name}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[var(--color-ink-subtle)]">Type</dt>
                    <dd>{selectedOption.type ?? basisType}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-[var(--color-ink-subtle)]">Active</dt>
                    <dd>
                      <Badge tone={selectedOption.isActive ? 'success' : 'muted'}>
                        {selectedOption.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </dd>
                  </div>
                </dl>
              </Card>
            )}

            {issue !== null && <InlineNotice tone="danger">{issue}</InlineNotice>}
          </>
        )}
      </Card>

      <InlineNotice tone="warning">
        Changing the default stock basis affects only newly created Stock Rechecks. An existing
        Stock Recheck keeps the basis it was created with, including when its stock is re-read.
      </InlineNotice>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          loading={testMutation.isPending}
          onClick={() => testMutation.mutate()}
        >
          Test stock resolution
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!isStockBasisComplete(basis)}
          loading={save.isPending}
          loadingText="Saving…"
        >
          Save changes
        </Button>
      </div>
    </form>
  );
}
