// src/utils/trackProfileView.ts
//
// Records a profile view via the backend REST API (POST /profile-views).
//
// Running the increment server-side:
//   - Prevents client-side inflation — the server owns the counter write and
//     enforces one increment per call; the caller cannot forge the result.
//   - Resets today's counter on day rollover and ignores self-views, matching
//     the behavior of the old recordProfileView Cloud Function.
//
// Debounced per-viewer per-day by the AsyncStorage guard in ChatScreen.

import { endpoints } from '../api/endpoints';

export async function trackProfileView(viewedUid: string): Promise<void> {
  if (!viewedUid) return;
  try {
    await endpoints.recordProfileView(viewedUid);
  } catch (err) {
    console.warn('[trackProfileView] failed:', err);
  }
}
