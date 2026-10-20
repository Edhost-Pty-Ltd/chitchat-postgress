import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Slice 3 presence/typing integration tests (Req 7). Needs Dev_Stack Postgres+Redis.
let available = false;

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());
  process.env.DATABASE_URL = devStackUrls.DATABASE_URL;
  // Schema is migrated once by vitest globalSetup.
});

afterEach(async () => {
  if (!available) return;
  const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
  try {
    await client.query('TRUNCATE message_receipts, messages, chat_members, chats, users CASCADE');
  } finally {
    await client.end();
  }
});

afterAll(async () => {
  if (!available) return;
  const { getRedis, closeRedis } = await import('../redis/client.js');
  // Clean presence/typing keys to avoid cross-test bleed.
  const redis = getRedis();
  const keys = await redis.keys('presence:*');
  const tkeys = await redis.keys('typing:*');
  if (keys.length) await redis.del(...keys);
  if (tkeys.length) await redis.del(...tkeys);
  const { closePool } = await import('../db/pool.js');
  await closePool();
  await closeRedis();
});

const guard = () => {
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn('[skip] Dev_Stack not reachable (docker compose up -d)');
    return true;
  }
  return false;
};

describe('presence transitions', () => {
  it('first socket marks online; last socket marks offline and persists last_seen (Req 7.1, 7.3)', async () => {
    if (guard()) return;
    const { upsertUserOnFirstContact } = await import('../db/repositories/users.js');
    const presence = await import('./presence.js');
    await upsertUserOnFirstContact('p1', null);

    const firstA = await presence.addSocket('p1', 'sockA');
    expect(firstA).toBe(true);
    expect(await presence.isOnline('p1')).toBe(true);

    // Second socket is not a new online transition.
    const firstB = await presence.addSocket('p1', 'sockB');
    expect(firstB).toBe(false);

    // Removing one socket keeps the user online.
    const lastA = await presence.removeSocket('p1', 'sockA');
    expect(lastA).toBe(false);
    expect(await presence.isOnline('p1')).toBe(true);

    // Removing the last socket marks offline and persists last_seen.
    const lastB = await presence.removeSocket('p1', 'sockB');
    expect(lastB).toBe(true);
    expect(await presence.isOnline('p1')).toBe(false);

    const client = new Client({ connectionString: devStackUrls.DATABASE_URL });
    await client.connect();
    try {
      const res = await client.query('SELECT last_seen FROM users WHERE id = $1', ['p1']);
      expect(res.rows[0].last_seen).not.toBeNull();
    } finally {
      await client.end();
    }
  });

  it('typing keys exist briefly and clear (Req 7.7)', async () => {
    if (guard()) return;
    const presence = await import('./presence.js');
    const { getRedis } = await import('../redis/client.js');
    const { redisKeys } = await import('../redis/keys.js');

    await presence.setTyping('chatX', 'p2');
    expect(await getRedis().exists(redisKeys.typing('chatX', 'p2'))).toBe(1);
    const ttl = await getRedis().ttl(redisKeys.typing('chatX', 'p2'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(presence.TYPING_TTL_SEC);

    await presence.clearTyping('chatX', 'p2');
    expect(await getRedis().exists(redisKeys.typing('chatX', 'p2'))).toBe(0);
  });

  it('chatPeers returns users who share a chat (Req 7.4)', async () => {
    if (guard()) return;
    const { upsertUserOnFirstContact } = await import('../db/repositories/users.js');
    const { getOrCreateDirectChat } = await import('../db/repositories/chats.js');
    const presence = await import('./presence.js');

    await upsertUserOnFirstContact('q1', null);
    await upsertUserOnFirstContact('q2', null);
    await upsertUserOnFirstContact('q3', null);
    await getOrCreateDirectChat('q1', 'q2');

    const peers = await presence.chatPeers('q1');
    expect(peers).toContain('q2');
    expect(peers).not.toContain('q3');
    expect(peers).not.toContain('q1');
  });
});
