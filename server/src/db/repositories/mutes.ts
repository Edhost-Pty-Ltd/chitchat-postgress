import { query } from '../pool.js';

/**
 * Server-side chat mute state (chat_mutes). Pins/favourites remain device-local
 * in the app; mute lives here so the Push_Dispatcher can skip muted recipients.
 */

export async function listMutedChats(userId: string): Promise<string[]> {
  const res = await query<{ chat_id: string }>(
    'SELECT chat_id FROM chat_mutes WHERE user_id = $1',
    [userId],
  );
  return res.rows.map((r) => r.chat_id);
}

export async function setChatMuted(chatId: string, userId: string, muted: boolean): Promise<void> {
  if (muted) {
    await query(
      'INSERT INTO chat_mutes (chat_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [chatId, userId],
    );
  } else {
    await query('DELETE FROM chat_mutes WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  }
}

export async function isChatMuted(chatId: string, userId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM chat_mutes WHERE chat_id = $1 AND user_id = $2', [
    chatId,
    userId,
  ]);
  return res.rowCount! > 0;
}

/** Of the given users, which have muted this chat (used by the push dispatcher). */
export async function mutedBy(chatId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const res = await query<{ user_id: string }>(
    'SELECT user_id FROM chat_mutes WHERE chat_id = $1 AND user_id = ANY($2::text[])',
    [chatId, userIds],
  );
  return new Set(res.rows.map((r) => r.user_id));
}
