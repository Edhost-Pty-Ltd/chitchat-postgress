import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from 'pg';
import runner from 'node-pg-migrate';
import { getEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sslConfig } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// migrations/ lives at the server root, two levels up from src/db/.
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/**
 * Ensure the target database named in DATABASE_URL exists before migrating.
 *
 * node-pg-migrate creates tables, not the database itself, and CREATE DATABASE
 * cannot run inside a transaction — so we connect to the server's default
 * `postgres` maintenance database, check pg_database, and create the target if
 * it is missing. Idempotent: a second run is a no-op. SSL honours DATABASE_SSL
 * so it works against managed providers (RDS/Aurora) the same way the pool does.
 */
export async function ensureDatabase(): Promise<boolean> {
  const env = getEnv();
  const url = new URL(env.DATABASE_URL);
  // Path is "/<dbname>"; strip the leading slash.
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!dbName) {
    throw new Error('DATABASE_URL has no database name in its path');
  }

  // Connect to the maintenance database on the same server/credentials.
  const adminUrl = new URL(env.DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const client = new Client({ connectionString: adminUrl.toString(), ssl: sslConfig() });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (existing.rowCount && existing.rowCount > 0) {
      logger.info({ database: dbName }, 'Database already exists');
      return false;
    }
    // Identifier can't be parameterized; dbName comes from our own config, but
    // quote it defensively against embedded double quotes.
    const safe = '"' + dbName.replace(/"/g, '""') + '"';
    await client.query(`CREATE DATABASE ${safe}`);
    logger.info({ database: dbName }, 'Database created');
    return true;
  } finally {
    await client.end();
  }
}

/**
 * Apply all pending migrations against DATABASE_URL (Req 1.6).
 * node-pg-migrate tracks applied migrations in `pgmigrations`, guaranteeing
 * each file runs at most once even across repeated invocations (Req 1.7).
 */
export async function runMigrations(direction: 'up' | 'down' = 'up'): Promise<string[]> {
  const env = getEnv();
  const migrated = await runner({
    // Pass a ClientConfig so migrations honour DATABASE_SSL (e.g. RDS TLS),
    // the same way the runtime pool does.
    databaseUrl: { connectionString: env.DATABASE_URL, ssl: sslConfig() },
    dir: MIGRATIONS_DIR,
    direction,
    migrationsTable: 'pgmigrations',
    count: direction === 'up' ? Infinity : 1,
    checkOrder: false,
    // SQL files use `-- Up Migration` / `-- Down Migration` section markers.
    singleTransaction: true,
    verbose: false,
  });
  return migrated.map((m) => m.name);
}

// Allow `node dist/db/migrate.js` as a standalone entry point.
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  const dir = (process.argv[2] as 'up' | 'down') ?? 'up';
  // Create the target database first (up only); down never creates databases.
  (dir === 'up' ? ensureDatabase() : Promise.resolve(false))
    .then(() => runMigrations(dir))
    .then((applied) => {
      logger.info({ applied }, `Migrations ${dir} complete`);
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
