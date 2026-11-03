import { Client } from 'pg';
import { Redis } from 'ioredis';

/**
 * Helpers for integration tests that need the Dev_Stack (Postgres + Redis).
 * When the stack is not reachable, `devStackAvailable()` returns false so the
 * suites can skip rather than fail in environments without Docker running.
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://chitchat:chitchat@localhost:5432/chitchat';
const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379';

export const devStackUrls = { DATABASE_URL, REDIS_URL };

export async function devStackAvailable(): Promise<boolean> {
  const pg = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1500 });
  let pgOk = false;
  try {
    await pg.connect();
    await pg.query('SELECT 1');
    pgOk = true;
  } catch {
    pgOk = false;
  } finally {
    try {
      await pg.end();
    } catch {
      /* ignore */
    }
  }
  if (!pgOk) return false;

  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    redis.disconnect();
    return pong === 'PONG';
  } catch {
    redis.disconnect();
    return false;
  }
}

/** Minimal env the backend modules read, pointed at the Dev_Stack. */
export function testEnv(): NodeJS.ProcessEnv {
  return {
    PORT: '4000',
    NODE_ENV: 'test',
    DATABASE_URL,
    REDIS_URL,
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'chitchat-media',
    S3_ACCESS_KEY_ID: 'chitchat',
    S3_SECRET_ACCESS_KEY: 'chitchat-secret',
    S3_FORCE_PATH_STYLE: 'true',
    FIREBASE_SERVICE_ACCOUNT_JSON: '{"project_id":"test"}',
    FIREBASE_PROJECT_ID: 'test',
    CORS_ORIGINS: 'http://localhost:8081',
    // Disable token-verification caching in tests so each request exercises the
    // auth path deterministically.
    AUTH_TOKEN_CACHE_TTL_SEC: '0',
  };
}
