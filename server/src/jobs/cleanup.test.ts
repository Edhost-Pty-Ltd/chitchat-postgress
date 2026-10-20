import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Client } from 'pg';
import { devStackAvailable, devStackUrls, testEnv } from '../test/devStack.js';

// Slice 7 cleanup job integration tests (Req 11). Needs Dev_Stack Postgres.
let available = false;
let client: Client;

async function seedUser(id: string) {
  await client.query('INSERT INTO users (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
}

beforeAll(async () => {
  available = await devStackAvailable();
  if (!available) return;
  Object.assign(process.env, testEnv());
  process.env.DATABASE_URL = devStackUrls.DATABASE_URL;
  // Object deletion is enqueued, not performed inline; stub the queue.
  const queues = await import('./queues.js');
  vi.spyOn(queues, 'enqueueDeleteObject').mockResolvedValue();

  client = new Client({ connectionString: devStackUrls.DATABASE_URL });
  await client.connect();
});

afterEach(async () => {
  if (!available) return;
  await client.query('TRUNCATE statuses, message_receipts, messages, chat_members, chats, calls, users CASCADE');
});

afterAll(async () => {
  if (!available) return;
  await client.end();
  const { closePool } = await import('../db/pool.js');
  const { closeRedis } = await import('../redis/client.js');
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

describe('Slice 7 cleanup jobs', () => {
  it('deletes expired statuses and enqueues their media (Req 11.1)', async () => {
    if (guard()) return;
    await seedUser('cu1');
    // One expired (with media), one fresh.
    await client.query(
      `INSERT INTO statuses (user_id, media_type, media_object_key, visibility, expires_at)
       VALUES ('cu1', 'image', 'status/cu1/old.jpg', 'everyone', now() - interval '1 hour')`,
    );
    await client.query(
      `INSERT INTO statuses (user_id, media_type, visibility, expires_at)
       VALUES ('cu1', 'text', 'everyone', now() + interval '1 hour')`,
    );

    const queues = await import('./queues.js');
    const { runStatusCleanup } = await import('./cleanup.js');
    const result = await runStatusCleanup();

    expect(result.rows).toBe(1);
    expect(result.objects).toBe(1);
    expect(queues.enqueueDeleteObject).toHaveBeenCalledWith('status/cu1/old.jpg');

    const remaining = await client.query('SELECT count(*)::int AS n FROM statuses');
    expect(remaining.rows[0].n).toBe(1);
  });

  it('deletes expired messages and enqueues their media + thumbnails (Req 11.2)', async () => {
    if (guard()) return;
    await seedUser('cu2');
    const chat = await client.query(
      "INSERT INTO chats (type, created_by) VALUES ('group', 'cu2') RETURNING id",
    );
    const chatId = chat.rows[0].id;
    await client.query(
      `INSERT INTO messages (chat_id, sender_id, type, media_object_key, thumbnail_object_key, expires_at)
       VALUES ($1, 'cu2', 'video', 'chats/x/media/v.mp4', 'chats/x/media/t.jpg', now() - interval '1 minute')`,
      [chatId],
    );
    await client.query(
      `INSERT INTO messages (chat_id, sender_id, type, expires_at)
       VALUES ($1, 'cu2', 'text', now() + interval '72 hours')`,
      [chatId],
    );

    const { runMessageCleanup } = await import('./cleanup.js');
    const result = await runMessageCleanup();
    expect(result.rows).toBe(1);
    expect(result.objects).toBe(2); // media + thumbnail

    const remaining = await client.query('SELECT count(*)::int AS n FROM messages');
    expect(remaining.rows[0].n).toBe(1);
  });

  it('deletes calls not updated within the stale threshold (Req 11.3)', async () => {
    if (guard()) return;
    await seedUser('caller');
    await seedUser('callee');
    const mk = (id: string, ageHours: number) =>
      client.query(
        `INSERT INTO calls (id, caller_id, callee_id, caller_info, callee_info, type, status, updated_at)
         VALUES ($1, 'caller', 'callee', '{}', '{}', 'audio', 'ended', now() - ($2 || ' hours')::interval)`,
        [id, String(ageHours)],
      );
    await mk('old-call', 4); // older than 3h → stale
    await mk('recent-call', 1); // within 3h → kept

    const { runStaleCallCleanup } = await import('./cleanup.js');
    const result = await runStaleCallCleanup();
    expect(result.rows).toBe(1);

    const kept = await client.query('SELECT id FROM calls');
    expect(kept.rows.map((r) => r.id)).toEqual(['recent-call']);
  });

  it('does not delete rows that have not yet expired', async () => {
    if (guard()) return;
    await seedUser('cu3');
    await client.query(
      `INSERT INTO statuses (user_id, media_type, visibility, expires_at)
       VALUES ('cu3', 'text', 'everyone', now() + interval '12 hours')`,
    );
    const { runStatusCleanup } = await import('./cleanup.js');
    const result = await runStatusCleanup();
    expect(result.rows).toBe(0);
    const remaining = await client.query('SELECT count(*)::int AS n FROM statuses');
    expect(remaining.rows[0].n).toBe(1);
  });
});
