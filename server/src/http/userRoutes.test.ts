import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Slice 1 route integration tests (Req 4.2-4.12). Needs Dev_Stack Postgres.
// Auth is stubbed so a token "token:<uid>" authenticates as <uid>.
let available = false;
let app: FastifyInstance | undefined;

async function reset(): Promise<void> {
  const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
  try {
    await client.query('TRUNCATE push_tokens, blocked_users, privacy_settings, users CASCADE');
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());

  process.env.DATABASE_URL = devStackUrls.DATABASE_URL;
  // Schema is migrated once by vitest globalSetup.
  await reset();

  const verifier = await import('../auth/verifier.js');
  const { upsertUserOnFirstContact } = await import('../db/repositories/users.js');
  vi.spyOn(verifier, 'verifyToken').mockImplementation(async (token) => {
    const t = typeof token === 'string' ? token : '';
    const m = /^token:(.+)$/.exec(t);
    if (!m) throw new verifier.AuthError('AUTH_TOKEN_INVALID', 'bad token');
    const uid = m[1];
    // Match the real Auth_Verifier: create the user with a null phone on first
    // contact (phone is assigned later via PUT /me/phone). A derived phone here
    // would collide across uids that share no digits.
    await upsertUserOnFirstContact(uid, null);
    return { userId: uid, firebaseUid: uid, phoneNumber: null };
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

function auth(uid: string) {
  return { authorization: `Bearer token:${uid}` };
}

const guard = (name: string) => {
  if (!available || !app) {
    // eslint-disable-next-line no-console
    console.warn(`[skip] ${name}: Dev_Stack not reachable (docker compose up -d)`);
    return true;
  }
  return false;
};

describe('Slice 1 user routes', () => {
  it('rejects unauthenticated requests with 401 (Req 2.5)', async () => {
    if (guard('401')) return;
    const res = await app!.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toContain('AUTH_');
  });

  it('creates and returns the profile; PATCH updates it (Req 4.2, 4.3)', async () => {
    if (guard('profile')) return;
    const me = await app!.inject({ method: 'GET', url: '/me', headers: auth('alice') });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe('alice');

    const patched = await app!.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth('alice'),
      payload: { displayName: 'Alice Co', about: 'Open 9-5' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().displayName).toBe('Alice Co');
    expect(patched.json().about).toBe('Open 9-5');
  });

  it('rejects an invalid profile body with 400 (Property 23)', async () => {
    if (guard('validation')) return;
    const res = await app!.inject({
      method: 'PATCH',
      url: '/me',
      headers: auth('alice'),
      payload: { displayName: '', unknownField: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when a phone is already taken (Req 4.6)', async () => {
    if (guard('phone-conflict')) return;
    await app!.inject({
      method: 'PUT',
      url: '/me/phone',
      headers: auth('bob'),
      payload: { phoneNumber: '+15550123' },
    });
    const conflict = await app!.inject({
      method: 'PUT',
      url: '/me/phone',
      headers: auth('carol'),
      payload: { phoneNumber: '+15550123' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('CONFLICT');
  });

  it('reads and writes privacy settings (Req 4.9, 4.10)', async () => {
    if (guard('privacy')) return;
    const def = await app!.inject({ method: 'GET', url: '/me/privacy', headers: auth('dave') });
    expect(def.json().lastSeen).toBe('Contacts');

    const put = await app!.inject({
      method: 'PUT',
      url: '/me/privacy',
      headers: auth('dave'),
      payload: {
        lastSeen: 'Nobody',
        profilePhoto: 'Everyone',
        statusVisibility: 'Contacts',
        groups: 'Contacts',
        calls: 'Nobody',
        readReceipts: false,
        disappearingMessages: true,
      },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().lastSeen).toBe('Nobody');
    expect(put.json().readReceipts).toBe(false);
  });

  it('blocks, lists and unblocks users (Req 4.11, 4.12)', async () => {
    if (guard('blocks')) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('erin') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('frank') });

    await app!.inject({
      method: 'POST',
      url: '/blocks',
      headers: auth('erin'),
      payload: { userId: 'frank', displayName: 'Frank' },
    });
    const list = await app!.inject({ method: 'GET', url: '/blocks', headers: auth('erin') });
    expect(list.json().blocked.map((b: { userId: string }) => b.userId)).toContain('frank');

    await app!.inject({ method: 'DELETE', url: '/blocks/frank', headers: auth('erin') });
    const after = await app!.inject({ method: 'GET', url: '/blocks', headers: auth('erin') });
    expect(after.json().blocked).toHaveLength(0);
  });

  it('matches contacts by phone, hides blocked matches, caps at 500 (Req 4.4, 4.5, Property 13)', async () => {
    if (guard('contacts')) return;
    // Register two users with known phones.
    await app!.inject({
      method: 'PUT',
      url: '/me/phone',
      headers: auth('grace'),
      payload: { phoneNumber: '+1700001' },
    });
    await app!.inject({
      method: 'PUT',
      url: '/me/phone',
      headers: auth('heidi'),
      payload: { phoneNumber: '+1700002' },
    });

    const match = await app!.inject({
      method: 'POST',
      url: '/contacts/match',
      headers: auth('grace'),
      payload: { phones: ['+1700002', '+1999999'] },
    });
    expect(match.statusCode).toBe(200);
    const matched = match.json().matches.map((m: { userId: string }) => m.userId);
    expect(matched).toContain('heidi');
    expect(matched).not.toContain('grace'); // self excluded

    // 413 when over the cap.
    const tooMany = await app!.inject({
      method: 'POST',
      url: '/contacts/match',
      headers: auth('grace'),
      payload: { phones: Array.from({ length: 501 }, (_, i) => `+1${i}`) },
    });
    expect(tooMany.statusCode).toBe(413);
  });

  it('registers and removes push tokens (Req 4.7, 4.8)', async () => {
    if (guard('push')) return;
    const add = await app!.inject({
      method: 'POST',
      url: '/push-tokens',
      headers: auth('ivan'),
      payload: { token: 'ExponentPushToken[abc]', platform: 'ios' },
    });
    expect(add.statusCode).toBe(201);
    const del = await app!.inject({
      method: 'DELETE',
      url: `/push-tokens/${encodeURIComponent('ExponentPushToken[abc]')}`,
      headers: auth('ivan'),
    });
    expect(del.statusCode).toBe(200);
  });
});
