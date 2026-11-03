import { getAdminAuth } from './firebaseAdmin.js';
import { backfillPhoneIfRegistered } from '../db/repositories/users.js';
import { query } from '../db/pool.js';
import {
  getCachedDecoded,
  cacheDecoded,
  wasRecentlyUpserted,
  markUpserted,
} from './tokenCache.js';

/** Identity resolved from a verified Firebase ID token (Req 2.4). */
export interface AuthedIdentity {
  userId: string; // our Postgres users.id === firebase uid
  firebaseUid: string;
  phoneNumber: string | null;
  /**
   * True for a linked companion device. Companions sign in with a custom token
   * for the OWNER's uid plus `{ companion: true, deviceId }` claims, so they act
   * as the owner but owner-only actions (privacy, blocks, device removal, ...)
   * are refused for them.
   */
  isCompanion?: boolean;
  /** The companion's linked device id (from the custom-token claim). */
  deviceId?: string | null;
  /**
   * True for the temporary anonymous session a not-yet-linked device uses to
   * create and poll a link request. Anonymous identities are only accepted on
   * the device-link routes.
   */
  isAnonymous?: boolean;
  /**
   * True for a browser guest that joined a meeting via its public link. The
   * guest's `userId` is `guest:<uuid>` and it may ONLY act on `guestMeetingId`.
   */
  isGuest?: boolean;
  /** The single meeting a guest identity is allowed to participate in. */
  guestMeetingId?: string;
  /** Guest display name (browser participants enter this on the join screen). */
  displayName?: string;
}

/** Machine-readable auth error codes surfaced to clients (Req 2.5, 2.8). */
export type AuthErrorCode =
  | 'AUTH_TOKEN_MISSING'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_REVOKED'
  | 'AUTH_NOT_CONFIGURED';

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

function mapFirebaseError(err: unknown): AuthError {
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'auth/id-token-expired') {
    return new AuthError('AUTH_TOKEN_EXPIRED', 'Firebase ID token has expired');
  }
  if (code === 'auth/id-token-revoked' || code === 'auth/user-disabled') {
    return new AuthError('AUTH_TOKEN_REVOKED', 'Firebase ID token has been revoked');
  }
  // A missing/unreadable service-account file is a server configuration
  // problem, not a bad token — say so instead of blaming the client's token.
  if (code === 'ENOENT' || code === 'EACCES' || (err as Error)?.name === 'SyntaxError') {
    return new AuthError(
      'AUTH_NOT_CONFIGURED',
      'Server cannot verify sign-in: Firebase service account is missing or unreadable',
    );
  }
  return new AuthError('AUTH_TOKEN_INVALID', 'Firebase ID token is invalid');
}

interface DecodedToken {
  uid: string;
  phone_number?: string | null;
  companion?: boolean;
  deviceId?: string | null;
  provider?: string | null;
}

/** Does this owner still have the companion device linked? */
async function companionStillLinked(ownerId: string, deviceId: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM linked_devices WHERE owner_id = $1 AND device_id = $2', [
    ownerId,
    deviceId,
  ]);
  return res.rowCount! > 0;
}

/**
 * Verify a Firebase ID token and resolve the caller's identity (Req 2.4).
 *
 * This NEVER creates a user row. A phone-verified session only becomes an
 * account through POST /me/register, after the face step; until then the
 * account gate in requireAuth / the socket handshake treats it as
 * unregistered. For an existing row it backfills a missing phone number.
 * Anonymous link-request sessions are skipped entirely.
 * Companion sessions are rejected as revoked once their device is removed, so
 * removal takes effect on the companion's very next request.
 * Throws AuthError on any missing/malformed/expired/revoked token (Req 2.5).
 *
 * `verify`/`syncPhone`/`isLinked` are injectable so unit tests can run without
 * a live Firebase project.
 */
export async function verifyToken(
  token: string | undefined | null,
  deps: {
    verify?: (t: string) => Promise<DecodedToken>;
    syncPhone?: (id: string, phone: string | null) => Promise<void>;
    isLinked?: (ownerId: string, deviceId: string) => Promise<boolean>;
    upsert?: (userId: string, phone: string | null) => Promise<void>;
    /**
     * Whether the decoded-token cache and recent-upsert cache may be used
     * (default true). The socket handshake passes false so every new
     * connection does a fresh checkRevoked verification.
     */
    useCache?: boolean;
  } = {},
): Promise<AuthedIdentity> {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new AuthError('AUTH_TOKEN_MISSING', 'Missing authentication token');
  }

  // The cache is only consulted on the real verification path (no injected
  // deps) so unit tests with a stub `verify` always exercise it directly.
  const cacheable = useCacheEnabled(deps);

  const verify =
    deps.verify ??
    (async (t: string): Promise<DecodedToken> => {
      // checkRevoked = true so revoked tokens are rejected (Req 2.5).
      const decoded = await getAdminAuth().verifyIdToken(t, true);
      const claims = decoded as unknown as Record<string, unknown>;
      return {
        uid: decoded.uid,
        phone_number: decoded.phone_number ?? null,
        companion: claims.companion === true,
        deviceId: typeof claims.deviceId === 'string' ? claims.deviceId : null,
        provider: decoded.firebase?.sign_in_provider ?? null,
      };
    });

  let decoded: DecodedToken;
  const cached = cacheable ? getCachedDecoded(token) : undefined;
  if (cached) {
    decoded = cached;
  } else {
    try {
      decoded = await verify(token);
    } catch (err) {
      throw mapFirebaseError(err);
    }
    if (cacheable) cacheDecoded(token, decoded);
  }

  const isAnonymous = decoded.provider === 'anonymous';
  const isCompanion = decoded.companion === true;
  const deviceId = decoded.deviceId ?? null;

  if (isCompanion) {
    // A companion must carry the device id it was linked with, and that device
    // must still be linked to the owner. This check is NEVER cached so a device
    // removal takes effect on the companion's very next request.
    const isLinked = deps.isLinked ?? companionStillLinked;
    if (!deviceId || !(await isLinked(decoded.uid, deviceId))) {
      throw new AuthError('AUTH_TOKEN_REVOKED', 'This companion device has been removed');
    }
  }

  const phoneNumber = decoded.phone_number ?? null;
  if (!isAnonymous) {
    const upsert = deps.upsert ?? backfillPhoneIfRegistered;
    // Skip the per-request write when this uid was upserted within the TTL.
    if (!(cacheable && wasRecentlyUpserted(decoded.uid))) {
      try {
        await upsert(decoded.uid, phoneNumber);
      } catch {
        // Phone backfill is best-effort — a constraint violation or transient
        // DB error must never turn an otherwise valid token into a 500.
      }
      if (cacheable) markUpserted(decoded.uid);
    }
  }

  return {
    userId: decoded.uid,
    firebaseUid: decoded.uid,
    phoneNumber,
    isCompanion,
    deviceId,
    isAnonymous,
  };
}

function useCacheEnabled(deps: {
  verify?: unknown;
  upsert?: unknown;
  useCache?: boolean;
}): boolean {
  if (deps.useCache === false) return false;
  if (deps.verify || deps.upsert) return false;
  return true;
}

/** Extract a bearer token from an Authorization header value. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
