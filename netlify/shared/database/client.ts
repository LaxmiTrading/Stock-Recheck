/**
 * Database access layer — specification section 4.4.
 *
 * Deliberately written against plain `pg` rather than a provider-specific
 * driver, so Netlify DB (Neon) can be swapped for any other PostgreSQL host by
 * changing DATABASE_URL alone.
 *
 * Every query in the application goes through `query()` or `withTransaction()`.
 * Both use parameterized SQL exclusively — no string interpolation of user
 * input anywhere (section 34).
 */

import pg from 'pg';
import { DatabaseUnavailableError } from '../errors';

/* --------------------------------------------------------- type coercion --

   node-postgres returns NUMERIC and BIGINT as strings to avoid precision loss.
   Our numeric columns (quantities, differences) are all well within IEEE-754
   integer-safe range, and the domain layer expects numbers, so we parse them.
   ------------------------------------------------------------------------ */
const PG_TYPE_NUMERIC = 1700;
const PG_TYPE_INT8 = 20;
const PG_TYPE_DATE = 1082;

pg.types.setTypeParser(PG_TYPE_NUMERIC, (value: string) => Number.parseFloat(value));
pg.types.setTypeParser(PG_TYPE_INT8, (value: string) => Number.parseInt(value, 10));

/*
 * DATE columns stay as the literal 'YYYY-MM-DD' string.
 *
 * By default node-postgres turns a DATE into a JavaScript Date at LOCAL
 * midnight. `business_date` is a calendar date in the configured business
 * timezone, not an instant, so that conversion is wrong twice over: it invents
 * a time component, and serializing it back can land on the previous or next
 * day depending on the server's offset — precisely the drift section 3.1
 * warns about. Keeping the string also matches what the API contract and the
 * `YYYY-MM-DD` schemas expect.
 */
pg.types.setTypeParser(PG_TYPE_DATE, (value: string) => value);

/* ------------------------------------------------------------ connection -- */

function resolveConnectionString(): string {
  const url =
    process.env.DATABASE_URL ??
    process.env.NETLIFY_DATABASE_URL ??
    process.env.NETLIFY_DATABASE_URL_UNPOOLED;

  if (!url) {
    throw new DatabaseUnavailableError(
      'No database connection string is configured on the server.',
    );
  }
  return url;
}

function requiresTls(connectionString: string): boolean {
  return !/localhost|127\.0\.0\.1/.test(connectionString);
}

/**
 * A single module-scoped pool, reused across warm Lambda invocations.
 * `max` is intentionally small: serverless scales by adding *instances*, so a
 * large per-instance pool exhausts the database's connection limit.
 */
let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool !== null) return pool;

  const connectionString = resolveConnectionString();
  pool = new pg.Pool({
    connectionString,
    ssl: requiresTls(connectionString) ? { rejectUnauthorized: true } : false,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    // Guards against a runaway query holding a serverless instance open.
    statement_timeout: 25_000,
    query_timeout: 25_000,
  });

  pool.on('error', (error) => {
    // An idle client erroring must not take down the process.
    console.error('[db] idle client error', { message: error.message });
  });

  return pool;
}

/** Closes the pool. Used by tests and scripts; not called in Lambda. */
export async function closePool(): Promise<void> {
  if (pool !== null) {
    const current = pool;
    pool = null;
    await current.end();
  }
}

/* ---------------------------------------------------------------- query -- */

export type QueryParameters = readonly unknown[];

function wrapDatabaseError(error: unknown): never {
  if (error instanceof DatabaseUnavailableError) throw error;

  const message = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined;

  // Connection-level failures become a distinct, actionable error (section 37).
  const connectionCodes = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', '57P01', '57P03', '08006', '08001']);
  if (code !== undefined && connectionCodes.has(code)) {
    throw new DatabaseUnavailableError('The database is not reachable right now.');
  }

  // Rethrow with the original for the error mapper to inspect.
  throw Object.assign(new Error(message), { cause: error, pgCode: code });
}

