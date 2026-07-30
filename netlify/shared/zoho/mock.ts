/**
 * Local mock inventory — specification section 42.
 *
 * Lets the entire application be exercised without Zoho credentials. Enabled
 * only when ZOHO_MOCK_MODE=true, and refused in a production context unless
 * ALLOW_MOCK_IN_PRODUCTION is also set (see `createBooksReader`).
 *
 * The fixtures deliberately include the awkward cases the import screen must
 * report: an inactive item, a service (non-tracked) item, an ambiguous SKU and
 * an item with no stock at the configured location.
 */

import { toNormalizedSku } from '../../../src/domain/sku';
import type { BooksReader, SkuLookupOutcome } from './books';
import type {
  ZohoItemDetail,
  ZohoLocationRecord,
  ZohoOrganization,
  ZohoWarehouseRecord,
} from './types';

export const MOCK_ORGANIZATION_ID = '60000000001';
export const MOCK_ORGANIZATION_NAME = 'Demo Warehouse Pvt Ltd';
export const MOCK_LOCATION_ID = 'LOC-MAIN-001';
export const MOCK_LOCATION_NAME = 'Main Store';
export const MOCK_SECONDARY_LOCATION_ID = 'LOC-OVERFLOW-002';

interface MockItemSpec {
  id: string;
  name: string;
  sku: string;
  stock: number;
  vendor?: string;
  brand?: string;
  manufacturer?: string;
  unit?: string;
  status?: 'active' | 'inactive';
  productType?: 'goods' | 'service';
  trackInventory?: boolean;
  /** Omit the configured location to exercise STOCK_BASIS_NOT_FOUND. */
  omitPrimaryLocation?: boolean;
  /** Suppress every stock figure to exercise STOCK_QUANTITY_UNAVAILABLE. */
  omitStock?: boolean;
  brandViaCustomField?: boolean;
}

const SPECS: MockItemSpec[] = [
  { id: '1001', name: 'Hex Bolt M8 x 40mm', sku: 'SKU-0001', stock: 120, vendor: 'Metro Supplies', brand: 'BoltCo', manufacturer: 'BoltCo Industries', unit: 'pcs' },
  { id: '1002', name: 'Hex Nut M8', sku: 'SKU-0002', stock: 340, vendor: 'Metro Supplies', unit: 'pcs' },
  { id: '1003', name: 'Washer M8 Zinc', sku: 'SKU-0003', stock: 0, vendor: 'Metro Supplies', unit: 'pcs' },
  { id: '1004', name: 'Cyanoacrylate Adhesive 20g', sku: 'ABC-001', stock: 45, vendor: 'ChemDirect', unit: 'tube' },
  { id: '1005', name: 'Epoxy Resin Kit 500ml', sku: 'XYZ-002', stock: 18, vendor: 'ChemDirect', unit: 'kit' },
  { id: '1006', name: 'Threadlocker Blue 10ml', sku: 'ABC-002', stock: 76, vendor: 'ChemDirect', brandViaCustomField: true, unit: 'bottle' },
  { id: '1007', name: 'Socket Cap Screw M6', sku: 'SKU-0007', stock: 210, vendor: 'Metro Supplies', unit: 'pcs' },
  { id: '1008', name: 'Spring Washer M6', sku: 'SKU-0008', stock: 158, unit: 'pcs' },
  { id: '1009', name: 'Machine Screw M4 x 12mm', sku: 'SKU-0009', stock: 500, vendor: 'FastFix', unit: 'pcs' },
  { id: '1010', name: 'Wing Nut M6', sku: 'SKU-0010', stock: 64, vendor: 'FastFix', unit: 'pcs' },
  { id: '1011', name: 'Anchor Bolt 10mm', sku: 'SKU-0011', stock: 90, vendor: 'BuildRight', unit: 'pcs' },
  { id: '1012', name: 'Self-Tapping Screw 4.2mm', sku: 'SKU-0012', stock: 430, vendor: 'BuildRight', unit: 'pcs' },
  { id: '1013', name: 'Rivet Aluminium 4mm', sku: 'SKU-0013', stock: 1200, vendor: 'BuildRight', unit: 'pcs' },
  { id: '1014', name: 'Cable Tie 200mm Black', sku: 'SKU-0014', stock: 800, vendor: 'ElectroParts', unit: 'pcs' },
  { id: '1015', name: 'Heat Shrink Tube 6mm', sku: 'SKU-0015', stock: 240, vendor: 'ElectroParts', unit: 'm' },
  { id: '1016', name: 'Insulation Tape Red', sku: 'SKU-0016', stock: 55, vendor: 'ElectroParts', unit: 'roll' },
  { id: '1017', name: 'Grease Cartridge 400g', sku: 'SKU-0017', stock: 32, vendor: 'LubeMax', unit: 'cartridge' },
  { id: '1018', name: 'Penetrating Oil 200ml', sku: 'SKU-0018', stock: 71, vendor: 'LubeMax', unit: 'can' },
  { id: '1019', name: 'Safety Glasses Clear', sku: 'SKU-0019', stock: 26, vendor: 'SafeGear', unit: 'pair' },
  { id: '1020', name: 'Nitrile Gloves Medium', sku: 'SKU-0020', stock: 340, vendor: 'SafeGear', unit: 'box' },
  { id: '1021', name: 'Leading Zero Part', sku: '0012345', stock: 12, vendor: 'FastFix', unit: 'pcs' },
  { id: '1022', name: 'Internal Space Part', sku: 'PART 500 X', stock: 7, vendor: 'FastFix', unit: 'pcs' },

  /* Deliberate failure fixtures */
  { id: '1090', name: 'Discontinued Bracket', sku: 'INACTIVE-001', stock: 5, status: 'inactive' },
  { id: '1091', name: 'Installation Service', sku: 'SERVICE-001', stock: 0, productType: 'service', trackInventory: false },
  { id: '1092', name: 'Overflow-Only Item', sku: 'NOLOC-001', stock: 15, omitPrimaryLocation: true },
  { id: '1093', name: 'Stock Figure Missing', sku: 'NOSTOCK-001', stock: 0, omitStock: true },
  /* Two items sharing a SKU → AMBIGUOUS_SKU */
  { id: '1094', name: 'Duplicate SKU Item A', sku: 'AMBIG-001', stock: 3 },
  { id: '1095', name: 'Duplicate SKU Item B', sku: 'AMBIG-001', stock: 9 },
];

