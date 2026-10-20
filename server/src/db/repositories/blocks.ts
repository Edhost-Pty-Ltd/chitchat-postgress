import { query } from '../pool.js';

export interface BlockedContact {
  userId: string;
  displayName: string | null;
  photoObjectKey: string | null;
  phone: string | null;
  blockedAt: string;
  lastSeenAtBlock: string | null;
}

interface BlockRow {
  blocked_id: string;
  display_name: string | null;
  photo_object_key: string | null;
  phone: string | null;
  blocked_at: Date;
  last_seen_at_block: Date | null;
}

/** List the authenticated user's blocked contacts (Req 4.12). */
export async function listBlocked(blockerId: string): Promise<BlockedContact[]> {
  const res = await query<BlockRow>(
    `SELECT blocked_id, display_name, photo_object_key, phone, blocked_at, last_seen_at_block
       FROM blocked_users WHERE blocker_id = $1 ORDER BY blocked_at DESC`,
    [blockerId],
  );
  return res.rows.map((r) => ({
    userId: r.blocked_id,
    displayName: r.display_name,
    photoObjectKey: r.photo_object_key,
    phone: r.phone,
    blockedAt: r.blocked_at.toISOString(),
    lastSeenAtBlock: r.last_seen_at_block ? r.last_seen_at_block.toISOString() : null,
  }));
}

export async function blockUser(
  blockerId: string,
  blockedId: string,
  meta: { displayName?: string | null; photoObjectKey?: string | null; phone?: string | null },
): Promise<void> {
  await query(
    `INSERT INTO blocked_users
       (blocker_id, blocked_id, display_name, photo_object_key, phone, last_seen_at_block)
     VALUES ($1, $2, $3, $4, $5, (SELECT last_seen FROM users WHERE id = $1))
     ON CONFLICT (blocker_id, blocked_id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       photo_object_key = EXCLUDED.photo_object_key,
       phone = EXCLUDED.phone`,
    [blockerId, blockedId, meta.displayName ?? null, meta.photoObjectKey ?? null, meta.phone ?? null],
  );
}

export async function unblockUser(blockerId: string, blockedId: string): Promise<void> {
  await query('DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2', [
    blockerId,
    blockedId,
  ]);
}

/** True when `blockerId` has blocked `blockedId`. Server-side enforcement (Req 4.13). */
export async function isBlocked(blockerId: string, blockedId: string): Promise<boolean> {
  const res = await query(
    'SELECT 1 FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
    [blockerId, blockedId],
  );
  return res.rowCount! > 0;
}

/**
 * Given a viewer and a set of other user ids, return the subset that has an
 * active block in EITHER direction with the viewer. Used to filter messaging,
 * presence and calls (Req 4.13).
 */
export async function blockedEitherWay(
  userId: string,
  others: string[],
): Promise<Set<string>> {
  if (others.length === 0) return new Set();
  const res = await query<{ other: string }>(
    `SELECT blocked_id AS other FROM blocked_users
       WHERE blocker_id = $1 AND blocked_id = ANY($2::text[])
     UNION
     SELECT blocker_id AS other FROM blocked_users
       WHERE blocked_id = $1 AND blocker_id = ANY($2::text[])`,
    [userId, others],
  );
  return new Set(res.rows.map((r) => r.other));
}
