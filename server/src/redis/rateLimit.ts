import { getRedis } from './client.js';
import { redisKeys } from './keys.js';

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * Fixed-window per-user rate limit backed by Redis (Req 12.3, 12.4).
 * Increments a counter keyed by user+action with a window TTL; the first
 * request in a window sets the expiry. Returns Retry-After when exceeded.
 */
export async function checkRateLimit(
  userId: string,
  action: string,
  limit: number,
  windowSec: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  const key = redisKeys.rateLimit(userId, action);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, windowSec);
  }
  if (count > limit) {
    const ttl = await redis.ttl(key);
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : windowSec };
  }
  return { allowed: true, retryAfterSec: 0 };
}
