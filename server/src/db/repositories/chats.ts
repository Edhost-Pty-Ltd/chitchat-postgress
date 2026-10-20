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
  /** This user's "clear chat" cutoff (messages at/before it are hidden for them). */
  clearedAt: string | null;
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

/**
 * True when `a` and `b` share at least one chat. This is the backend's
 * definition of "contact" for privacy decisions (it matches the 'contacts'
 * branch of listVisibleStatuses). Used to gate Contacts-scoped resources such
 * as profile-photo reads (Req 4.4).
 */
export async function sharesChatWith(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const res = await query(
    `SELECT 1 FROM chat_members m1
       JOIN chat_members m2 ON m1.chat_id = m2.chat_id
      WHERE m1.user_id = $1 AND m2.user_id = $2
      LIMIT 1`,
    [a, b],
  );
  return res.rowCount! > 0;
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
      // Re-added members are no longer "past" members.
      await client.query('DELETE FROM chat_past_members WHERE chat_id = $1 AND user_id = $2', [
        chatId,
        uid,
      ]);
    }
    for (const uid of patch.removeMembers ?? []) {
      await removeMemberTx(client, chatId, uid);
    }
  });
}

/** Remove a member and remember them as a past member of the group. */
async function removeMemberTx(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number | null }> },
  chatId: string,
  userId: string,
): Promise<void> {
  const res = await client.query('DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2', [
    chatId,
    userId,
  ]);
  if ((res.rowCount ?? 0) > 0) {
    await client.query(
      `INSERT INTO chat_past_members (chat_id, user_id, display_name)
       SELECT $1, u.id, COALESCE(u.display_name, u.phone_number) FROM users u WHERE u.id = $2
       ON CONFLICT (chat_id, user_id) DO UPDATE
         SET left_at = now(), display_name = EXCLUDED.display_name`,
      [chatId, userId],
    );
  }
}

/** A member leaves a group themselves (no admin rights needed). */
export async function leaveChat(chatId: string, userId: string): Promise<void> {
  await withTransaction(async (client) => {
    // If the last admin leaves, hand admin to the longest-standing member.
    const role = await client.query<{ role: string }>(
      'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );
    await removeMemberTx(client, chatId, userId);
    if (role.rows[0]?.role === 'admin') {
      const admins = await client.query(
        "SELECT 1 FROM chat_members WHERE chat_id = $1 AND role = 'admin'",
        [chatId],
      );
      if ((admins.rowCount ?? 0) === 0) {
        await client.query(
          `UPDATE chat_members SET role = 'admin'
            WHERE chat_id = $1 AND user_id = (
              SELECT user_id FROM chat_members WHERE chat_id = $1 ORDER BY joined_at ASC LIMIT 1
            )`,
          [chatId],
        );
      }
    }
  });
}

export interface PastMember {
  userId: string;
  displayName: string | null;
  leftAt: string;
}

export async function listPastMembers(chatId: string): Promise<PastMember[]> {
  const res = await query<{ user_id: string; display_name: string | null; left_at: Date }>(
    'SELECT user_id, display_name, left_at FROM chat_past_members WHERE chat_id = $1 ORDER BY left_at DESC',
    [chatId],
  );
  return res.rows.map((r) => ({
    userId: r.user_id,
    displayName: r.display_name,
    leftAt: r.left_at.toISOString(),
  }));
}

/** Was this user ever a member (current or past)? Used to authorize past-member reads. */
export async function wasMember(chatId: string, userId: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2
     UNION ALL
     SELECT 1 FROM chat_past_members WHERE chat_id = $1 AND user_id = $2`,
    [chatId, userId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Per-user "clear chat": hide everything up to now for this user only. */
export async function clearChatForUser(chatId: string, userId: string): Promise<string> {
  const res = await query<{ cleared_at: Date }>(
    `UPDATE chat_members SET cleared_at = now(), unread_count = 0
      WHERE chat_id = $1 AND user_id = $2 RETURNING cleared_at`,
    [chatId, userId],
  );
  return (res.rows[0]?.cleared_at ?? new Date()).toISOString();
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
    cleared_at: Date | null;
  }>(
    `SELECT c.id, c.type, c.group_name, c.group_photo_object_key,
            c.last_message_text, c.last_message_sender_id, c.last_message_at,
            cm.unread_count, cm.role, cm.cleared_at,
            ARRAY(SELECT user_id FROM chat_members m WHERE m.chat_id = c.id) AS members
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
      ORDER BY c.last_message_at DESC NULLS LAST`,
    [userId],
  );
  return res.rows.map((r) => {
    // Hide a preview the user already cleared.
    const cleared =
      r.cleared_at !== null && r.last_message_at !== null && r.last_message_at <= r.cleared_at;
    return {
      chatId: r.id,
      type: r.type,
      groupName: r.group_name,
      groupPhotoObjectKey: r.group_photo_object_key,
      members: r.members,
      lastMessage: cleared ? null : r.last_message_text,
      lastSenderId: cleared ? null : r.last_message_sender_id,
      lastMessageAt: r.last_message_at ? r.last_message_at.toISOString() : null,
      unreadCount: r.unread_count,
      role: r.role,
      clearedAt: r.cleared_at ? r.cleared_at.toISOString() : null,
    };
  });
}

export async function totalUnread(userId: string): Promise<number> {
  const res = await query<{ total: string }>(
    'SELECT COALESCE(SUM(unread_count), 0)::bigint AS total FROM chat_members WHERE user_id = $1',
    [userId],
  );
  return Number(res.rows[0].total);
}
