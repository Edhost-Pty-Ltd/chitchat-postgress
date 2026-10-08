import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { devStackAvailable, testEnv } from '../test/devStack.js';

// /health integration test (Req 1.8, 1.9). Needs Dev_Stack Postgres + Redis.
let available = false;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());
  const { buildServer } = await import('./server.js');
  app = await buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  const { closePool } = await import('../db/pool.js');
  const { closeRedis } = await import('../redis/client.js');
  await closePool();
  await closeRedis();
});

describe('GET /health', () => {
  it('returns 200 when Postgres and Redis respond', async () => {
    if (!available || !app) {
      // eslint-disable-next-line no-console
      console.warn('[skip] Dev_Stack not reachable; start `docker compose up -d` to run this test');
      return;
    }
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.dependencies).toEqual({ postgres: true, redis: true });
  });

  it('returns 503 naming the failing dependency', async () => {
    if (!available || !app) return;
    const pool = await import('../db/pool.js');
    const spy = vi.spyOn(pool, 'pingPostgres').mockResolvedValue(false);
    try {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.failing).toContain('postgres');
    } finally {
      spy.mockRestore();
    }
  });
});
