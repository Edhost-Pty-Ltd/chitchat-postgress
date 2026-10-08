import { getRedis } from '../redis/client.js';
import { redisKeys } from '../redis/keys.js';
import { query } from '../db/pool.js';

export const PRESENCE_TTL_SEC = 60; // Req 7.1
export const TYPING_TTL_SEC = 5; // Req 7.7

/**
 * Register a new socket for a user. Returns true when this is the user's first
 * socket (so presence transitioned offline→online) (Req 7.1, 7.3).
 */
export async function addSocket(userId: string, socketId: string): Promise<boolean> {
  const redis = getRedis();
  const added = await redis.sadd(redisKeys.presenceSockets(userId), socketId);
  await redis.set(redisKeys.presence(userId), '1', 'EX', PRESENCE_TTL_SEC);
  // Expire the socket set a bit after presence so it self-heals on crash.
  await redis.expire(redisKeys.presenceSockets(userId), PRESENCE_TTL_SEC * 2);
  const count = await redis.scard(redisKeys.presenceSockets(userId));
  return added === 1 && count === 1;
}

/**
 * Remove a socket for a user. Returns true when it was the user's last socket
 * (offline transition); also persists last_seen in Postgres (Req 7.3).
 */
export async function removeSocket(userId: string, socketId: string): Promise<boolean> {
  const redis = getRedis();
  await redis.srem(redisKeys.presenceSockets(userId), socketId);
  const count = await redis.scard(redisKeys.presenceSockets(userId));
  if (count === 0) {
    await redis.del(redisKeys.presence(userId));
    await query('UPDATE users SET last_seen = now() WHERE id = $1', [userId]);
    return true;
  }
  return false;
}

/** Refresh the presence TTL while a user has at least one socket (Req 7.2). */
export async function refreshPresence(userId: string): Promise<void> {
  const redis = getRedis();
  const count = await redis.scard(redisKeys.presenceSockets(userId));
  if (count > 0) {
    await redis.set(redisKeys.presence(userId), '1', 'EX', PRESENCE_TTL_SEC);
    await redis.expire(redisKeys.presenceSockets(userId), PRESENCE_TTL_SEC * 2);
  }
}

/** True when the user currently has a live presence key (Req 7.1, 7.10). */
export async function isOnline(userId: string): Promise<boolean> {
  const exists = await getRedis().exists(redisKeys.presence(userId));
  return exists === 1;
}

/** Set a typing key with a 5s TTL (Req 7.7). */
export async function setTyping(chatId: string, userId: string): Promise<void> {
  await getRedis().set(redisKeys.typing(chatId, userId), '1', 'EX', TYPING_TTL_SEC);
}

export async function clearTyping(chatId: string, userId: string): Promise<void> {
  await getRedis().del(redisKeys.typing(chatId, userId));
}

/**
 * Users who share at least one chat with `userId` — the audience for presence
 * and typing changes (Req 7.4).
 */
export async function chatPeers(userId: string): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    `SELECT DISTINCT other.user_id
       FROM chat_members mine
       JOIN chat_members other ON other.chat_id = mine.chat_id AND other.user_id <> mine.user_id
      WHERE mine.user_id = $1`,
    [userId],
  );
  return res.rows.map((r) => r.user_id);
}
