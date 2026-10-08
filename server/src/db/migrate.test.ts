import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls } from '../test/devStack.js';

// Needs the Dev_Stack Postgres. Skips cleanly when it is not reachable.
let available = false;
beforeAll(async () => {
  available = await devStackAvailable();
});

describe('migrations', () => {
  it('apply to an empty database and are idempotent on a second run (Req 1.6, 1.7)', async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('[skip] Dev_Stack not reachable; start `docker compose up -d` to run this test');
      return;
    }

    process.env.DATABASE_URL = devStackUrls.DATABASE_URL;
    const { runMigrations } = await import('./migrate.js');

    const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
    await client.connect();
    try {
      // Reset to a genuinely empty database (drops every table + the
      // node-pg-migrate bookkeeping) so this exercises a from-scratch apply.
      await client.query('DROP SCHEMA public CASCADE');
      await client.query('CREATE SCHEMA public');

      const first = await runMigrations('up');
      expect(first.length).toBeGreaterThan(0);

      const afterFirst = await client.query('SELECT count(*)::int AS n FROM pgmigrations');
      const count = afterFirst.rows[0].n as number;

      // Second run applies nothing new; the bookkeeping table is unchanged.
      const second = await runMigrations('up');
      expect(second.length).toBe(0);

      const afterSecond = await client.query('SELECT count(*)::int AS n FROM pgmigrations');
      expect(afterSecond.rows[0].n).toBe(count);

      // The users table exists exactly once.
      const tbl = await client.query(
        "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'users'",
      );
      expect(tbl.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});
