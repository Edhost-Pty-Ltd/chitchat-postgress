import { getAdminAuth } from './firebaseAdmin.js';
import { upsertUserOnFirstContact } from '../db/repositories/users.js';

/** Identity resolved from a verified Firebase ID token (Req 2.4). */
export interface AuthedIdentity {
  userId: string; // our Postgres users.id === firebase uid
  firebaseUid: string;
  phoneNumber: string | null;
}

/** Machine-readable auth error codes surfaced to clients (Req 2.5, 2.8). */
export type AuthErrorCode =
  | 'AUTH_TOKEN_MISSING'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_TOKEN_REVOKED';

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
  return new AuthError('AUTH_TOKEN_INVALID', 'Firebase ID token is invalid');
}

/**
 * Verify a Firebase ID token and resolve the caller's identity (Req 2.4).
 * On first contact, upserts the user row keyed by firebase uid (Req 2.6).
 * Throws AuthError on any missing/malformed/expired/revoked token (Req 2.5).
 *
 * `verifyFn` is injectable so unit tests can run without a live Firebase project.
 */
export async function verifyToken(
  token: string | undefined | null,
  deps: {
    verify?: (t: string) => Promise<{ uid: string; phone_number?: string | null }>;
    upsert?: (id: string, phone: string | null) => Promise<void>;
  } = {},
): Promise<AuthedIdentity> {
  if (!token || typeof token !== 'string' || token.trim() === '') {
    throw new AuthError('AUTH_TOKEN_MISSING', 'Missing authentication token');
  }

  const verify =
    deps.verify ??
    (async (t: string) => {
      // checkRevoked = true so revoked tokens are rejected (Req 2.5).
      const decoded = await getAdminAuth().verifyIdToken(t, true);
      return { uid: decoded.uid, phone_number: decoded.phone_number ?? null };
    });

  let decoded: { uid: string; phone_number?: string | null };
  try {
    decoded = await verify(token);
  } catch (err) {
    throw mapFirebaseError(err);
  }

  const phoneNumber = decoded.phone_number ?? null;
  const upsert = deps.upsert ?? upsertUserOnFirstContact;
  await upsert(decoded.uid, phoneNumber);

  return { userId: decoded.uid, firebaseUid: decoded.uid, phoneNumber };
}

/** Extract a bearer token from an Authorization header value. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
