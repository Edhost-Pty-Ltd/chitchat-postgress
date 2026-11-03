// ─── Token verification cache ────────────────────────────────────────────────
// Verifying a Firebase ID token with checkRevoked=true costs a network
// round-trip to Google on EVERY request. For a chatty client that is the single
// biggest per-request latency source. This module caches the decoded token
// briefly (TTL from AUTH_TOKEN_CACHE_TTL_SEC) so repeat requests with the same
// token skip the round-trip, and separately remembers which user ids were
// recently upserted so the per-request `users` write is skipped too.
//
// Security note: a revoked/expired token can stay accepted for at most the TTL
// on the HTTP path. The socket handshake path opts out of the cache and always
// does a fresh checkRevoked verification. Companion device-removal is enforced
// independently on every request (the linked_devices check is not cached).

import { getEnv } from '../config/env.js';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Bound the cache so a flood of distinct tokens can't grow it unbounded. */
const MAX_ENTRIES = 10_000;

class TtlCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    // Evict the oldest entry when full (Map preserves insertion order).
    if (this.map.size >= MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

/** Shape stored for a verified token — the decoded claims we care about. */
export interface CachedDecoded {
  uid: string;
  phone_number?: string | null;
  companion?: boolean;
  deviceId?: string | null;
  provider?: string | null;
}

const decodedCache = new TtlCache<CachedDecoded>();
const upsertedUids = new TtlCache<true>();

function ttlMs(): number {
  return getEnv().AUTH_TOKEN_CACHE_TTL_SEC * 1000;
}

/** Return the cached decoded token, or undefined on miss/disabled/expired. */
export function getCachedDecoded(token: string): CachedDecoded | undefined {
  if (ttlMs() <= 0) return undefined;
  return decodedCache.get(token);
}

/** Cache a freshly decoded token for the configured TTL. */
export function cacheDecoded(token: string, decoded: CachedDecoded): void {
  decodedCache.set(token, decoded, ttlMs());
}

/** True when this uid's row was upserted within the TTL (skip the write). */
export function wasRecentlyUpserted(uid: string): boolean {
  if (ttlMs() <= 0) return false;
  return upsertedUids.get(uid) === true;
}

/** Record that a uid's row was just upserted. */
export function markUpserted(uid: string): void {
  upsertedUids.set(uid, true, ttlMs());
}

/** Test/shutdown helper: wipe both caches. */
export function clearTokenCaches(): void {
  decodedCache.clear();
  upsertedUids.clear();
}
