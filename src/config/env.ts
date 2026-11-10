// ─── App environment configuration ──────────────────────────────────────────
// Reads the backend URLs from EXPO_PUBLIC_* variables. These are inlined at
// build time by Expo, so they must be referenced as static property accesses
// on process.env (not computed), per the Expo docs for public env variables.

/** Base URL of the REST API (Req 3.2). */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

export const SOCKET_URL = process.env.EXPO_PUBLIC_SOCKET_URL ?? API_URL;

/**
 * @deprecated Use meetingJoinUrl() directly. This export is kept for
 * backward-compatibility but evaluates lazily now.
 */
export const MEET_URL_BASE = process.env.EXPO_PUBLIC_MEET_URL_BASE ?? API_URL;

/**
 * Build the external browser join link for a meeting.
 *
 * The link always points to the API server's /meet/:id route, which serves
 * the standalone meet.html page. This means:
 *  - The meeting opens OUTSIDE the Expo app in a real browser tab
 *  - It works on all platforms (mobile app, web app, invitation cards)
 *  - No SPA routing needed — it's a real server-side route
 *
 * Set EXPO_PUBLIC_MEET_URL_BASE in .env.local to override (e.g. when the API
 * is on a different host than the default API_URL).
 */
export function meetingJoinUrl(meetingId: string): string {
  // Use the explicit override if set
  const base = process.env.EXPO_PUBLIC_MEET_URL_BASE
    ? process.env.EXPO_PUBLIC_MEET_URL_BASE.replace(/\/+$/, '')
    : API_URL.replace(/\/+$/, '');   // default: same host as the API

  if (!base) return '';
  return `${base}/meet/${encodeURIComponent(meetingId)}`;
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
