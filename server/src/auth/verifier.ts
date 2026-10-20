import { getAdminAuth } from './firebaseAdmin.js';
import { upsertUserOnFirstContact } from '../db/repositories/users.js';
import { query } from '../db/pool.js';

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
 * On first contact, upserts the user row keyed by firebase uid (Req 2.6) —
 * except for anonymous link-request sessions, which never get a user row.
 * Companion sessions are rejected as revoked once their device is removed, so
 * removal takes effect on the companion's very next request.
 * Throws AuthError on any missing/malformed/expired/revoked token (Req 2.5).
 *
 * `verify`/`upsert`/`isLinked` are injectable so unit tests can run without a
 * live Firebase project.
 */
export async function verifyToken(
  token: string | undefined | null,
  deps: {
    verify?: (t: string) => Promise<DecodedToken>;
    upsert?: (id: string, phone: string | null) => Promise<void>;
    isLinked?: (ownerId: string, deviceId: string) => Promise<boolean>;
  } = {},
): Promise<AuthedIdentity> {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new AuthError('AUTH_TOKEN_MISSING', 'Missing authentication token');
  }

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
  try {
    decoded = await verify(token);
  } catch (err) {
    throw mapFirebaseError(err);
  }

  const isAnonymous = decoded.provider === 'anonymous';
  const isCompanion = decoded.companion === true;
  const deviceId = decoded.deviceId ?? null;

  if (isCompanion) {
    // A companion must carry the device id it was linked with, and that device
    // must still be linked to the owner.
    const isLinked = deps.isLinked ?? companionStillLinked;
    if (!deviceId || !(await isLinked(decoded.uid, deviceId))) {
      throw new AuthError('AUTH_TOKEN_REVOKED', 'This companion device has been removed');
    }
  }

  const phoneNumber = decoded.phone_number ?? null;
  if (!isAnonymous) {
    const upsert = deps.upsert ?? upsertUserOnFirstContact;
    await upsert(decoded.uid, phoneNumber);
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

/** Extract a bearer token from an Authorization header value. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
