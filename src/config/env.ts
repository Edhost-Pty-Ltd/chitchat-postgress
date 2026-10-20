// ─── App environment configuration ──────────────────────────────────────────
// Reads the backend URLs from EXPO_PUBLIC_* variables. These are inlined at
// build time by Expo, so they must be referenced as static property accesses
// on process.env (not computed), per the Expo docs for public env variables.
// (Verify against the installed Expo SDK per AGENTS.md.)

/** Base URL of the REST API (Req 3.2). */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

/** URL of the Socket.IO gateway (Req 3.2). Falls back to API_URL when unset. */
export const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL ?? API_URL;

/**
 * Validate presence of required env vars at startup. Logs an error naming any
 * missing variable rather than throwing, so the app still mounts (Req 3.3).
 */
export function assertEnv(): void {
  if (!API_URL) {
    console.error(
      '[env] Missing EXPO_PUBLIC_API_URL — the backend API client will not work. ' +
        'Set it in .env (see server/.env.example for the backend side).',
    );
  }
  if (!process.env.EXPO_PUBLIC_SOCKET_URL && !API_URL) {
    console.error('[env] Missing EXPO_PUBLIC_SOCKET_URL and EXPO_PUBLIC_API_URL.');
  }
}
