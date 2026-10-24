import { Redis, type RedisOptions } from 'ioredis';
import { getEnv } from '../config/env.js';

let general: Redis | null = null;
let pub: Redis | null = null;
let sub: Redis | null = null;

/**
 * Base ioredis options. TLS is enabled when REDIS_TLS=true or the URL already
 * uses the `rediss://` scheme (ElastiCache in-transit encryption). `rejectUnauthorized`
 * stays on so the certificate chain is verified.
 */
function redisOptions(): RedisOptions {
  const env = getEnv();
  const useTls = env.REDIS_TLS || env.REDIS_URL.startsWith('rediss://');
  return {
    maxRetriesPerRequest: null,
    ...(useTls ? { tls: {} } : {}),
  };
}

/** Shared Redis connection for presence, typing, rate limits, buffers. */
export function getRedis(): Redis {
  if (!general) general = new Redis(getEnv().REDIS_URL, redisOptions());
  return general;
}

/** Dedicated publisher connection for the Socket.IO Redis adapter (Req 5.16). */
export function getPubClient(): Redis {
  if (!pub) pub = new Redis(getEnv().REDIS_URL, redisOptions());
  return pub;
}

/** Dedicated subscriber connection for the Socket.IO Redis adapter (Req 5.16). */
export function getSubClient(): Redis {
  if (!sub) sub = getPubClient().duplicate();
  return sub;
}

/**
 * Connection options for BullMQ (host/port/password parsed from REDIS_URL),
 * with TLS applied the same way as the shared clients. BullMQ requires
 * `maxRetriesPerRequest: null`.
 */
export function bullConnection(): RedisOptions {
  const env = getEnv();
  const url = new URL(env.REDIS_URL);
  const useTls = env.REDIS_TLS || url.protocol === 'rediss:';
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
    ...(useTls ? { tls: {} } : {}),
  };
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
