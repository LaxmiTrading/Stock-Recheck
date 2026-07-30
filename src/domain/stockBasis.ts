/**
 * Stock basis — specification sections 3.6, 16 and 28.3.
 *
 * The basis decides WHICH Zoho quantity becomes the snapshot. Stock from
 * multiple locations is never silently summed: that only happens when
 * organization-wide has been explicitly selected.
 */

export const STOCK_BASIS_TYPES = ['organization', 'location', 'warehouse'] as const;
export type StockBasisType = (typeof STOCK_BASIS_TYPES)[number];

export const STOCK_BASIS_TYPE_LABEL: Record<StockBasisType, string> = {
  organization: 'Organization-wide',
  location: 'Specific location',
  warehouse: 'Specific warehouse',
};

export interface StockBasis {
  type: StockBasisType;
  locationId: string | null;
  locationName: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
}

export const ORGANIZATION_WIDE_BASIS: StockBasis = {
  type: 'organization',
  locationId: null,
  locationName: null,
  warehouseId: null,
  warehouseName: null,
};

/** One-line description shown in headers and the confirmation panel. */
export function describeStockBasis(basis: StockBasis): string {
  switch (basis.type) {
    case 'organization':
      return 'Organization-wide stock';
    case 'location':
      return `Location: ${basis.locationName ?? basis.locationId ?? 'not configured'}`;
    case 'warehouse':
      return `Warehouse: ${basis.warehouseName ?? basis.warehouseId ?? 'not configured'}`;
  }
}

/** A location/warehouse basis is unusable until its identifier is chosen. */
export function isStockBasisComplete(basis: StockBasis): boolean {
  switch (basis.type) {
    case 'organization':
      return true;
    case 'location':
      return typeof basis.locationId === 'string' && basis.locationId.length > 0;
    case 'warehouse':
      return typeof basis.warehouseId === 'string' && basis.warehouseId.length > 0;
  }
}

export function stockBasisValidationMessage(basis: StockBasis): string | null {
  if (isStockBasisComplete(basis)) return null;
  return basis.type === 'location'
    ? 'Select a Zoho location before saving.'
    : 'Select a Zoho warehouse before saving.';
}

/* ---------------------------------------------------- quantity resolution */

/**
 * The subset of a Zoho item response this module needs. Kept structural rather
 * than importing the full Zoho type so the resolver stays unit-testable
 * without any network fixtures.
 */
/**
 * Quantities are typed as `number | string` because Zoho returns numeric
 * fields as strings in some responses. `toFiniteNumber` normalizes both, and
 * the type reflects what actually arrives rather than what we would prefer.
 */
type ZohoQuantity = number | string | null | undefined;

export interface StockResolutionInput {
  /** Organization-level stock-on-hand. */
  stockOnHand?: ZohoQuantity;
  /** Per-location breakdown from the item detail response. */
  locations?: readonly {
    locationId?: string | null;
    locationName?: string | null;
    locationStockOnHand?: ZohoQuantity;
  }[];
  /** Per-warehouse breakdown, present in accounts using the warehouse model. */
  warehouses?: readonly {
    warehouseId?: string | null;
    warehouseName?: string | null;
    warehouseStockOnHand?: ZohoQuantity;
  }[];
}

export type StockResolution =
  | { ok: true; quantity: number }
  | { ok: false; failure: 'STOCK_BASIS_NOT_FOUND' | 'STOCK_QUANTITY_UNAVAILABLE' };

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Resolves the stock-in-hand quantity for the configured basis — section 16.
 *
 *   - location/warehouse basis: match the configured ID exactly and use ONLY
 *     that entry's quantity. A missing entry fails the row with
 *     STOCK_BASIS_NOT_FOUND; a present entry with no usable number fails with
 *     STOCK_QUANTITY_UNAVAILABLE.
 *   - organization basis: use the organization-level field.
 */
export function resolveStockQuantity(
  item: StockResolutionInput,
  basis: StockBasis,
): StockResolution {
  if (basis.type === 'location') {
    if (basis.locationId === null) return { ok: false, failure: 'STOCK_BASIS_NOT_FOUND' };
    const match = item.locations?.find((entry) => entry.locationId === basis.locationId);
    if (match === undefined) return { ok: false, failure: 'STOCK_BASIS_NOT_FOUND' };
    const quantity = toFiniteNumber(match.locationStockOnHand);
    if (quantity === null) return { ok: false, failure: 'STOCK_QUANTITY_UNAVAILABLE' };
    return { ok: true, quantity };
  }

  if (basis.type === 'warehouse') {
    if (basis.warehouseId === null) return { ok: false, failure: 'STOCK_BASIS_NOT_FOUND' };
    const match = item.warehouses?.find((entry) => entry.warehouseId === basis.warehouseId);
    if (match === undefined) return { ok: false, failure: 'STOCK_BASIS_NOT_FOUND' };
    const quantity = toFiniteNumber(match.warehouseStockOnHand);
    if (quantity === null) return { ok: false, failure: 'STOCK_QUANTITY_UNAVAILABLE' };
    return { ok: true, quantity };
  }

  const quantity = toFiniteNumber(item.stockOnHand);
  if (quantity === null) return { ok: false, failure: 'STOCK_QUANTITY_UNAVAILABLE' };
  return { ok: true, quantity };
}

/* ----------------------------------------- optional-field display fallbacks */

/** Section 16 — a missing vendor must not fail the import. */
export const VENDOR_FALLBACK = 'Not available in Zoho';
/** Section 16 — a missing unit must not fail the import. */
export const UNIT_FALLBACK = 'Not specified';
/** Section 16 — missing brand/manufacturer must not fail the row. */
export const ATTRIBUTE_FALLBACK = 'Not available in Zoho';

export function displayVendor(value: string | null | undefined): string {
  return value !== null && value !== undefined && value.trim() !== '' ? value : VENDOR_FALLBACK;
}

export function displayUnit(value: string | null | undefined): string {
  return value !== null && value !== undefined && value.trim() !== '' ? value : UNIT_FALLBACK;
}

export function displayAttribute(value: string | null | undefined): string {
  return value !== null && value !== undefined && value.trim() !== '' ? value : ATTRIBUTE_FALLBACK;
}
