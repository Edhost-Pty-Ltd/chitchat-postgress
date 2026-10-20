import { query } from '../pool.js';

/**
 * Delete statuses past their expiry, returning the media object keys that need
 * deleting from the object store (Req 11.1). Batched to bound each run.
 */
export async function deleteExpiredStatuses(limit = 1000): Promise<{ deleted: number; mediaKeys: string[] }> {
  const res = await query<{ media_object_key: string | null }>(
    `DELETE FROM statuses
       WHERE id IN (SELECT id FROM statuses WHERE expires_at <= now() LIMIT $1)
     RETURNING media_object_key`,
    [limit],
  );
  return {
    deleted: res.rowCount ?? 0,
    mediaKeys: res.rows.map((r) => r.media_object_key).filter((k): k is string => !!k),
  };
}

/**
 * Delete messages past their expiry, returning media + thumbnail object keys
 * for store cleanup (Req 11.2).
 */
export async function deleteExpiredMessages(limit = 2000): Promise<{ deleted: number; mediaKeys: string[] }> {
  const res = await query<{ media_object_key: string | null; thumbnail_object_key: string | null }>(
    `DELETE FROM messages
       WHERE id IN (SELECT id FROM messages WHERE expires_at <= now() LIMIT $1)
     RETURNING media_object_key, thumbnail_object_key`,
    [limit],
  );
  const keys: string[] = [];
  for (const r of res.rows) {
    if (r.media_object_key) keys.push(r.media_object_key);
    if (r.thumbnail_object_key) keys.push(r.thumbnail_object_key);
  }
  return { deleted: res.rowCount ?? 0, mediaKeys: keys };
}

/**
 * Delete call records not updated within the stale threshold (default 3h)
 * (Req 11.3). Calls carry no object-store media.
 */
export async function deleteStaleCalls(staleHours = 3, limit = 1000): Promise<number> {
  const res = await query(
    `DELETE FROM calls
       WHERE id IN (
         SELECT id FROM calls
          WHERE updated_at <= now() - ($1 || ' hours')::interval
          LIMIT $2)`,
    [String(staleHours), limit],
  );
  return res.rowCount ?? 0;
}
