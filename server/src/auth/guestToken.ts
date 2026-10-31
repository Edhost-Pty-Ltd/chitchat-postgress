import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../config/env.js';

/**
 * ─── Meeting guest tokens ────────────────────────────────────────────────────
 * Browser participants who open a meeting link have no Firebase account. We mint
 * a short-lived, HMAC-signed token (no external JWT dependency) that is scoped
 * to a SINGLE meeting. The Socket.IO gateway accepts it as a guest identity, and
 * the meeting handlers let that guest act only on the meeting the token names.
 *
 * The token is NOT a bearer key for anything else: it carries only a random
 * guest id, the meeting id, a display name, and an expiry. It cannot be used to
 * call REST endpoints that require a real user, read other meetings, or act on
 * any meeting other than the one it was issued for.
 */

export interface GuestClaims {
  /** Stable per-session guest id, e.g. "guest:ab12…". */
  guestId: string;
  meetingId: string;
  displayName: string;
  /** Seconds since epoch when the token expires. */
  exp: number;
}

const GUEST_PREFIX = 'guest:';
// Guests get a generous window so a meeting can run its course on one token.
const DEFAULT_TTL_SEC = 6 * 60 * 60; // 6 hours

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', getEnv().MEET_GUEST_SECRET).update(payload).digest('base64url');
}

/** Issue a signed guest token for one meeting. */
export function issueGuestToken(
  meetingId: string,
  displayName: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): { token: string; claims: GuestClaims } {
  const claims: GuestClaims = {
    guestId: `${GUEST_PREFIX}${randomUUID()}`,
    meetingId,
    displayName: displayName.slice(0, 80),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
  const body = b64url(JSON.stringify(claims));
  const token = `${body}.${sign(body)}`;
  return { token, claims };
}

/** Verify a guest token; returns its claims or null when invalid/expired. */
export function verifyGuestToken(token: string | undefined | null): GuestClaims | null {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = sign(body);
  // Constant-time compare; lengths must match for timingSafeEqual.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let claims: GuestClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as GuestClaims;
  } catch {
    return null;
  }
  if (
    !claims ||
    typeof claims.guestId !== 'string' ||
    !claims.guestId.startsWith(GUEST_PREFIX) ||
    typeof claims.meetingId !== 'string' ||
    typeof claims.exp !== 'number'
  ) {
    return null;
  }
  if (claims.exp * 1000 <= Date.now()) return null;
  return claims;
}

export function isGuestId(userId: string | null | undefined): boolean {
  return !!userId && userId.startsWith(GUEST_PREFIX);
}
