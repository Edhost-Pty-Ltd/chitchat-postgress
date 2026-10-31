import { describe, it, expect, beforeAll } from 'vitest';

// The guest-token module reads getEnv().MEET_GUEST_SECRET, so give it a value
// before importing anything that pulls in the env.
beforeAll(() => {
  process.env.MEET_GUEST_SECRET = 'test-secret-value';
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://x/x';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
  process.env.S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';
  process.env.S3_BUCKET = process.env.S3_BUCKET ?? 'b';
  process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID ?? 'a';
  process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY ?? 's';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? '{}';
});

describe('guest meeting tokens', () => {
  it('issues a token that verifies back to the same claims', async () => {
    const { issueGuestToken, verifyGuestToken } = await import('./guestToken.js');
    const { token, claims } = issueGuestToken('11111111-1111-1111-1111-111111111111', 'Alice');
    const back = verifyGuestToken(token);
    expect(back).not.toBeNull();
    expect(back!.meetingId).toBe('11111111-1111-1111-1111-111111111111');
    expect(back!.displayName).toBe('Alice');
    expect(back!.guestId).toBe(claims.guestId);
    expect(back!.guestId.startsWith('guest:')).toBe(true);
  });

  it('rejects a tampered token', async () => {
    const { issueGuestToken, verifyGuestToken } = await import('./guestToken.js');
    const { token } = issueGuestToken('22222222-2222-2222-2222-222222222222', 'Bob');
    const [body] = token.split('.');
    const tampered = `${body}.deadbeef`;
    expect(verifyGuestToken(tampered)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const { issueGuestToken, verifyGuestToken } = await import('./guestToken.js');
    const { token } = issueGuestToken('33333333-3333-3333-3333-333333333333', 'Carol', -10);
    expect(verifyGuestToken(token)).toBeNull();
  });

  it('rejects garbage / missing tokens', async () => {
    const { verifyGuestToken } = await import('./guestToken.js');
    expect(verifyGuestToken(undefined)).toBeNull();
    expect(verifyGuestToken('')).toBeNull();
    expect(verifyGuestToken('no-dot')).toBeNull();
    expect(verifyGuestToken('.sig')).toBeNull();
  });
});
