import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Slice 2 message flow integration tests (Req 5). Needs Dev_Stack Postgres+Redis.
let available = false;
let app: FastifyInstance | undefined;

async function reset(): Promise<void> {
  const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      'TRUNCATE message_receipts, messages, chat_members, chats, push_tokens, blocked_users, privacy_settings, users CASCADE',
    );
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
    const m = /^token:(.+)$/.exec(typeof token === 'string' ? token : '');
    if (!m) throw new verifier.AuthError('AUTH_TOKEN_INVALID', 'bad');
    await upsertUserOnFirstContact(m[1], null);
    return { userId: m[1], firebaseUid: m[1], phoneNumber: null };
  });

  // Avoid requiring a running BullMQ/Redis queue worker during route tests.
  const queues = await import('../jobs/queues.js');
  vi.spyOn(queues, 'enqueueMessagePush').mockResolvedValue();

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

async function directChat(a: string, b: string): Promise<string> {
  await app!.inject({ method: 'GET', url: '/me', headers: auth(a) });
  await app!.inject({ method: 'GET', url: '/me', headers: auth(b) });
  const res = await app!.inject({
    method: 'POST',
    url: '/chats',
    headers: auth(a),
    payload: { type: 'direct', members: [b] },
  });
  return res.json().chatId as string;
}

describe('Slice 2 messages', () => {
  it('sends a message with a 72h TTL (Req 5.3, Property 1)', async () => {
    if (guard()) return;
    const chat = await directChat('a1', 'a2');
    const res = await app!.inject({
      method: 'POST',
      url: `/chats/${chat}/messages`,
      headers: auth('a1'),
      payload: { type: 'text', text: 'hi' },
    });
    expect(res.statusCode).toBe(201);
    const m = res.json().message;
    const ttl = new Date(m.expiresAt).getTime() - new Date(m.createdAt).getTime();
    expect(Math.round(ttl / 3600000)).toBe(72);
  });

  it('is idempotent on clientId (Property 4)', async () => {
    if (guard()) return;
    const chat = await directChat('b1', 'b2');
    const payload = { type: 'text', text: 'once', clientId: 'c-123' };
    const first = await app!.inject({ method: 'POST', url: `/chats/${chat}/messages`, headers: auth('b1'), payload });
    const second = await app!.inject({ method: 'POST', url: `/chats/${chat}/messages`, headers: auth('b1'), payload });
    expect(first.json().message.id).toBe(second.json().message.id);
    expect(second.statusCode).toBe(200);

    const list = await app!.inject({ method: 'GET', url: `/chats/${chat}/messages`, headers: auth('b1') });
    expect(list.json().messages.filter((x: { text: string }) => x.text === 'once')).toHaveLength(1);
  });

  it('rejects non-members from reading or writing (Property 5)', async () => {
    if (guard()) return;
    const chat = await directChat('c1', 'c2');
    await app!.inject({ method: 'GET', url: '/me', headers: auth('intruder') });
    const read = await app!.inject({ method: 'GET', url: `/chats/${chat}/messages`, headers: auth('intruder') });
    expect(read.statusCode).toBe(403);
    const write = await app!.inject({
      method: 'POST',
      url: `/chats/${chat}/messages`,
      headers: auth('intruder'),
      payload: { type: 'text', text: 'x' },
    });
    expect(write.statusCode).toBe(403);
  });

  it('paginates in descending order with a bounded page size (Property 3)', async () => {
    if (guard()) return;
    const chat = await directChat('d1', 'd2');
    for (let i = 0; i < 5; i++) {
      await app!.inject({
        method: 'POST',
        url: `/chats/${chat}/messages`,
        headers: auth('d1'),
        payload: { type: 'text', text: `m${i}` },
      });
    }
    const page1 = await app!.inject({
      method: 'GET',
      url: `/chats/${chat}/messages?limit=2`,
      headers: auth('d1'),
    });
    const body1 = page1.json();
    expect(body1.messages).toHaveLength(2);
    expect(body1.messages[0].text).toBe('m4'); // newest first
    expect(body1.nextCursor).toBeTruthy();

    const seen = new Set<string>(body1.messages.map((m: { id: string }) => m.id));
    let cursor = body1.nextCursor;
    while (cursor) {
      const next = await app!.inject({
        method: 'GET',
        url: `/chats/${chat}/messages?limit=2&cursor=${encodeURIComponent(cursor)}`,
        headers: auth('d1'),
      });
      const body = next.json();
      for (const m of body.messages) seen.add(m.id);
      cursor = body.nextCursor;
    }
    expect(seen.size).toBe(5); // every message exactly once
  });

  it('records delivered and read receipts (Property 9) and clears unread', async () => {
    if (guard()) return;
    const chat = await directChat('e1', 'e2');
    const sent = await app!.inject({
      method: 'POST',
      url: `/chats/${chat}/messages`,
      headers: auth('e1'),
      payload: { type: 'text', text: 'read me' },
    });
    const msgId = sent.json().message.id;

    const { markDelivered, markRead } = await import('../db/repositories/messages.js');
    const sender = await markDelivered(msgId, 'e2');
    expect(sender).toBe('e1');
    await markRead(chat, 'e2', [msgId]);

    const list = await app!.inject({ method: 'GET', url: `/chats/${chat}/messages`, headers: auth('e1') });
    const m = list.json().messages.find((x: { id: string }) => x.id === msgId);
    expect(m.deliveredTo).toContain('e2');
    expect(m.readBy).toContain('e2');

    const chats = await app!.inject({ method: 'GET', url: '/chats', headers: auth('e2') });
    const summary = chats.json().chats.find((c: { chatId: string }) => c.chatId === chat);
    expect(summary.unreadCount).toBe(0);
  });

  it('excludes blocked-sender messages from unread counts (Property 8)', async () => {
    if (guard()) return;
    const chat = await directChat('f1', 'f2');
    // f2 blocks f1.
    await app!.inject({ method: 'POST', url: '/blocks', headers: auth('f2'), payload: { userId: 'f1' } });

    await app!.inject({
      method: 'POST',
      url: `/chats/${chat}/messages`,
      headers: auth('f1'),
      payload: { type: 'text', text: 'blocked content' },
    });

    const chats = await app!.inject({ method: 'GET', url: '/chats', headers: auth('f2') });
    const summary = chats.json().chats.find((c: { chatId: string }) => c.chatId === chat);
    expect(summary.unreadCount).toBe(0);
  });

  it('fetches messages after a given id for reconnect (Req 5.18)', async () => {
    if (guard()) return;
    const chat = await directChat('g1', 'g2');
    const first = await app!.inject({
      method: 'POST',
      url: `/chats/${chat}/messages`,
      headers: auth('g1'),
      payload: { type: 'text', text: 'first' },
    });
    const firstId = first.json().message.id;
    await app!.inject({
      method: 'POST',
      url: `/chats/${chat}/messages`,
      headers: auth('g1'),
      payload: { type: 'text', text: 'second' },
    });

    const after = await app!.inject({
      method: 'GET',
      url: `/chats/${chat}/messages?after=${firstId}`,
      headers: auth('g2'),
    });
    const texts = after.json().messages.map((m: { text: string }) => m.text);
    expect(texts).toEqual(['second']);
  });

  it('rejects invalid send bodies with 400 (Property 23)', async () => {
    if (guard()) return;
    const chat = await directChat('h1', 'h2');
    const res = await app!.inject({
      method: 'POST',
      url: `/chats/${chat}/messages`,
      headers: auth('h1'),
      payload: { type: 'not-a-type', text: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});
