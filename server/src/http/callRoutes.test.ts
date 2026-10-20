import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Slice 4 call/meeting REST integration tests (Req 8). Needs Dev_Stack.
let available = false;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());
  process.env.DATABASE_URL = devStackUrls.DATABASE_URL;
  // Schema is migrated once by vitest globalSetup.

  const verifier = await import('../auth/verifier.js');
  const { upsertUserOnFirstContact } = await import('../db/repositories/users.js');
  vi.spyOn(verifier, 'verifyToken').mockImplementation(async (token) => {
    const m = /^token:(.+)$/.exec(typeof token === 'string' ? token : '');
    if (!m) throw new verifier.AuthError('AUTH_TOKEN_INVALID', 'bad');
    await upsertUserOnFirstContact(m[1], null);
    return { userId: m[1], firebaseUid: m[1], phoneNumber: null };
  });
  // Avoid requiring BullMQ for the ring-timeout scheduler during route tests.
  const queues = await import('../jobs/queues.js');
  vi.spyOn(queues, 'scheduleCallTimeout').mockResolvedValue();

  const { buildServer } = await import('./server.js');
  app = await buildServer();
});

afterEach(async () => {
  if (!available) return;
  const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      'TRUNCATE call_history, calls, meeting_messages, meeting_participants, meetings, blocked_users, users CASCADE',
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

const info = (uid: string) => ({ userId: uid, displayName: uid, photoUrl: null });

describe('Slice 4 calls', () => {
  it('creates a call record (Req 8.4)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('caller') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('callee') });
    const res = await app!.inject({
      method: 'POST',
      url: '/calls',
      headers: auth('caller'),
      payload: {
        callId: 'caller_callee_1',
        calleeId: 'callee',
        callerInfo: info('caller'),
        calleeInfo: info('callee'),
        type: 'audio',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a call from a blocked caller (Req 8.6, Property 7)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('c1') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('c2') });
    // c2 blocks c1.
    await app!.inject({ method: 'POST', url: '/blocks', headers: auth('c2'), payload: { userId: 'c1' } });

    const res = await app!.inject({
      method: 'POST',
      url: '/calls',
      headers: auth('c1'),
      payload: {
        callId: 'c1_c2_1',
        calleeId: 'c2',
        callerInfo: info('c1'),
        calleeInfo: info('c2'),
        type: 'video',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lists and clears call history, paginated (Req 8.11, 8.12, Property 3)', async () => {
    if (guard()) return;
    const { addCallHistory } = await import('../db/repositories/calls.js');
    await app!.inject({ method: 'GET', url: '/me', headers: auth('h1') });
    for (let i = 0; i < 3; i++) {
      await addCallHistory({
        userId: 'h1',
        callId: `call-${i}`,
        otherParty: info('other'),
        type: 'audio',
        direction: 'outgoing',
        status: 'completed',
        durationSec: 10,
      });
    }
    const page = await app!.inject({
      method: 'GET',
      url: '/calls/history?limit=2',
      headers: auth('h1'),
    });
    expect(page.json().items).toHaveLength(2);
    expect(page.json().nextCursor).toBeTruthy();

    const cleared = await app!.inject({ method: 'DELETE', url: '/calls/history', headers: auth('h1') });
    expect(cleared.statusCode).toBe(200);
    const after = await app!.inject({ method: 'GET', url: '/calls/history', headers: auth('h1') });
    expect(after.json().items).toHaveLength(0);
  });

  it('creates a meeting with the organizer as a participant and gates GET (Req 8.14)', async () => {
    if (guard()) return;
    await app!.inject({ method: 'GET', url: '/me', headers: auth('org') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('guest') });
    await app!.inject({ method: 'GET', url: '/me', headers: auth('stranger') });

    const created = await app!.inject({
      method: 'POST',
      url: '/meetings',
      headers: auth('org'),
      payload: { title: 'Standup', participants: ['guest'] },
    });
    expect(created.statusCode).toBe(201);
    const meetingId = created.json().meetingId;
    expect(created.json().state.participants).toEqual(expect.arrayContaining(['org', 'guest']));

    const asGuest = await app!.inject({ method: 'GET', url: `/meetings/${meetingId}`, headers: auth('guest') });
    expect(asGuest.statusCode).toBe(200);

    const asStranger = await app!.inject({
      method: 'GET',
      url: `/meetings/${meetingId}`,
      headers: auth('stranger'),
    });
    expect(asStranger.statusCode).toBe(403);
  });
});
