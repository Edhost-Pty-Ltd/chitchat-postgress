// ─── Firebase ID token provider ──────────────────────────────────────────────
// Supplies a fresh Firebase ID token for the API_Client and Socket_Client.
// Refreshes the token when it is already expired or within 5 minutes of expiry
// (Req 2.3, Property 25).
//
// The token-reading function is injectable so this logic is unit-testable
// without a live Firebase project.

const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes (Req 2.3)

export interface IdTokenSource {
  /** ms since epoch when the current token expires, or null if unknown. */
  getExpiry(): Promise<number | null>;
  /** Return the ID token, forcing a refresh when `force` is true. */
  getToken(force: boolean): Promise<string | null>;
}

/**
 * Decide whether a refresh is needed, then return a token.
 * Returns null when there is no signed-in user.
 */
export async function getFreshIdToken(
  source: IdTokenSource,
  now: number = Date.now(),
): Promise<string | null> {
  const expiry = await source.getExpiry();
  const mustRefresh = expiry == null || expiry - now <= REFRESH_THRESHOLD_MS;
  return source.getToken(mustRefresh);
}

/** Pure predicate exposed for testing (Property 25). */
export function shouldRefresh(expiryMs: number | null, now: number = Date.now()): boolean {
  return expiryMs == null || expiryMs - now <= REFRESH_THRESHOLD_MS;
}

/**
 * Default source backed by @react-native-firebase/auth. Imported lazily so the
 * pure helpers above can be unit-tested without pulling in native modules.
 */
export function createFirebaseTokenSource(): IdTokenSource {
  return {
    async getExpiry() {
      const { getAuth } = await import('@react-native-firebase/auth');
      const user = getAuth().currentUser;
      if (!user) return null;
      const result = await user.getIdTokenResult();
      return result?.expirationTime ? new Date(result.expirationTime).getTime() : null;
    },
    async getToken(force: boolean) {
      const { getAuth } = await import('@react-native-firebase/auth');
      const user = getAuth().currentUser;
      if (!user) return null;
      return user.getIdToken(force);
    },
  };
}
