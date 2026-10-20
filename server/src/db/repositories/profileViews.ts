import { query, withTransaction } from '../pool.js';

export interface ProfileViewCounters {
  profileViews: number;
  profileViewsToday: number;
  updatedAt: string | null;
}

function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Atomically record one profile view of `viewedId` by `viewerId`, mirroring the
 * old recordProfileView Cloud Function: lifetime counter always increments;
 * today's counter resets when the stored day key rolls over. Self-views are
 * ignored. Also writes an audit row into profile_views.
 */
export async function recordProfileView(viewedId: string, viewerId: string): Promise<void> {
  if (!viewedId || viewedId === viewerId) return;
  const key = dayKey();
  await withTransaction(async (client) => {
    const cur = await client.query<{ profile_views_day_key: string | null }>(
      'SELECT profile_views_day_key FROM users WHERE id = $1 FOR UPDATE',
      [viewedId],
    );
    if (cur.rowCount === 0) return; // unknown user — nothing to do
    const sameDay = cur.rows[0].profile_views_day_key === key;
    await client.query(
      `UPDATE users SET
         profile_views           = profile_views + 1,
         profile_views_today     = ${sameDay ? 'profile_views_today + 1' : '1'},
         profile_views_day_key   = $2,
         profile_views_updated_at = now()
       WHERE id = $1`,
      [viewedId, key],
    );
    await client.query(
      'INSERT INTO profile_views (viewed_id, viewer_id) VALUES ($1, $2)',
      [viewedId, viewerId],
    );
  });
}

/** Read a user's profile-view counters, resetting today's count on day rollover. */
export async function getProfileViewCounters(userId: string): Promise<ProfileViewCounters> {
  const res = await query<{
    profile_views: number;
    profile_views_today: number;
    profile_views_day_key: string | null;
    profile_views_updated_at: Date | null;
  }>(
    `SELECT profile_views, profile_views_today, profile_views_day_key, profile_views_updated_at
       FROM users WHERE id = $1`,
    [userId],
  );
  const row = res.rows[0];
  if (!row) return { profileViews: 0, profileViewsToday: 0, updatedAt: null };
  const today = row.profile_views_day_key === dayKey() ? row.profile_views_today : 0;
  return {
    profileViews: row.profile_views ?? 0,
    profileViewsToday: today,
    updatedAt: row.profile_views_updated_at ? row.profile_views_updated_at.toISOString() : null,
  };
}
