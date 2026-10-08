import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Slice 5 status + broadcast integration tests (Req 9). Needs Dev_Stack.
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
  const queues = await import('../jobs/queues.js');
  vi.spyOn(queues, 'enqueueMessagePush').mockResolvedValue();

  const { buildServer } = await import('./server.js');
  app = await buildServer();
});

afterEach(async () => {
  if (!available) return;
  const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      'TRUNCATE status_views, status_visibility_users, statuses, broadcast_recipients, broadcast_lists, message_receipts, messages, chat_members, chats, blocked_users, users CASCADE',
    );
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
async function ensure(uid: string) {
  await app!.inject({ method: 'GET', url: '/me', headers: auth(uid) });
}

describe('Slice 5 statuses', () => {
  it('posts a status with a 24h TTL and returns it to the owner (Req 9.1, Property 1)', async () => {
    if (guard()) return;
    await ensure('s1');
    const res = await app!.inject({
      method: 'POST',
      url: '/statuses',
      headers: auth('s1'),
      payload: { mediaType: 'text', caption: 'hello', visibility: 'everyone' },
    });
    expect(res.statusCode).toBe(201);
    const statusId = res.json().statusId;

    const list = await app!.inject({ method: 'GET', url: '/statuses', headers: auth('s1') });
    const mine = list.json().myStatuses;
    expect(mine).toHaveLength(1);
    const ttl = new Date(mine[0].expiresAt).getTime() - new Date(mine[0].createdAt).getTime();
    expect(Math.round(ttl / 3600000)).toBe(24);
    expect(mine[0].statusId).toBe(statusId);
  });

  it('enforces "only" visibility (Property 15)', async () => {
    if (guard()) return;
    await ensure('owner');
    await ensure('allowed');
    await ensure('denied');
    await app!.inject({
      method: 'POST',
      url: '/statuses',
      headers: auth('owner'),
      payload: { mediaType: 'text', caption: 'secret', visibility: 'only', selectedUsers: ['allowed'] },
    });

    const asAllowed = await app!.inject({ method: 'GET', url: '/statuses', headers: auth('allowed') });
    const allowedSees = asAllowed.json().contactStatuses.flatMap((g: { statuses: unknown[] }) => g.statuses);
    expect(allowedSees).toHaveLength(1);

    const asDenied = await app!.inject({ method: 'GET', url: '/statuses', headers: auth('denied') });
    const deniedSees = asDenied.json().contactStatuses.flatMap((g: { statuses: unknown[] }) => g.statuses);
    expect(deniedSees).toHaveLength(0);
  });

  it('enforces "except" visibility (Property 15)', async () => {
    if (guard()) return;
    await ensure('o2');
    await ensure('ex');
    await ensure('other');
    await app!.inject({
      method: 'POST',
      url: '/statuses',
      headers: auth('o2'),
      payload: { mediaType: 'text', caption: 'x', visibility: 'except', excludedUsers: ['ex'] },
    });
    const exSees = (await app!.inject({ method: 'GET', url: '/statuses', headers: auth('ex') }))
      .json().contactStatuses.flatMap((g: { statuses: unknown[] }) => g.statuses);
    expect(exSees).toHaveLength(0);
    const otherSees = (await app!.inject({ method: 'GET', url: '/statuses', headers: auth('other') }))
      .json().contactStatuses.flatMap((g: { statuses: unknown[] }) => g.statuses);
    expect(otherSees).toHaveLength(1);
  });

  it('records a view and marks the viewer (Req 9.3)', async () => {
    if (guard()) return;
    await ensure('vo');
    await ensure('viewer');
    const posted = await app!.inject({
      method: 'POST',
      url: '/statuses',
      headers: auth('vo'),
      payload: { mediaType: 'text', caption: 'v', visibility: 'everyone' },
    });
    const statusId = posted.json().statusId;
    await app!.inject({ method: 'POST', url: `/statuses/${statusId}/view`, headers: auth('viewer') });

    const own = await app!.inject({ method: 'GET', url: '/statuses', headers: auth('vo') });
    expect(own.json().myStatuses[0].viewedBy).toContain('viewer');
  });

  it('deletes a status only for its owner (Req 9.5)', async () => {
    if (guard()) return;
    await ensure('d1');
    await ensure('d2');
    const posted = await app!.inject({
      method: 'POST',
      url: '/statuses',
      headers: auth('d1'),
      payload: { mediaType: 'text', caption: 'del', visibility: 'everyone' },
    });
    const statusId = posted.json().statusId;
    const asOther = await app!.inject({ method: 'DELETE', url: `/statuses/${statusId}`, headers: auth('d2') });
    expect(asOther.statusCode).toBe(403);
    const asOwner = await app!.inject({ method: 'DELETE', url: `/statuses/${statusId}`, headers: auth('d1') });
    expect(asOwner.statusCode).toBe(200);
  });
});

describe('Slice 5 broadcasts', () => {
  it('sends one message per non-blocking recipient and skips blockers (Property 16)', async () => {
    if (guard()) return;
    await ensure('bsender');
    await ensure('r1');
    await ensure('r2');
    // r2 blocks the sender.
    await app!.inject({ method: 'POST', url: '/blocks', headers: auth('r2'), payload: { userId: 'bsender' } });

    const list = await app!.inject({
      method: 'POST',
      url: '/broadcasts',
      headers: auth('bsender'),
      payload: { name: 'VIPs', recipients: ['r1', 'r2'] },
    });
    const listId = list.json().id;

    const send = await app!.inject({
      method: 'POST',
      url: `/broadcasts/${listId}/send`,
      headers: auth('bsender'),
      payload: { type: 'text', text: 'promo' },
    });
    expect(send.statusCode).toBe(200);
    expect(send.json().sent).toBe(1);
    expect(send.json().skipped).toContain('r2');

    // r1 received a chat with the message; r2 did not.
    const r1chats = await app!.inject({ method: 'GET', url: '/chats', headers: auth('r1') });
    expect(r1chats.json().chats).toHaveLength(1);
    const r2chats = await app!.inject({ method: 'GET', url: '/chats', headers: auth('r2') });
    expect(r2chats.json().chats).toHaveLength(0);
  });

  it('restricts broadcast edits to the owner (Req 9.6)', async () => {
    if (guard()) return;
    await ensure('own');
    await ensure('intruder');
    const list = await app!.inject({
      method: 'POST',
      url: '/broadcasts',
      headers: auth('own'),
      payload: { name: 'List', recipients: [] },
    });
    const listId = list.json().id;
    const res = await app!.inject({
      method: 'PATCH',
      url: `/broadcasts/${listId}`,
      headers: auth('intruder'),
      payload: { name: 'Hacked' },
    });
    expect(res.statusCode).toBe(403);
  });
});
