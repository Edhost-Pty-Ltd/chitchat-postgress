import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import runner from 'node-pg-migrate';
import { getEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { sslConfig } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// migrations/ lives at the server root, two levels up from src/db/.
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

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
  runMigrations(dir)
    .then((applied) => {
      logger.info({ applied }, `Migrations ${dir} complete`);
      process.exit(0);
    })
    .catch((err) => {
      logger.error({ err }, 'Migration failed');
      process.exit(1);
    });
}
