import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { getEnv } from '../config/env.js';

let pool: Pool | null = null;

/** Lazily create the shared pg Pool. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getEnv().DATABASE_URL });
  }
  return pool;
}

/**
 * Run a parameterized query (Req 12.2 — parameterized queries only).
 */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
) {
  return getPool().query<T>(text, params as unknown[]);
}

/** Run a function inside a transaction, rolling back on error. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** True when Postgres answers a trivial query. Used by /health (Req 1.8, 1.9). */
export async function pingPostgres(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Close the pool during graceful shutdown (Req 12.7). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
