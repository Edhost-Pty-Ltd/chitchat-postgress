import { query } from '../pool.js';

export interface MessageStats {
  sent: number;
  delivered: number;
  read: number;
}

/**
 * Compute message delivery analytics for a business owner on demand from the
 * authoritative tables (replaces the cached Firestore users/{uid}/stats doc):
 *   sent      = messages the owner sent (non-deleted)
 *   delivered = of those, how many have at least one recipient receipt with
 *               delivered_at set
 *   read      = of those, how many have at least one recipient receipt read
 * Blocked receipts are excluded so blocked recipients don't inflate the rates.
 */
export async function computeMessageStats(ownerId: string): Promise<MessageStats> {
  const res = await query<{ sent: string; delivered: string; read: string }>(
    `SELECT
        count(*)::text AS sent,
        count(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM message_receipts r
             WHERE r.message_id = m.id AND r.blocked_message = false AND r.delivered_at IS NOT NULL
          )
        )::text AS delivered,
        count(*) FILTER (
          WHERE EXISTS (
            SELECT 1 FROM message_receipts r
             WHERE r.message_id = m.id AND r.blocked_message = false AND r.read_at IS NOT NULL
          )
        )::text AS read
       FROM messages m
      WHERE m.sender_id = $1
        AND m.deleted_for_everyone = false`,
    [ownerId],
  );
  const row = res.rows[0] ?? { sent: '0', delivered: '0', read: '0' };
  return {
    sent: Number(row.sent),
    delivered: Number(row.delivered),
    read: Number(row.read),
  };
}
