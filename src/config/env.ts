// ─── App environment configuration ──────────────────────────────────────────
// Reads the backend URLs from EXPO_PUBLIC_* variables. These are inlined at
// build time by Expo, so they must be referenced as static property accesses
// on process.env (not computed), per the Expo docs for public env variables.

/** Base URL of the REST API (Req 3.2). */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

/** URL of the Socket.IO gateway (Req 3.2). Falls back to API_URL when unset. */
export const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL ?? API_URL;

/**
 * Public web app that hosts the meeting room. A meeting opens in the browser at
 * `${MEET_URL_BASE}/meet/<meetingId>`. The server embeds the same link in the
 * invite card; this constant is used for the organizer's own "Join"/share path.
 */
export const MEET_URL_BASE =
  process.env.EXPO_PUBLIC_MEET_URL_BASE ?? 'https://chitchatbusiness.com';

/** Build the browser join link for a meeting id. */
export function meetingJoinUrl(meetingId: string): string {
  return `${MEET_URL_BASE.replace(/\/+$/, '')}/meet/${meetingId}`;
}

/**
 * Base URL of the standalone Django facial-recognition service (separate from
 * the Node REST API). Defaults to the Node API host on port 8000 for local dev
 * so a single LAN IP change doesn't desync them; override with
 * EXPO_PUBLIC_FACE_API_URL when the service is deployed elsewhere.
 */
export const FACE_API_URL =
  process.env.EXPO_PUBLIC_FACE_API_URL ??
  API_URL.replace(/:(\d+)(\/*)$/, ':8000').replace(/\/+$/, '') ??
  '';

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
    console.error(
      '[env] Missing EXPO_PUBLIC_SOCKET_URL and EXPO_PUBLIC_API_URL.',
    );
  }
}