/**
 * Runs a parameterized query against the pool.
 * @example query<{ id: string }>('SELECT id FROM profiles WHERE email = $1', [email])
 */
export async function query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  parameters: QueryParameters = [],
): Promise<pg.QueryResult<Row>> {
  try {
    return await getPool().query<Row>(text, parameters as unknown[]);
  } catch (error) {
    return wrapDatabaseError(error);
  }
}

/** Returns the first row, or null when the query produced none. */
export async function queryOne<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  parameters: QueryParameters = [],
): Promise<Row | null> {
  const result = await query<Row>(text, parameters);
  return result.rows[0] ?? null;
}

/** Returns all rows. */
export async function queryMany<Row extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  parameters: QueryParameters = [],
): Promise<Row[]> {
  const result = await query<Row>(text, parameters);
  return result.rows;
}

/* ---------------------------------------------------------- transactions -- */

/**
 * The handle handed to a transaction body. Only these methods are available,
 * which prevents a nested `getPool()` call from accidentally running outside
 * the transaction.
 */
export interface TransactionClient {
  query<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    parameters?: QueryParameters,
  ): Promise<pg.QueryResult<Row>>;
  queryOne<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    parameters?: QueryParameters,
  ): Promise<Row | null>;
  queryMany<Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    parameters?: QueryParameters,
  ): Promise<Row[]>;
}

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

/**
 * Runs `body` inside a transaction, committing on success and rolling back on
 * any throw. Used for every concurrency-sensitive operation (section 4.4).
 *
 * The connection is always released, including when COMMIT itself fails.
 */
export async function withTransaction<Result>(
  body: (client: TransactionClient) => Promise<Result>,
  isolationLevel: IsolationLevel = 'READ COMMITTED',
): Promise<Result> {
  const connection = await getPool().connect().catch(wrapDatabaseError);

  // Declared as a standalone generic function so the row type threads through
  // queryOne/queryMany instead of collapsing to the default.
  const runQuery = async <Row extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    parameters: QueryParameters = [],
  ): Promise<pg.QueryResult<Row>> => {
    try {
      return await connection.query<Row>(text, parameters as unknown[]);
    } catch (error) {
      return wrapDatabaseError(error);
    }
  };

  const client: TransactionClient = {
    query: runQuery,
    queryOne: async <Row extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      parameters: QueryParameters = [],
    ): Promise<Row | null> => {
      const result = await runQuery<Row>(text, parameters);
      return result.rows[0] ?? null;
    },
    queryMany: async <Row extends pg.QueryResultRow = pg.QueryResultRow>(
      text: string,
      parameters: QueryParameters = [],
    ): Promise<Row[]> => {
      const result = await runQuery<Row>(text, parameters);
      return result.rows;
    },
  };

  try {
    await connection.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
    const result = await body(client);
    await connection.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await connection.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[db] rollback failed', {
        message: rollbackError instanceof Error ? rollbackError.message : 'unknown',
      });
    }
    throw error;
  } finally {
    connection.release();
  }
}

/* ------------------------------------------------------------- utilities -- */

/** True when a thrown pg error is a unique-constraint violation. */
export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: string; pgCode?: string; constraint?: string; cause?: unknown };
  const code = candidate.code ?? candidate.pgCode;
  const causeCode =
    typeof candidate.cause === 'object' && candidate.cause !== null
      ? (candidate.cause as { code?: string }).code
      : undefined;

  if (code !== '23505' && causeCode !== '23505') return false;
  if (constraintName === undefined) return true;

  const constraint =
    candidate.constraint ??
    (typeof candidate.cause === 'object' && candidate.cause !== null
      ? (candidate.cause as { constraint?: string }).constraint
      : undefined);
  return constraint === constraintName;
}

/** Verifies connectivity for the health indicator. */
export async function healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
  const startedAt = Date.now();
  try {
    await query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return { ok: false, latencyMs: Date.now() - startedAt };
  }
}
