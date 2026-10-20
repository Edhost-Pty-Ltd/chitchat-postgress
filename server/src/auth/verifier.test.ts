import { describe, it, expect, vi } from 'vitest';
import { verifyToken, parseBearer, AuthError } from './verifier.js';

// Feature: firebase-to-sockets-redis-postgres-migration, Property 6:
// Authorization uses the verified identity (body-supplied ids are ignored by
// resolving identity solely from the token). verifyToken is the single source
// of the authenticated userId; handlers consume its result, never request bodies.

describe('parseBearer', () => {
  it('extracts the token from a Bearer header', () => {
    expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(parseBearer('bearer abc')).toBe('abc');
  });
  it('returns null for missing or malformed headers', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('Token abc')).toBeNull();
    expect(parseBearer('')).toBeNull();
  });
});

describe('verifyToken', () => {
  const upsert = vi.fn(async () => {});

  it('resolves identity from the token and upserts on first contact', async () => {
    const verify = vi.fn(async () => ({ uid: 'user-123', phone_number: '+15550001' }));
    const id = await verifyToken('valid', { verify, upsert });
    expect(id).toEqual({
      userId: 'user-123',
      firebaseUid: 'user-123',
      phoneNumber: '+15550001',
      isCompanion: false,
      deviceId: null,
      isAnonymous: false,
    });
    expect(upsert).toHaveBeenCalledWith('user-123', '+15550001');
  });

  it('ignores any user id a caller might supply elsewhere — identity comes only from the token', async () => {
    const verify = vi.fn(async () => ({ uid: 'real-user', phone_number: null }));
    const id = await verifyToken('valid', { verify, upsert });
    // Even though a malicious body could claim userId "attacker", the resolved
    // identity is strictly the token's uid.
    expect(id.userId).toBe('real-user');
    expect(id.userId).not.toBe('attacker');
  });

  it('rejects a missing token with AUTH_TOKEN_MISSING', async () => {
    await expect(verifyToken('', { upsert })).rejects.toMatchObject({
      code: 'AUTH_TOKEN_MISSING',
    });
    await expect(verifyToken(undefined, { upsert })).rejects.toBeInstanceOf(AuthError);
  });

  it('maps expired tokens to AUTH_TOKEN_EXPIRED', async () => {
    const verify = vi.fn(async () => {
      throw { code: 'auth/id-token-expired' };
    });
    await expect(verifyToken('x', { verify, upsert })).rejects.toMatchObject({
      code: 'AUTH_TOKEN_EXPIRED',
    });
  });

  it('maps revoked tokens to AUTH_TOKEN_REVOKED', async () => {
    const verify = vi.fn(async () => {
      throw { code: 'auth/id-token-revoked' };
    });
    await expect(verifyToken('x', { verify, upsert })).rejects.toMatchObject({
      code: 'AUTH_TOKEN_REVOKED',
    });
  });

  it('maps any other verification failure to AUTH_TOKEN_INVALID', async () => {
    const verify = vi.fn(async () => {
      throw new Error('bad signature');
    });
    await expect(verifyToken('x', { verify, upsert })).rejects.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });
});
