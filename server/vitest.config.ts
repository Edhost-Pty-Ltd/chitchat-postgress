import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: true,
    setupFiles: ['src/test/setup.ts'],
    globalSetup: ['src/test/globalSetup.ts'],
    // Integration tests share one Postgres/Redis; run files serially so they do
    // not race on the schema, shared connections, or truncation.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
