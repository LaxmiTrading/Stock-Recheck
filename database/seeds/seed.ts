/**
 * Local demonstration data — specification section 42.
 *
 *   npm run seed
 *
 * Creates one administrator, two counters, one active Stock Recheck with 22
 * items covering every workflow state (available, claimed, stale claim,
 * matched, mismatched), plus a completed historical recheck.
 *
 * SAFETY: refuses to run against a production context unless
 * ALLOW_SEED_IN_PRODUCTION=true, because it writes real rows and prints
 * well-known passwords.
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import 'dotenv/config';
import { hashPassword } from '../../netlify/shared/auth/password';
import { calculateQuantityDifference, determineResultStatus } from '../../src/domain/quantity';
import { formatRecheckNumber, businessDateInTimeZone } from '../../src/domain/recheckNumber';
import { toNormalizedSku } from '../../src/domain/sku';
import {
  MOCK_LOCATION_ID,
  MOCK_LOCATION_NAME,
  MOCK_ORGANIZATION_ID,
  MOCK_ORGANIZATION_NAME,
} from '../../netlify/shared/zoho/mock';

/* -------------------------------------------------------------- fixtures */

const DEMO_PASSWORD = 'StockRecheck!2026';

const USERS = [
  { email: 'admin@example.com', name: 'Asha Menon', role: 'administrator' as const },
  { email: 'counter1@example.com', name: 'Ravi Kumar', role: 'counter' as const },
  { email: 'counter2@example.com', name: 'Priya Nair', role: 'counter' as const },
];

interface SeedItem {
  zohoItemId: string;
  name: string;
  sku: string;
  stock: number;
  vendor: string | null;
  unit: string;
  /** available | claimed | stale | submitted */
  state: 'available' | 'claimed' | 'stale' | 'submitted';
  /** Only for `submitted`. */
  counted?: number;
  /** Index into USERS for the claimant/submitter. */
  actor?: 1 | 2;
}

const ITEMS: SeedItem[] = [
  { zohoItemId: '1001', name: 'Hex Bolt M8 x 40mm', sku: 'SKU-0001', stock: 120, vendor: 'Metro Supplies', unit: 'pcs', state: 'submitted', counted: 120, actor: 1 },
  { zohoItemId: '1002', name: 'Hex Nut M8', sku: 'SKU-0002', stock: 340, vendor: 'Metro Supplies', unit: 'pcs', state: 'submitted', counted: 338, actor: 1 },
  { zohoItemId: '1003', name: 'Washer M8 Zinc', sku: 'SKU-0003', stock: 0, vendor: 'Metro Supplies', unit: 'pcs', state: 'submitted', counted: 0, actor: 2 },
  { zohoItemId: '1004', name: 'Cyanoacrylate Adhesive 20g', sku: 'ABC-001', stock: 45, vendor: 'ChemDirect', unit: 'tube', state: 'available' },
  { zohoItemId: '1005', name: 'Epoxy Resin Kit 500ml', sku: 'XYZ-002', stock: 18, vendor: 'ChemDirect', unit: 'kit', state: 'available' },
  { zohoItemId: '1006', name: 'Threadlocker Blue 10ml', sku: 'ABC-002', stock: 76, vendor: 'ChemDirect', unit: 'bottle', state: 'claimed', actor: 1 },
  { zohoItemId: '1007', name: 'Socket Cap Screw M6', sku: 'SKU-0007', stock: 210, vendor: 'Metro Supplies', unit: 'pcs', state: 'stale', actor: 2 },
  { zohoItemId: '1008', name: 'Spring Washer M6', sku: 'SKU-0008', stock: 158, vendor: null, unit: 'pcs', state: 'available' },
  { zohoItemId: '1009', name: 'Machine Screw M4 x 12mm', sku: 'SKU-0009', stock: 500, vendor: 'FastFix', unit: 'pcs', state: 'submitted', counted: 503, actor: 2 },
  { zohoItemId: '1010', name: 'Wing Nut M6', sku: 'SKU-0010', stock: 64, vendor: 'FastFix', unit: 'pcs', state: 'available' },
  { zohoItemId: '1011', name: 'Anchor Bolt 10mm', sku: 'SKU-0011', stock: 90, vendor: 'BuildRight', unit: 'pcs', state: 'available' },
  { zohoItemId: '1012', name: 'Self-Tapping Screw 4.2mm', sku: 'SKU-0012', stock: 430, vendor: 'BuildRight', unit: 'pcs', state: 'available' },
  { zohoItemId: '1013', name: 'Rivet Aluminium 4mm', sku: 'SKU-0013', stock: 1200, vendor: 'BuildRight', unit: 'pcs', state: 'available' },
  { zohoItemId: '1014', name: 'Cable Tie 200mm Black', sku: 'SKU-0014', stock: 800, vendor: 'ElectroParts', unit: 'pcs', state: 'submitted', counted: 795, actor: 1 },
  { zohoItemId: '1015', name: 'Heat Shrink Tube 6mm', sku: 'SKU-0015', stock: 240, vendor: 'ElectroParts', unit: 'm', state: 'available' },
  { zohoItemId: '1016', name: 'Insulation Tape Red', sku: 'SKU-0016', stock: 55, vendor: 'ElectroParts', unit: 'roll', state: 'available' },
  { zohoItemId: '1017', name: 'Grease Cartridge 400g', sku: 'SKU-0017', stock: 32, vendor: 'LubeMax', unit: 'cartridge', state: 'available' },
  { zohoItemId: '1018', name: 'Penetrating Oil 200ml', sku: 'SKU-0018', stock: 71, vendor: 'LubeMax', unit: 'can', state: 'available' },
  { zohoItemId: '1019', name: 'Safety Glasses Clear', sku: 'SKU-0019', stock: 26, vendor: 'SafeGear', unit: 'pair', state: 'submitted', counted: 26, actor: 2 },
  { zohoItemId: '1020', name: 'Nitrile Gloves Medium', sku: 'SKU-0020', stock: 340, vendor: 'SafeGear', unit: 'box', state: 'available' },
  // Leading zeros and an internal space: the two SKU shapes most likely to be
  // mangled by a spreadsheet round trip.
  { zohoItemId: '1021', name: 'Leading Zero Part', sku: '0012345', stock: 12, vendor: 'FastFix', unit: 'pcs', state: 'available' },
  { zohoItemId: '1022', name: 'Internal Space Part', sku: 'PART 500 X', stock: 7, vendor: 'FastFix', unit: 'pcs', state: 'available' },
];

