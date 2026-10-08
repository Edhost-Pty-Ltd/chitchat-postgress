import { Redis } from 'ioredis';
import { getEnv } from '../config/env.js';

let general: Redis | null = null;
let pub: Redis | null = null;
let sub: Redis | null = null;

/** Shared Redis connection for presence, typing, rate limits, buffers. */
export function getRedis(): Redis {
  if (!general) general = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return general;
}

/** Dedicated publisher connection for the Socket.IO Redis adapter (Req 5.16). */
export function getPubClient(): Redis {
  if (!pub) pub = new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
  return pub;
}

/** Dedicated subscriber connection for the Socket.IO Redis adapter (Req 5.16). */
export function getSubClient(): Redis {
  if (!sub) sub = getPubClient().duplicate();
  return sub;
}

/** True when Redis answers PING. Used by /health (Req 1.8, 1.9). */
export async function pingRedis(): Promise<boolean> {
  try {
    const res = await getRedis().ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}

/** Close all Redis connections during graceful shutdown (Req 12.7). */
export async function closeRedis(): Promise<void> {
  await Promise.all(
    [general, pub, sub].map(async (c) => {
      if (c) {
        try {
          await c.quit();
        } catch {
          c.disconnect();
        }
      }
    }),
  );
  general = pub = sub = null;
}
