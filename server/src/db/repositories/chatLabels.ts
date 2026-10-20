import { query } from '../pool.js';

/**
 * Chat labels (custom chat-list filters) owned by a user, shared across the
 * owner's devices. Mirrors the old Firestore users/{uid}/chatLabels collection
 * ({ title, memberIds, groupIds, createdAt, updatedAt }).
 */
export interface ChatLabel {
  id: string;
  title: string;
  memberIds: string[];
  groupIds: string[];
  createdAt: number; // epoch ms, matching the client's original shape
  updatedAt: number;
}

interface Row {
  id: string;
  title: string;
  member_ids: string[];
  group_ids: string[];
  created_at: Date;
  updated_at: Date;
}

function toLabel(r: Row): ChatLabel {
  return {
    id: r.id,
    title: r.title,
    memberIds: r.member_ids ?? [],
    groupIds: r.group_ids ?? [],
    createdAt: r.created_at.getTime(),
    updatedAt: r.updated_at.getTime(),
  };
}

export async function listChatLabels(ownerId: string): Promise<ChatLabel[]> {
  const res = await query<Row>(
    'SELECT * FROM chat_labels WHERE owner_id = $1 ORDER BY created_at ASC',
    [ownerId],
  );
  return res.rows.map(toLabel);
}

export async function createChatLabel(
  ownerId: string,
  input: { title: string; memberIds: string[]; groupIds: string[] },
): Promise<ChatLabel> {
  const res = await query<Row>(
    `INSERT INTO chat_labels (owner_id, title, member_ids, group_ids)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [ownerId, input.title, input.memberIds, input.groupIds],
  );
  return toLabel(res.rows[0]);
}

export async function updateChatLabel(
  ownerId: string,
  labelId: string,
  patch: { title?: string; memberIds?: string[]; groupIds?: string[] },
): Promise<ChatLabel | null> {
  const res = await query<Row>(
    `UPDATE chat_labels SET
       title      = COALESCE($3, title),
       member_ids = COALESCE($4, member_ids),
       group_ids  = COALESCE($5, group_ids),
       updated_at = now()
     WHERE id = $2 AND owner_id = $1
     RETURNING *`,
    [ownerId, labelId, patch.title ?? null, patch.memberIds ?? null, patch.groupIds ?? null],
  );
  return res.rows[0] ? toLabel(res.rows[0]) : null;
}

export async function deleteChatLabel(ownerId: string, labelId: string): Promise<boolean> {
  const res = await query('DELETE FROM chat_labels WHERE id = $2 AND owner_id = $1', [
    ownerId,
    labelId,
  ]);
  return (res.rowCount ?? 0) > 0;
}
