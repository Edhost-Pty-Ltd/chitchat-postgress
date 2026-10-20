import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Slice 6 media presign integration tests (Req 10). Needs Dev_Stack Postgres +
// Redis. Presigning builds URLs locally (no live S3 call needed).
let available = false;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());
  process.env.DATABASE_URL = devStackUrls.DATABASE_URL;

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

afterEach(async () => {
  if (!available) return;
  const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
  try {
    await client.query('TRUNCATE chat_members, chats, users CASCADE');
  } finally {
    await client.end();
  }
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

describe('Slice 6 media', () => {
  it('issues an avatar upload URL under the caller prefix (Property 20)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('u1') });
    const res = await app!.inject({
      method: 'POST',
      url: '/media/upload-url',
      headers: auth('u1'),
      payload: { category: 'avatar', contentType: 'image/jpeg', sizeBytes: 1024, ext: 'jpg' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.objectKey).toMatch(/^avatars\/u1\//);
    expect(body.uploadUrl).toContain('X-Amz-Signature');
  });

  it('upload URLs expire within 15 minutes (Property 21)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('u2') });
    const res = await app!.inject({
      method: 'POST',
      url: '/media/upload-url',
      headers: auth('u2'),
      payload: { category: 'status', contentType: 'image/png', sizeBytes: 2048, ext: 'png' },
    });
    const expiresAt = new Date(res.json().expiresAt).getTime();
    const ttlSec = (expiresAt - Date.now()) / 1000;
    expect(ttlSec).toBeGreaterThan(0);
    expect(ttlSec).toBeLessThanOrEqual(15 * 60 + 2);
  });

  it('rejects an oversized or wrong-type upload with 400 (Req 10.5, Property 23)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('u3') });
    const tooBig = await app!.inject({
      method: 'POST',
      url: '/media/upload-url',
      headers: auth('u3'),
      payload: { category: 'avatar', contentType: 'image/jpeg', sizeBytes: 999999999 },
    });
    expect(tooBig.statusCode).toBe(400);

    const wrongType = await app!.inject({
      method: 'POST',
      url: '/media/upload-url',
      headers: auth('u3'),
      payload: { category: 'avatar', contentType: 'application/pdf', sizeBytes: 1024 },
    });
    expect(wrongType.statusCode).toBe(400);
  });

  it('refuses a chat-media upload for a non-member (Req 10.3, Property 20)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('m1') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('m2') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('outsider') });
    const chat = await app!.inject({
      method: 'POST',
      url: '/chats',
      headers: auth('m1'),
      payload: { type: 'direct', members: ['m2'] },
    });
    const chatId = chat.json().chatId;

    const asMember = await app!.inject({
      method: 'POST',
      url: '/media/upload-url',
      headers: auth('m1'),
      payload: { category: 'chat-media', contentType: 'image/jpeg', sizeBytes: 1024, chatId },
    });
    expect(asMember.statusCode).toBe(201);
    expect(asMember.json().objectKey).toMatch(new RegExp(`^chats/${chatId}/media/`));

    const asOutsider = await app!.inject({
      method: 'POST',
      url: '/media/upload-url',
      headers: auth('outsider'),
      payload: { category: 'chat-media', contentType: 'image/jpeg', sizeBytes: 1024, chatId },
    });
    expect(asOutsider.statusCode).toBe(403);
  });

  it('issues download URLs only for authorized keys (Req 10.6)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('d1') });
    const res = await app!.inject({
      method: 'POST',
      url: '/media/download-url',
      headers: auth('d1'),
      payload: { objectKeys: ['avatars/d1/pic.jpg', 'avatars/someoneelse/pic.jpg'] },
    });
    expect(res.statusCode).toBe(200);
    const urls = res.json().urls;
    expect(urls['avatars/d1/pic.jpg']).toBeTruthy();
    // A stranger (no shared chat) must not get another user's avatar when that
    // user's default profilePhoto privacy is 'Contacts' (FINDING-1 regression).
    expect(urls['avatars/someoneelse/pic.jpg']).toBeUndefined();
  });

  it('honors profilePhoto=Everyone and denies when Nobody (FINDING-1, Req 4.9)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('owner') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('stranger') });

    // Owner opens their photo to everyone → a stranger can read it.
    await app!.inject({
      method: 'PUT',
      url: '/me/privacy',
      headers: auth('owner'),
      payload: {
        lastSeen: 'Contacts', profilePhoto: 'Everyone', statusVisibility: 'Everyone',
        groups: 'Contacts', calls: 'Contacts', readReceipts: true, disappearingMessages: true,
      },
    });
    let res = await app!.inject({
      method: 'POST', url: '/media/download-url', headers: auth('stranger'),
      payload: { objectKeys: ['avatars/owner/pic.jpg'] },
    });
    expect(res.json().urls['avatars/owner/pic.jpg']).toBeTruthy();

    // Owner locks it to nobody → the stranger is denied, but the owner still reads it.
    await app!.inject({
      method: 'PUT',
      url: '/me/privacy',
      headers: auth('owner'),
      payload: {
        lastSeen: 'Contacts', profilePhoto: 'Nobody', statusVisibility: 'Everyone',
        groups: 'Contacts', calls: 'Contacts', readReceipts: true, disappearingMessages: true,
      },
    });
    res = await app!.inject({
      method: 'POST', url: '/media/download-url', headers: auth('stranger'),
      payload: { objectKeys: ['avatars/owner/pic.jpg'] },
    });
    expect(res.json().urls['avatars/owner/pic.jpg']).toBeUndefined();

    res = await app!.inject({
      method: 'POST', url: '/media/download-url', headers: auth('owner'),
      payload: { objectKeys: ['avatars/owner/pic.jpg'] },
    });
    expect(res.json().urls['avatars/owner/pic.jpg']).toBeTruthy();
  });

  it('rejects path-traversal and malformed keys (FINDING-2)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('t1') });
    const res = await app!.inject({
      method: 'POST', url: '/media/download-url', headers: auth('t1'),
      payload: {
        objectKeys: [
          'avatars/t1/../someoneelse/pic.jpg',
          'avatars//pic.jpg',
          'secrets/t1/key.pem',
          'avatars/t1/pic.jpg', // the one legitimate key
        ],
      },
    });
    const urls = res.json().urls;
    expect(urls['avatars/t1/../someoneelse/pic.jpg']).toBeUndefined();
    expect(urls['avatars//pic.jpg']).toBeUndefined();
    expect(urls['secrets/t1/key.pem']).toBeUndefined();
    expect(urls['avatars/t1/pic.jpg']).toBeTruthy();
  });
});
