// Vitest global setup: ensure every worker process has a complete, valid
// environment pointing at the Dev_Stack (local Postgres/Redis or Docker), so
// integration tests that read config via getEnv() work regardless of which
// test file runs first. Individual values can still be overridden by the shell
// (TEST_DATABASE_URL / TEST_REDIS_URL take precedence for the data services).

const defaults: Record<string, string> = {
  PORT: process.env.PORT ?? '4000',
  NODE_ENV: 'test',
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL ??
    'postgres://chitchat:chitchat@localhost:5432/chitchat',
  REDIS_URL: process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
  S3_BUCKET: process.env.S3_BUCKET ?? 'chitchat-media',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'chitchat',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'chitchat-secret',
  S3_FORCE_PATH_STYLE: process.env.S3_FORCE_PATH_STYLE ?? 'true',
  FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '{"project_id":"test"}',
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ?? 'test',
  CORS_ORIGINS: process.env.CORS_ORIGINS ?? 'http://localhost:8081',
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}
