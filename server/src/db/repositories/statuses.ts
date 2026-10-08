import { query, withTransaction } from '../pool.js';

export type StatusVisibility = 'everyone' | 'contacts' | 'except' | 'only';
export type StatusMediaType = 'image' | 'video' | 'text';

export interface StatusInput {
  displayName: string | null;
  userPhone: string | null;
  mediaObjectKey: string | null;
  thumbnailObjectKey: string | null;
  mediaType: StatusMediaType;
  caption: string | null;
  backgroundColor: string | null;
  textColor: string | null;
  durationMs: number | null;
  visibility: StatusVisibility;
  excludedUsers?: string[];
  selectedUsers?: string[];
}

export interface StatusRecord {
  statusId: string;
  userId: string;
  displayName: string | null;
  userPhone: string | null;
  mediaObjectKey: string | null;
  thumbnailObjectKey: string | null;
  mediaType: StatusMediaType;
  caption: string | null;
  backgroundColor: string | null;
  textColor: string | null;
  durationMs: number | null;
  visibility: StatusVisibility;
  createdAt: string;
  expiresAt: string;
  viewedBy: string[];
}

export const STATUS_TTL_MS = 24 * 60 * 60 * 1000; // 24h (Req 9.1)

export async function createStatus(userId: string, input: StatusInput): Promise<string> {
  const expiresAt = new Date(Date.now() + STATUS_TTL_MS);
  return withTransaction(async (client) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO statuses
         (user_id, display_name, user_phone, media_object_key, thumbnail_object_key,
          media_type, caption, background_color, text_color, duration_ms, visibility, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [
        userId,
        input.displayName,
        input.userPhone,
        input.mediaObjectKey,
        input.thumbnailObjectKey,
        input.mediaType,
        input.caption,
        input.backgroundColor,
        input.textColor,
        input.durationMs,
        input.visibility,
        expiresAt,
      ],
    );
    const statusId = res.rows[0].id;

    if (input.visibility === 'except') {
      for (const uid of input.excludedUsers ?? []) {
        await client.query(
          `INSERT INTO status_visibility_users (status_id, user_id, mode)
           VALUES ($1, $2, 'except') ON CONFLICT DO NOTHING`,
          [statusId, uid],
        );
      }
    } else if (input.visibility === 'only') {
      for (const uid of input.selectedUsers ?? []) {
        await client.query(
          `INSERT INTO status_visibility_users (status_id, user_id, mode)
           VALUES ($1, $2, 'only') ON CONFLICT DO NOTHING`,
          [statusId, uid],
        );
      }
    }
    return statusId;
  });
}

interface StatusDbRow {
  id: string;
  user_id: string;
  display_name: string | null;
  user_phone: string | null;
  media_object_key: string | null;
  thumbnail_object_key: string | null;
  media_type: StatusMediaType;
  caption: string | null;
  background_color: string | null;
  text_color: string | null;
  duration_ms: number | null;
  visibility: StatusVisibility;
  created_at: Date;
  expires_at: Date;
}

function rowToRecord(r: StatusDbRow, viewedBy: string[]): StatusRecord {
  return {
    statusId: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    userPhone: r.user_phone,
    mediaObjectKey: r.media_object_key,
    thumbnailObjectKey: r.thumbnail_object_key,
    mediaType: r.media_type,
    caption: r.caption,
    backgroundColor: r.background_color,
    textColor: r.text_color,
    durationMs: r.duration_ms,
    visibility: r.visibility,
    createdAt: r.created_at.toISOString(),
    expiresAt: r.expires_at.toISOString(),
    viewedBy,
  };
}

async function attachViews(statusIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (statusIds.length === 0) return map;
  const res = await query<{ status_id: string; viewer_id: string }>(
    'SELECT status_id, viewer_id FROM status_views WHERE status_id = ANY($1::uuid[])',
    [statusIds],
  );
  for (const r of res.rows) {
    const arr = map.get(r.status_id) ?? [];
    arr.push(r.viewer_id);
    map.set(r.status_id, arr);
  }
  return map;
}

/** The authenticated user's own unexpired statuses. */
export async function listOwnStatuses(userId: string): Promise<StatusRecord[]> {
  const res = await query<StatusDbRow>(
    `SELECT * FROM statuses WHERE user_id = $1 AND expires_at > now() ORDER BY created_at DESC`,
    [userId],
  );
  const views = await attachViews(res.rows.map((r) => r.id));
  return res.rows.map((r) => rowToRecord(r, views.get(r.id) ?? []));
}

/**
 * Statuses from other users visible to `viewerId`: unexpired, not blocked
 * either way, and permitted by the owner's visibility mode (Req 9.2,
 * Property 15). 'contacts' is satisfied by sharing a chat with the owner.
 */
export async function listVisibleStatuses(viewerId: string): Promise<StatusRecord[]> {
  const res = await query<StatusDbRow>(
    `SELECT s.* FROM statuses s
      WHERE s.user_id <> $1
        AND s.expires_at > now()
        -- Not blocked in either direction.
        AND NOT EXISTS (
          SELECT 1 FROM blocked_users b
           WHERE (b.blocker_id = $1 AND b.blocked_id = s.user_id)
              OR (b.blocker_id = s.user_id AND b.blocked_id = $1)
        )
        AND (
          s.visibility = 'everyone'
          OR (s.visibility = 'contacts' AND EXISTS (
                SELECT 1 FROM chat_members a
                JOIN chat_members b2 ON a.chat_id = b2.chat_id
                WHERE a.user_id = s.user_id AND b2.user_id = $1))
          OR (s.visibility = 'except' AND NOT EXISTS (
                SELECT 1 FROM status_visibility_users v
                WHERE v.status_id = s.id AND v.mode = 'except' AND v.user_id = $1))
          OR (s.visibility = 'only' AND EXISTS (
                SELECT 1 FROM status_visibility_users v
                WHERE v.status_id = s.id AND v.mode = 'only' AND v.user_id = $1))
        )
      ORDER BY s.created_at DESC`,
    [viewerId],
  );
  const views = await attachViews(res.rows.map((r) => r.id));
  return res.rows.map((r) => rowToRecord(r, views.get(r.id) ?? []));
}

export async function recordView(statusId: string, viewerId: string): Promise<string | null> {
  const res = await query<{ user_id: string }>(
    `INSERT INTO status_views (status_id, viewer_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING (SELECT user_id FROM statuses WHERE id = $1) AS user_id`,
    [statusId, viewerId],
  );
  return res.rows[0]?.user_id ?? null;
}

export async function getStatusOwner(statusId: string): Promise<string | null> {
  const res = await query<{ user_id: string }>('SELECT user_id FROM statuses WHERE id = $1', [
    statusId,
  ]);
  return res.rows[0]?.user_id ?? null;
}

/** Delete a status, returning its media object key for cleanup (Req 9.5). */
export async function deleteStatus(statusId: string, userId: string): Promise<string | null> {
  const res = await query<{ media_object_key: string | null }>(
    'DELETE FROM statuses WHERE id = $1 AND user_id = $2 RETURNING media_object_key',
    [statusId, userId],
  );
  return res.rows[0]?.media_object_key ?? null;
}
