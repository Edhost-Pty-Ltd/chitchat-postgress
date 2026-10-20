import { getRedis } from '../redis/client.js';
import { redisKeys } from '../redis/keys.js';

export const CALL_BUFFER_TTL_SEC = 60; // Req 8.8

/**
 * Buffer a signaling payload (offer or ICE) for a callee that has not joined
 * the call room yet, for up to 60s (Req 8.8).
 */
export async function bufferSignal(callId: string, signal: unknown): Promise<void> {
  const redis = getRedis();
  const key = redisKeys.callBuffer(callId);
  await redis.rpush(key, JSON.stringify(signal));
  await redis.expire(key, CALL_BUFFER_TTL_SEC);
}

/** Drain and return all buffered signals for a call (Req 8.8). */
export async function flushBuffer(callId: string): Promise<unknown[]> {
  const redis = getRedis();
  const key = redisKeys.callBuffer(callId);
  const items = await redis.lrange(key, 0, -1);
  await redis.del(key);
  return items.map((i) => JSON.parse(i));
}