/* ---------------------------------------------------------------- runner */

function resolveConnectionString(): string {
  const url =
    process.env.DATABASE_URL ??
    process.env.NETLIFY_DATABASE_URL ??
    process.env.NETLIFY_DATABASE_URL_UNPOOLED;
  if (!url) throw new Error('Set DATABASE_URL before seeding.');
  return url;
}

function assertNotProduction(): void {
  const isProduction =
    process.env.NODE_ENV === 'production' || process.env.CONTEXT === 'production';
  if (isProduction && process.env.ALLOW_SEED_IN_PRODUCTION !== 'true') {
    throw new Error(
      'Refusing to seed a production database. Set ALLOW_SEED_IN_PRODUCTION=true only if you are certain.',
    );
  }
}

async function main(): Promise<void> {
  assertNotProduction();

  const connectionString = resolveConnectionString();
  const client = new pg.Client({
    connectionString,
    ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: true },
  });

  await client.connect();
  console.log('Seeding demonstration data…\n');

  try {
    await client.query('BEGIN');

    /* ---------------------------------------------------------- users */
    const { hash, salt } = await hashPassword(DEMO_PASSWORD);
    const userIds: string[] = [];

    for (const user of USERS) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO profiles (email, display_name, role, status, password_hash, password_salt)
         VALUES ($1, $2, $3, 'active', $4, $5)
         -- Uniqueness is enforced by a functional index on lower(email), so the
         -- conflict target must be the same expression.
         ON CONFLICT (lower(email)) DO NOTHING
         RETURNING id`,
        [user.email, user.name, user.role, hash, salt],
      );

      if (result.rows[0] !== undefined) {
        userIds.push(result.rows[0].id);
      } else {
        // Already seeded: reuse the existing profile and refresh its password
        // so the documented demo credentials always work.
        const existing = await client.query<{ id: string }>(
          `UPDATE profiles
              SET password_hash = $2, password_salt = $3, status = 'active',
                  display_name = $4, role = $5
            WHERE lower(email) = lower($1)
          RETURNING id`,
          [user.email, hash, salt, user.name, user.role],
        );
        userIds.push(existing.rows[0]?.id ?? '');
      }
      console.log(`  user  ${user.email.padEnd(24)} ${user.role}`);
    }

    const adminId = userIds[0] as string;

    /* -------------------------------------------------------- settings */
    await client.query(
      `UPDATE app_settings
          SET business_name = 'Demo Warehouse Pvt Ltd',
              business_timezone = 'Asia/Kolkata',
              default_stock_basis_type = 'location',
              default_location_id = $1,
              default_location_name = $2,
              updated_by = $3
        WHERE singleton`,
      [MOCK_LOCATION_ID, MOCK_LOCATION_NAME, adminId],
    );

    await client.query(
      `UPDATE zoho_connections
          SET organization_id = $1, organization_name = $2,
              accounts_domain = 'https://accounts.zoho.in',
              api_domain = 'https://www.zohoapis.in',
              data_center = 'IN',
              connection_status = 'connected',
              scope_summary = 'ZohoBooks.settings.READ',
              last_success_at = NOW()
        WHERE singleton`,
      [MOCK_ORGANIZATION_ID, MOCK_ORGANIZATION_NAME],
    );

    /* --------------------------------------------------- import batch */
    const businessDate = businessDateInTimeZone(new Date(), 'Asia/Kolkata');

    const batchResult = await client.query<{ id: string }>(
      `INSERT INTO import_batches (
         source_type, source_file_name, worksheet_name, mapped_sku_column,
         header_row_number, status, total_source_rows, passed_rows, failed_rows,
         duplicate_rows, ignored_blank_rows,
         stock_basis_type, stock_location_id, stock_location_name,
         zoho_organization_id, zoho_organization_name,
         created_by, validation_started_at, validation_finished_at
       ) VALUES ('excel', 'demo-stock-list.xlsx', 'Sheet1', 'A', 1, 'consumed',
                 $1, $2, 0, 0, 0, 'location', $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id`,
      [
        ITEMS.length,
        ITEMS.length,
        MOCK_LOCATION_ID,
        MOCK_LOCATION_NAME,
        MOCK_ORGANIZATION_ID,
        MOCK_ORGANIZATION_NAME,
        adminId,
      ],
    );
    const batchId = batchResult.rows[0]?.id as string;

    /* ------------------------------------------------ active recheck */
    const sequenceResult = await client.query<{ next: number }>(
      'SELECT COUNT(*)::int + 1 AS next FROM stock_rechecks WHERE business_date = $1::date',
      [businessDate],
    );
    const sequence = sequenceResult.rows[0]?.next ?? 1;
    const recheckNumber = formatRecheckNumber(businessDate, sequence, 'SR');

    const recheckResult = await client.query<{ id: string }>(
      `INSERT INTO stock_rechecks (
         recheck_number, name, business_date, status, import_batch_id, import_source_type,
         zoho_organization_id, zoho_organization_name,
         stock_basis_type, stock_location_id, stock_location_name,
         zoho_snapshot_at, created_by, started_at
       ) VALUES ($1, $2, $3::date, 'in_progress', $4, 'excel', $5, $6,
                 'location', $7, $8, NOW(), $9, NOW())
       RETURNING id`,
      [
        recheckNumber,
        `Stock Recheck — Demo — ${String(sequence).padStart(3, '0')}`,
        businessDate,
        batchId,
        MOCK_ORGANIZATION_ID,
        MOCK_ORGANIZATION_NAME,
        MOCK_LOCATION_ID,
        MOCK_LOCATION_NAME,
        adminId,
      ],
    );
    const recheckId = recheckResult.rows[0]?.id as string;

    /* ------------------------------------------------------- items */
    const counts = { available: 0, inProgress: 0, submitted: 0, matched: 0, mismatched: 0 };
    const now = new Date();

    for (const item of ITEMS) {
      const actorId = item.actor === undefined ? null : (userIds[item.actor] ?? null);
      const snapshot = {
        zohoItemId: item.zohoItemId,
        itemName: item.name,
        sku: item.sku,
        normalizedSku: toNormalizedSku(item.sku),
        stockInHand: item.stock,
        vendorName: item.vendor,
        unit: item.unit,
        stockBasisType: 'location',
        stockLocationId: MOCK_LOCATION_ID,
        stockLocationName: MOCK_LOCATION_NAME,
        organizationId: MOCK_ORGANIZATION_ID,
        organizationName: MOCK_ORGANIZATION_NAME,
        snapshotAt: new Date().toISOString(),
      };

      let workflowStatus = 'available';
      let resultStatus = 'pending';
      let claimedBy: string | null = null;
      let claimedAt: Date | null = null;
      let claimExpiry: Date | null = null;
      let claimVersion = 0;
      let countedQuantity: number | null = null;
      let difference: number | null = null;
      let submittedBy: string | null = null;
      let submittedAt: Date | null = null;

      if (item.state === 'claimed' || item.state === 'stale') {
        workflowStatus = 'counting_in_progress';
        claimedBy = actorId;
        claimVersion = 1;
        claimedAt = new Date(now.getTime() - 5 * 60_000);
        // A stale claim expired 20 minutes ago and is therefore reclaimable,
        // which is what exercises the expiry sweep (section 20).
        claimExpiry =
          item.state === 'stale'
            ? new Date(now.getTime() - 20 * 60_000)
            : new Date(now.getTime() + 15 * 60_000);
        counts.inProgress += 1;
      } else if (item.state === 'submitted') {
        const counted = item.counted ?? 0;
        difference = calculateQuantityDifference(counted, item.stock);
        resultStatus = determineResultStatus(difference);
        workflowStatus = 'submitted';
        countedQuantity = counted;
        submittedBy = actorId;
        submittedAt = now;
        counts.submitted += 1;
        if (resultStatus === 'matched') counts.matched += 1;
        else counts.mismatched += 1;
      } else {
        counts.available += 1;
      }

      await client.query(
        `INSERT INTO stock_recheck_items (
           stock_recheck_id, zoho_item_id, item_name, sku, normalized_sku,
           zoho_stock_quantity, vendor_name, unit,
           zoho_snapshot_json, workflow_status, result_status,
           claimed_by, claimed_at, claim_expires_at, claim_version,
           counted_quantity, quantity_difference, submitted_by, submitted_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           $14, $15, $16, $17, $18, $19, $20, $21
         )
         ON CONFLICT (stock_recheck_id, normalized_sku) DO NOTHING`,
        [
          recheckId,
          item.zohoItemId,
          item.name,
          item.sku,
          toNormalizedSku(item.sku),
          item.stock,
          item.vendor,
          item.unit,
          JSON.stringify(snapshot),
          workflowStatus,
          resultStatus,
          claimedBy,
          claimedAt,
          claimExpiry,
          claimVersion,
          countedQuantity,
          difference,
          submittedBy,
          submittedAt,
        ],
      );
    }

    await client.query(
      `UPDATE stock_rechecks
          SET total_items = $2, available_items = $3, in_progress_items = $4,
              submitted_items = $5, matched_items = $6, mismatched_items = $7
        WHERE id = $1`,
      [
        recheckId,
        ITEMS.length,
        counts.available,
        counts.inProgress,
        counts.submitted,
        counts.matched,
        counts.mismatched,
      ],
    );

    /* ------------------------------------------------- audit events */
    await client.query(
      `INSERT INTO audit_events (event_type, actor_user_id, actor_display_name,
                                 stock_recheck_id, metadata_json, correlation_id)
       VALUES ('recheck.created', $1, $2, $3, $4, $5)`,
      [
        adminId,
        USERS[0]?.name ?? 'Administrator',
        recheckId,
        JSON.stringify({ recheckNumber, itemCount: ITEMS.length, seeded: true }),
        randomUUID(),
      ],
    );

    await client.query('COMMIT');

    console.log(`\n  recheck  ${recheckNumber} (${ITEMS.length} items)`);
    console.log(
      `           ${counts.available} available · ${counts.inProgress} counting · ${counts.submitted} submitted`,
    );
    console.log(`           ${counts.matched} matched · ${counts.mismatched} mismatched`);
    console.log('\nSign in with any of:');
    for (const user of USERS) console.log(`  ${user.email.padEnd(24)} ${DEMO_PASSWORD}`);
    console.log('\nSet ZOHO_MOCK_MODE=true to run imports without Zoho credentials.\n');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('\nSeeding failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
