import { query, withTransaction } from '../pool.js';

export interface BroadcastList {
  id: string;
  name: string;
  recipients: string[];
  createdBy: string;
  createdAt: string;
  lastSentAt: string | null;
  lastMessage: string | null;
}

export async function listBroadcasts(ownerId: string): Promise<BroadcastList[]> {
  const res = await query<{
    id: string;
    name: string;
    owner_id: string;
    created_at: Date;
    last_sent_at: Date | null;
    last_message: string | null;
    recipients: string[];
  }>(
    `SELECT l.*, ARRAY(SELECT user_id FROM broadcast_recipients r WHERE r.list_id = l.id) AS recipients
       FROM broadcast_lists l WHERE l.owner_id = $1 ORDER BY l.created_at DESC`,
    [ownerId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    recipients: r.recipients,
    createdBy: r.owner_id,
    createdAt: r.created_at.toISOString(),
    lastSentAt: r.last_sent_at ? r.last_sent_at.toISOString() : null,
    lastMessage: r.last_message,
  }));
}

export async function createBroadcast(
  ownerId: string,
  name: string,
  recipients: string[],
): Promise<string> {
  return withTransaction(async (client) => {
    const res = await client.query<{ id: string }>(
      'INSERT INTO broadcast_lists (owner_id, name) VALUES ($1, $2) RETURNING id',
      [ownerId, name],
    );
    const listId = res.rows[0].id;
    for (const uid of Array.from(new Set(recipients))) {
      await client.query(
        'INSERT INTO broadcast_recipients (list_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [listId, uid],
      );
    }
    return listId;
  });
}

export async function ownsBroadcast(listId: string, ownerId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM broadcast_lists WHERE id = $1 AND owner_id = $2', [
    listId,
    ownerId,
  ]);
  return res.rowCount! > 0;
}

export async function updateBroadcast(
  listId: string,
  patch: { name?: string; recipients?: string[] },
): Promise<void> {
  await withTransaction(async (client) => {
    if (patch.name !== undefined) {
      await client.query('UPDATE broadcast_lists SET name = $2 WHERE id = $1', [listId, patch.name]);
    }
    if (patch.recipients !== undefined) {
      await client.query('DELETE FROM broadcast_recipients WHERE list_id = $1', [listId]);
      for (const uid of Array.from(new Set(patch.recipients))) {
        await client.query(
          'INSERT INTO broadcast_recipients (list_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [listId, uid],
        );
      }
    }
  });
}

export async function deleteBroadcast(listId: string): Promise<void> {
  await query('DELETE FROM broadcast_lists WHERE id = $1', [listId]);
}

export async function getRecipients(listId: string): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    'SELECT user_id FROM broadcast_recipients WHERE list_id = $1',
    [listId],
  );
  return res.rows.map((r) => r.user_id);
}

export async function recordSend(listId: string, message: string): Promise<void> {
  await query(
    'UPDATE broadcast_lists SET last_sent_at = now(), last_message = $2 WHERE id = $1',
    [listId, message.slice(0, 120)],
  );
}
