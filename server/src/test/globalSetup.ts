// Vitest globalSetup: runs ONCE for the whole suite (not per worker). It applies
// the Postgres migrations a single time against the Dev_Stack so that the many
// integration test files don't race each other on node-pg-migrate's advisory
// lock ("Another migration is already running"). Individual test files only
// truncate data in their own hooks; they must not call runMigrations.

import { Client } from 'pg';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://chitchat:chitchat@localhost:5432/chitchat';

async function reachable(): Promise<boolean> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    await client.end();
    return true;
  } catch {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
    return false;
  }
}

export default async function setup(): Promise<void> {
  if (!(await reachable())) {
    // No Dev_Stack: integration tests will skip themselves via devStackAvailable().
    return;
  }

  // Ensure the full env is present before importing modules that read it.
  process.env.DATABASE_URL = DATABASE_URL;
  process.env.REDIS_URL ??= process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
  process.env.PORT ??= '4000';
  process.env.NODE_ENV ??= 'test';
  process.env.S3_ENDPOINT ??= 'http://localhost:9000';
  process.env.S3_REGION ??= 'us-east-1';
  process.env.S3_BUCKET ??= 'chitchat-media';
  process.env.S3_ACCESS_KEY_ID ??= 'chitchat';
  process.env.S3_SECRET_ACCESS_KEY ??= 'chitchat-secret';
  process.env.S3_FORCE_PATH_STYLE ??= 'true';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON ??= '{"project_id":"test"}';
  process.env.FIREBASE_PROJECT_ID ??= 'test';
  process.env.CORS_ORIGINS ??= 'http://localhost:8081';

  const { runMigrations } = await import('../db/migrate.js');
  await runMigrations('up');

  // Close the pool opened by runMigrations so it doesn't leak into workers.
  const { closePool } = await import('../db/pool.js');
  await closePool();
}
