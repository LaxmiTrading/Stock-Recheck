/**
 * Migration runner — specification section 4.4
 * ("Use migrations rather than manually created production tables").
 *
 *   npm run migrate          apply all pending migrations
 *   npm run migrate:status   list applied / pending
 *
 * Each `.sql` file in this directory runs exactly once, inside a transaction,
 * ordered by filename. A checksum is stored so an already-applied migration
 * cannot be edited silently.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import 'dotenv/config';

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));

function resolveConnectionString(): string {
  const url =
    process.env.DATABASE_URL ??
    process.env.NETLIFY_DATABASE_URL ??
    process.env.NETLIFY_DATABASE_URL_UNPOOLED;

  if (!url) {
    throw new Error(
      'No database connection string. Set DATABASE_URL (or NETLIFY_DATABASE_URL) in your environment or .env file.',
    );
  }
  return url;
}

function requiresTls(connectionString: string): boolean {
  return !/localhost|127\.0\.0\.1/.test(connectionString);
}

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<MigrationFile[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  const sqlFiles = entries.filter((name) => name.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const name of sqlFiles) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), 'utf8');
    migrations.push({
      name,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }
  return migrations;
}

async function ensureMigrationsTable(client: pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function appliedMigrations(client: pg.Client): Promise<Map<string, string>> {
  const result = await client.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  return new Map(result.rows.map((row) => [row.name, row.checksum]));
}

async function up(client: pg.Client): Promise<void> {
  await ensureMigrationsTable(client);
  const migrations = await loadMigrations();
  const applied = await appliedMigrations(client);

  let appliedCount = 0;

  for (const migration of migrations) {
    const existingChecksum = applied.get(migration.name);

    if (existingChecksum !== undefined) {
      if (existingChecksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} has already been applied but its contents changed.\n` +
            'Create a NEW migration instead of editing an applied one.',
        );
      }
      continue;
    }

    console.log(`→ applying ${migration.name}`);
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        migration.checksum,
      ]);
      await client.query('COMMIT');
      appliedCount += 1;
      console.log(`  ✓ ${migration.name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`  ✗ ${migration.name} failed; rolled back.`);
      throw error;
    }
  }

  console.log(
    appliedCount === 0
      ? 'Database is already up to date.'
      : `Applied ${appliedCount} migration(s).`,
  );
}

async function status(client: pg.Client): Promise<void> {
  await ensureMigrationsTable(client);
  const migrations = await loadMigrations();
  const applied = await appliedMigrations(client);

  console.log('\n  status   migration');
  console.log('  ------   ---------');
  for (const migration of migrations) {
    const isApplied = applied.has(migration.name);
    console.log(`  ${isApplied ? 'applied' : 'PENDING'}  ${migration.name}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const connectionString = resolveConnectionString();

  const client = new pg.Client({
    connectionString,
    ssl: requiresTls(connectionString) ? { rejectUnauthorized: true } : false,
  });

  await client.connect();
  try {
    if (command === 'up') await up(client);
    else if (command === 'status') await status(client);
    else {
      console.error(`Unknown command "${command}". Use "up" or "status".`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
