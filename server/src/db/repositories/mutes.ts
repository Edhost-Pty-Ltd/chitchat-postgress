import { query } from '../pool.js';

/**
 * Server-side chat mute state (chat_mutes). Pins/favourites remain device-local
 * in the app; mute lives here so the Push_Dispatcher can skip muted recipients.
 *
 * A mute can expire: `muted_until` is the instant it lapses (NULL = "Always").
 * Reads treat a row whose `muted_until` is in the past as no longer muted and
 * opportunistically delete it, so notifications resume on their own.
 */

const ACTIVE = '(muted_until IS NULL OR muted_until > now())';

export async function listMutedChats(userId: string): Promise<string[]> {
  // Opportunistically clear this user's lapsed mutes, then return active ones.
  await query(
    'DELETE FROM chat_mutes WHERE user_id = $1 AND muted_until IS NOT NULL AND muted_until <= now()',
    [userId],
  );
  const res = await query<{ chat_id: string }>(
    `SELECT chat_id FROM chat_mutes WHERE user_id = $1 AND ${ACTIVE}`,
    [userId],
  );
  return res.rows.map((r) => r.chat_id);
}

/**
 * Mute or unmute a chat for a user. When muting, `mutedUntil` is the instant the
 * mute should lapse; pass `null` (the default) for an indefinite ("Always")
 * mute. Re-muting an already-muted chat overwrites the previous expiry.
 */
export async function setChatMuted(
  chatId: string,
  userId: string,
  muted: boolean,
  mutedUntil: Date | null = null,
): Promise<void> {
  if (muted) {
    await query(
      `INSERT INTO chat_mutes (chat_id, user_id, muted_until) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET muted_until = EXCLUDED.muted_until`,
      [chatId, userId, mutedUntil],
    );
  } else {
    await query('DELETE FROM chat_mutes WHERE chat_id = $1 AND user_id = $2', [chatId, userId]);
  }
}

export async function isChatMuted(chatId: string, userId: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM chat_mutes WHERE chat_id = $1 AND user_id = $2 AND ${ACTIVE}`,
    [chatId, userId],
  );
  return res.rowCount! > 0;
}

/** Of the given users, which have an active mute on this chat (push dispatcher). */
export async function mutedBy(chatId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const res = await query<{ user_id: string }>(
    `SELECT user_id FROM chat_mutes WHERE chat_id = $1 AND user_id = ANY($2::text[]) AND ${ACTIVE}`,
    [chatId, userIds],
  );
  return new Set(res.rows.map((r) => r.user_id));
}
