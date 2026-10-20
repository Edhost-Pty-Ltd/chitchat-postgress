import { shouldRefresh, getFreshIdToken, type IdTokenSource } from '../token';

// Feature: firebase-to-sockets-redis-postgres-migration, Property 25:
// Token refresh threshold — refresh iff the token is expired or within 5 min
// of expiry.

describe('shouldRefresh', () => {
  const now = 1_000_000_000_000;

  it('refreshes when expiry is unknown', () => {
    expect(shouldRefresh(null, now)).toBe(true);
  });

  it('refreshes when already expired', () => {
    expect(shouldRefresh(now - 1, now)).toBe(true);
  });

  it('refreshes when within 5 minutes of expiry', () => {
    expect(shouldRefresh(now + 5 * 60 * 1000, now)).toBe(true);
    expect(shouldRefresh(now + 4 * 60 * 1000, now)).toBe(true);
  });

  it('does not refresh when more than 5 minutes remain', () => {
    expect(shouldRefresh(now + 5 * 60 * 1000 + 1, now)).toBe(false);
    expect(shouldRefresh(now + 60 * 60 * 1000, now)).toBe(false);
  });
});

describe('getFreshIdToken', () => {
  const now = 1_000_000_000_000;

  function source(expiry: number | null): IdTokenSource & { forced: boolean[] } {
    const forced: boolean[] = [];
    return {
      forced,
      getExpiry: async () => expiry,
      getToken: async (force: boolean) => {
        forced.push(force);
        return force ? 'fresh-token' : 'cached-token';
      },
    };
  }

  it('forces a refresh when near expiry', async () => {
    const s = source(now + 60 * 1000);
    const token = await getFreshIdToken(s, now);
    expect(token).toBe('fresh-token');
    expect(s.forced).toEqual([true]);
  });

  it('uses the cached token when far from expiry', async () => {
    const s = source(now + 60 * 60 * 1000);
    const token = await getFreshIdToken(s, now);
    expect(token).toBe('cached-token');
    expect(s.forced).toEqual([false]);
  });
});