function toDetail(spec: MockItemSpec): ZohoItemDetail {
  const locations = spec.omitStock
    ? []
    : spec.omitPrimaryLocation
      ? [
          {
            location_id: MOCK_SECONDARY_LOCATION_ID,
            location_name: 'Overflow Store',
            location_stock_on_hand: spec.stock,
          },
        ]
      : [
          {
            location_id: MOCK_LOCATION_ID,
            location_name: MOCK_LOCATION_NAME,
            location_stock_on_hand: spec.stock,
            is_primary: true,
          },
        ];

  return {
    item_id: spec.id,
    name: spec.name,
    sku: spec.sku,
    status: spec.status ?? 'active',
    product_type: spec.productType ?? 'goods',
    item_type: (spec.productType ?? 'goods') === 'service' ? 'sales' : 'inventory',
    track_inventory: spec.trackInventory ?? true,
    stock_on_hand: spec.omitStock ? undefined : spec.stock,
    unit: spec.unit,
    brand: spec.brandViaCustomField ? undefined : spec.brand,
    manufacturer: spec.manufacturer,
    vendor_name: spec.vendor,
    preferred_vendors:
      spec.vendor === undefined ? [] : [{ vendor_id: `V-${spec.id}`, vendor_name: spec.vendor, is_primary: true }],
    locations,
    custom_fields: spec.brandViaCustomField
      ? [{ label: 'Brand', api_name: 'cf_brand', value: 'CustomFieldBrand' }]
      : [],
  };
}

/** Every SKU present in the mock catalogue, for seeding and documentation. */
export const MOCK_SKUS: string[] = SPECS.map((spec) => spec.sku);

/** Simulates realistic network latency so loading states are visible locally. */
const MOCK_LATENCY_MS = 35;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MockBooksReader implements BooksReader {
  readonly isMock = true;

  async lookupBySku(sku: string, _correlationId: string): Promise<SkuLookupOutcome> {
    await delay(MOCK_LATENCY_MS);
    const normalized = toNormalizedSku(sku);
    const matches = SPECS.filter((spec) => toNormalizedSku(spec.sku) === normalized);

    if (matches.length === 0) return { kind: 'not_found' };
    if (matches.length > 1) return { kind: 'ambiguous', matchCount: matches.length };
    return { kind: 'found', item: toDetail(matches[0] as MockItemSpec) };
  }


  async listOrganizations(_correlationId: string): Promise<ZohoOrganization[]> {
    await delay(MOCK_LATENCY_MS);
    return [
      {
        organization_id: MOCK_ORGANIZATION_ID,
        name: MOCK_ORGANIZATION_NAME,
        is_default_org: true,
        currency_code: 'INR',
        time_zone: 'Asia/Kolkata',
        country: 'India',
      },
    ];
  }

  async listLocations(
    _correlationId: string,
  ): Promise<{ locations: ZohoLocationRecord[]; warehouses: ZohoWarehouseRecord[] }> {
    await delay(MOCK_LATENCY_MS);
    return {
      locations: [
        {
          location_id: MOCK_LOCATION_ID,
          location_name: MOCK_LOCATION_NAME,
          type: 'general',
          status: 'active',
          is_primary: true,
        },
        {
          location_id: MOCK_SECONDARY_LOCATION_ID,
          location_name: 'Overflow Store',
          type: 'general',
          status: 'active',
        },
      ],
      warehouses: [],
    };
  }

  async testConnection(
    _correlationId: string,
  ): Promise<{ organizationName: string | null; responseMs: number }> {
    await delay(MOCK_LATENCY_MS);
    return { organizationName: MOCK_ORGANIZATION_NAME, responseMs: MOCK_LATENCY_MS };
  }
}

export function createMockBooksReader(): BooksReader {
  return new MockBooksReader();
}
