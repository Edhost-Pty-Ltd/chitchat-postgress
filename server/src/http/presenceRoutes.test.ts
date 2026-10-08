import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Slice 3 presence REST privacy gating (Property 14, Req 7.4, 7.5).
let available = false;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());
  process.env.DATABASE_URL = devStackUrls.DATABASE_URL;
  // Schema is migrated once by vitest globalSetup.

  const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
  try {
    await client.query('TRUNCATE blocked_users, privacy_settings, users CASCADE');
  } finally {
    await client.end();
  }

  const verifier = await import('../auth/verifier.js');
  const { upsertUserOnFirstContact } = await import('../db/repositories/users.js');
  vi.spyOn(verifier, 'verifyToken').mockImplementation(async (token) => {
    const m = /^token:(.+)$/.exec(typeof token === 'string' ? token : '');
    if (!m) throw new verifier.AuthError('AUTH_TOKEN_INVALID', 'bad');
    await upsertUserOnFirstContact(m[1], null);
    return { userId: m[1], firebaseUid: m[1], phoneNumber: null };
  });

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

const auth = (uid: string) => ({ authorization: `Bearer token:${uid}` });
const guard = () => {
  if (!available || !app) {
    // eslint-disable-next-line no-console
    console.warn('[skip] Dev_Stack not reachable (docker compose up -d)');
    return true;
  }
  return false;
};

describe('GET /presence/:userId', () => {
  it('hides last seen when the owner sets lastSeen=Nobody (Property 14)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('viewer') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('target') });
    await app!.inject({
      method: 'PUT',
      url: '/me/privacy',
      headers: auth('target'),
      payload: {
        lastSeen: 'Nobody',
        profilePhoto: 'Everyone',
        statusVisibility: 'Everyone',
        groups: 'Contacts',
        calls: 'Contacts',
        readReceipts: true,
        disappearingMessages: true,
      },
    });

    const res = await app!.inject({ method: 'GET', url: '/presence/target', headers: auth('viewer') });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lastSeenVisible).toBe(false);
    expect(body.lastSeen).toBeNull();
    expect(body.online).toBe(false);
  });

  it('shows last seen when visibility permits', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('v2') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('t2') });
    const res = await app!.inject({ method: 'GET', url: '/presence/t2', headers: auth('v2') });
    expect(res.statusCode).toBe(200);
    expect(res.json().lastSeenVisible).toBe(true);
  });
});
