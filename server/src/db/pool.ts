import { readFileSync } from 'node:fs';
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from 'pg';
import { getEnv } from '../config/env.js';

let pool: Pool | null = null;

/**
 * Build the pg SSL option from DATABASE_SSL (Req 12.1 — encrypt in transit).
 *   disable → no TLS (local dev).
 *   require → TLS on, certificate chain NOT verified (RDS without a CA bundle).
 *   verify  → TLS on, chain verified against system CAs + DATABASE_CA_CERT.
 * Returns undefined for `disable` so behaviour is unchanged locally.
 */
export function sslConfig(): PoolConfig['ssl'] {
  const env = getEnv();
  switch (env.DATABASE_SSL) {
    case 'disable':
      return undefined;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify': {
      const ca = env.DATABASE_CA_CERT;
      // Accept either inline PEM or a path to a .pem file.
      const caPem = ca && !ca.includes('BEGIN CERTIFICATE') ? readFileSync(ca, 'utf8') : ca;
      return { rejectUnauthorized: true, ca: caPem };
    }
  }
}

/** Lazily create the shared pg Pool. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getEnv().DATABASE_URL,
      ssl: sslConfig(),
    });
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
