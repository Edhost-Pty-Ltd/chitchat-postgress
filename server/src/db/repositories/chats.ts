import { query, withTransaction } from '../pool.js';

export type ChatType = 'direct' | 'group';

export interface ChatSummary {
  chatId: string;
  type: ChatType;
  groupName: string | null;
  groupPhotoObjectKey: string | null;
  members: string[];
  lastMessage: string | null;
  lastSenderId: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
  role: 'admin' | 'member';
}

/** The two member ids sorted and joined → a stable key for a direct chat. */
export function directKey(a: string, b: string): string {
  return [a, b].sort().join(':');
}

/** True when userId is a member of chatId (authorization gate, Req 5.5). */
export async function isMember(chatId: string, userId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2', [
    chatId,
    userId,
  ]);
  return res.rowCount! > 0;
}

export async function isAdmin(chatId: string, userId: string): Promise<boolean> {
  const res = await query(
    "SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2 AND role = 'admin'",
    [chatId, userId],
  );
  return res.rowCount! > 0;
}

export async function getMembers(chatId: string): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    'SELECT user_id FROM chat_members WHERE chat_id = $1',
    [chatId],
  );
  return res.rows.map((r) => r.user_id);
}

/** Create or fetch the direct chat between two users (Req 5.1). */
export async function getOrCreateDirectChat(a: string, b: string): Promise<string> {
  const key = directKey(a, b);
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM chats WHERE direct_key = $1',
      [key],
    );
    if (existing.rows[0]) return existing.rows[0].id;

    const created = await client.query<{ id: string }>(
      `INSERT INTO chats (type, direct_key, created_by) VALUES ('direct', $1, $2)
       ON CONFLICT (direct_key) DO UPDATE SET direct_key = EXCLUDED.direct_key
       RETURNING id`,
      [key, a],
    );
    const chatId = created.rows[0].id;
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')
       ON CONFLICT DO NOTHING`,
      [chatId, a, b],
    );
    return chatId;
  });
}

/** Create a group chat with the creator as admin (Req 5.12). */
export async function createGroupChat(
  creatorId: string,
  memberIds: string[],
  groupName: string,
  groupPhotoObjectKey: string | null,
): Promise<string> {
  const members = Array.from(new Set([creatorId, ...memberIds]));
  return withTransaction(async (client) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO chats (type, group_name, group_photo_object_key, created_by)
       VALUES ('group', $1, $2, $3) RETURNING id`,
      [groupName, groupPhotoObjectKey, creatorId],
    );
    const chatId = created.rows[0].id;
    for (const uid of members) {
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [chatId, uid, uid === creatorId ? 'admin' : 'member'],
      );
    }
    return chatId;
  });
}

export interface GroupPatch {
  groupName?: string | null;
  groupPhotoObjectKey?: string | null;
  addMembers?: string[];
  removeMembers?: string[];
}

/** Edit group metadata/members (admin-only enforced by the route, Req 5.13). */
export async function updateGroup(chatId: string, patch: GroupPatch): Promise<void> {
  await withTransaction(async (client) => {
    if (patch.groupName !== undefined || patch.groupPhotoObjectKey !== undefined) {
      await client.query(
        `UPDATE chats SET
           group_name = COALESCE($2, group_name),
           group_photo_object_key = COALESCE($3, group_photo_object_key)
         WHERE id = $1 AND type = 'group'`,
        [chatId, patch.groupName ?? null, patch.groupPhotoObjectKey ?? null],
      );
    }
    for (const uid of patch.addMembers ?? []) {
      await client.query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [chatId, uid],
      );
    }
    for (const uid of patch.removeMembers ?? []) {
      await client.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [
        chatId,
        uid,
      ]);
    }
  });
}

/**
 * The authenticated user's chat list with last message, per-chat unread and
 * members (Req 5.11). Total unread is the sum of per-chat unread counts.
 */
export async function listChats(userId: string): Promise<ChatSummary[]> {
  const res = await query<{
    id: string;
    type: ChatType;
    group_name: string | null;
    group_photo_object_key: string | null;
    last_message_text: string | null;
    last_message_sender_id: string | null;
    last_message_at: Date | null;
    unread_count: number;
    role: 'admin' | 'member';
    members: string[];
  }>(
    `SELECT c.id, c.type, c.group_name, c.group_photo_object_key,
            c.last_message_text, c.last_message_sender_id, c.last_message_at,
            cm.unread_count, cm.role,
            ARRAY(SELECT user_id FROM chat_members m WHERE m.chat_id = c.id) AS members
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
      ORDER BY c.last_message_at DESC NULLS LAST`,
    [userId],
  );
  return res.rows.map((r) => ({
    chatId: r.id,
    type: r.type,
    groupName: r.group_name,
    groupPhotoObjectKey: r.group_photo_object_key,
    members: r.members,
    lastMessage: r.last_message_text,
    lastSenderId: r.last_message_sender_id,
    lastMessageAt: r.last_message_at ? r.last_message_at.toISOString() : null,
    unreadCount: r.unread_count,
    role: r.role,
  }));
}

export async function totalUnread(userId: string): Promise<number> {
  const res = await query<{ total: string }>(
    'SELECT COALESCE(SUM(unread_count), 0)::bigint AS total FROM chat_members WHERE user_id = $1',
    [userId],
  );
  return Number(res.rows[0].total);
}
