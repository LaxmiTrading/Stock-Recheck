/**
 * Stock-basis resolution — specification sections 3.6 and 16.
 */

import { describe, expect, it } from 'vitest';
import {
  describeStockBasis,
  displayAttribute,
  displayUnit,
  displayVendor,
  isStockBasisComplete,
  ORGANIZATION_WIDE_BASIS,
  resolveStockQuantity,
  stockBasisValidationMessage,
  type StockBasis,
  type StockResolutionInput,
} from '@/domain/stockBasis';

const LOCATION_BASIS: StockBasis = {
  type: 'location',
  locationId: 'LOC-MAIN',
  locationName: 'Main Store',
  warehouseId: null,
  warehouseName: null,
};

const WAREHOUSE_BASIS: StockBasis = {
  type: 'warehouse',
  locationId: null,
  locationName: null,
  warehouseId: 'WH-1',
  warehouseName: 'Warehouse One',
};

const ITEM: StockResolutionInput = {
  stockOnHand: 500,
  locations: [
    { locationId: 'LOC-MAIN', locationName: 'Main Store', locationStockOnHand: 120 },
    { locationId: 'LOC-OTHER', locationName: 'Overflow', locationStockOnHand: 380 },
  ],
  warehouses: [{ warehouseId: 'WH-1', warehouseName: 'Warehouse One', warehouseStockOnHand: 42 }],
};

describe('resolveStockQuantity — organization basis', () => {
  it('uses the organization-level figure', () => {
    expect(resolveStockQuantity(ITEM, ORGANIZATION_WIDE_BASIS)).toEqual({ ok: true, quantity: 500 });
  });

  it('fails when the organization figure is absent', () => {
    expect(resolveStockQuantity({ ...ITEM, stockOnHand: null }, ORGANIZATION_WIDE_BASIS)).toEqual({
      ok: false,
      failure: 'STOCK_QUANTITY_UNAVAILABLE',
    });
  });
});

describe('resolveStockQuantity — location basis', () => {
  it('uses ONLY the matched location and never sums locations', () => {
    const result = resolveStockQuantity(ITEM, LOCATION_BASIS);
    expect(result).toEqual({ ok: true, quantity: 120 });
    // 120, not 500 and not 120+380.
  });

  it('fails with STOCK_BASIS_NOT_FOUND when the location is absent from the item', () => {
    expect(
      resolveStockQuantity({ ...ITEM, locations: [] }, LOCATION_BASIS),
    ).toEqual({ ok: false, failure: 'STOCK_BASIS_NOT_FOUND' });
  });

  it('fails with STOCK_QUANTITY_UNAVAILABLE when the location has no usable number', () => {
    expect(
      resolveStockQuantity(
        {
          ...ITEM,
          locations: [{ locationId: 'LOC-MAIN', locationStockOnHand: null }],
        },
        LOCATION_BASIS,
      ),
    ).toEqual({ ok: false, failure: 'STOCK_QUANTITY_UNAVAILABLE' });
  });

  it('fails when the basis has no configured location id', () => {
    expect(
      resolveStockQuantity(ITEM, { ...LOCATION_BASIS, locationId: null }),
    ).toEqual({ ok: false, failure: 'STOCK_BASIS_NOT_FOUND' });
  });

  it('accepts a numeric string from Zoho', () => {
    expect(
      resolveStockQuantity(
        { locations: [{ locationId: 'LOC-MAIN', locationStockOnHand: '77' }] },
        LOCATION_BASIS,
      ),
    ).toEqual({ ok: true, quantity: 77 });
  });

  it('accepts zero as a real quantity, not a missing one', () => {
    expect(
      resolveStockQuantity(
        { locations: [{ locationId: 'LOC-MAIN', locationStockOnHand: 0 }] },
        LOCATION_BASIS,
      ),
    ).toEqual({ ok: true, quantity: 0 });
  });
});

describe('resolveStockQuantity — warehouse basis', () => {
  it('uses only the matched warehouse', () => {
    expect(resolveStockQuantity(ITEM, WAREHOUSE_BASIS)).toEqual({ ok: true, quantity: 42 });
  });

  it('fails when the warehouse is not present on the item', () => {
    expect(
      resolveStockQuantity({ ...ITEM, warehouses: [] }, WAREHOUSE_BASIS),
    ).toEqual({ ok: false, failure: 'STOCK_BASIS_NOT_FOUND' });
  });
});

describe('isStockBasisComplete', () => {
  it('always accepts the organization basis', () => {
    expect(isStockBasisComplete(ORGANIZATION_WIDE_BASIS)).toBe(true);
  });

  it('requires an identifier for location and warehouse bases', () => {
    expect(isStockBasisComplete(LOCATION_BASIS)).toBe(true);
    expect(isStockBasisComplete({ ...LOCATION_BASIS, locationId: null })).toBe(false);
    expect(isStockBasisComplete({ ...WAREHOUSE_BASIS, warehouseId: null })).toBe(false);
  });

  it('explains what is missing', () => {
    expect(stockBasisValidationMessage({ ...LOCATION_BASIS, locationId: null })).toContain(
      'location',
    );
    expect(stockBasisValidationMessage(ORGANIZATION_WIDE_BASIS)).toBeNull();
  });
});

describe('describeStockBasis', () => {
  it('produces a readable one-liner for each basis', () => {
    expect(describeStockBasis(ORGANIZATION_WIDE_BASIS)).toBe('Organization-wide stock');
    expect(describeStockBasis(LOCATION_BASIS)).toBe('Location: Main Store');
    expect(describeStockBasis(WAREHOUSE_BASIS)).toBe('Warehouse: Warehouse One');
  });
});

describe('optional-field fallbacks (section 16)', () => {
  it('never fails a row for a missing vendor, unit or attribute', () => {
    expect(displayVendor(null)).toBe('Not available in Zoho');
    expect(displayVendor('  ')).toBe('Not available in Zoho');
    expect(displayVendor('Metro Supplies')).toBe('Metro Supplies');

    expect(displayUnit(null)).toBe('Not specified');
    expect(displayUnit('pcs')).toBe('pcs');

    expect(displayAttribute(undefined)).toBe('Not available in Zoho');
    expect(displayAttribute('BoltCo')).toBe('BoltCo');
  });
});
