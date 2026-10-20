import type { PoolClient } from 'pg';
import { query, withTransaction } from '../pool.js';
import { encodeCursor, decodeCursor, clampLimit } from '../../domain/cursor.js';

export const MESSAGE_TTL_MS = 72 * 60 * 60 * 1000; // 72h (Req 5.3)

export type MessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'video'
  | 'file'
  | 'location'
  | 'system'
  | 'catalog';

export interface MessageInput {
  clientId?: string | null;
  type: MessageType;
  text?: string | null;
  mediaObjectKey?: string | null;
  thumbnailObjectKey?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mimeType?: string | null;
  durationMs?: number | null;
  location?: unknown;
  catalogItem?: unknown;
  replyTo?: unknown;
  subtype?: string | null;
}

export interface StoredMessage {
  id: string;
  chatId: string;
  senderId: string;
  clientId: string | null;
  type: MessageType;
  text: string | null;
  mediaObjectKey: string | null;
  thumbnailObjectKey: string | null;
  fileName: string | null;
  fileSize: number | null;
  mimeType: string | null;
  durationMs: number | null;
  location: unknown;
  catalogItem: unknown;
  replyTo: unknown;
  subtype: string | null;
  createdAt: string;
  expiresAt: string;
  deletedForEveryone: boolean;
  deliveredTo: string[];
  readBy: string[];
  edited: boolean;
  editedAt: string | null;
}

interface MessageRow {
  id: string;
  chat_id: string;
  sender_id: string;
  client_id: string | null;
  type: MessageType;
  text: string | null;
  media_object_key: string | null;
  thumbnail_object_key: string | null;
  file_name: string | null;
  file_size: string | null;
  mime_type: string | null;
  duration_ms: number | null;
  location: unknown;
  catalog_item: unknown;
  reply_to: unknown;
  subtype: string | null;
  created_at: Date;
  expires_at: Date;
  deleted_for_everyone: boolean;
  edited: boolean;
  edited_at: Date | null;
}

function previewFor(input: MessageInput): string {
  if (input.text) return input.text;
  switch (input.type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'file':
      return `📎 ${input.fileName ?? 'File'}`;
    case 'location':
      return '📍 Location';
    case 'catalog':
      return '🛍️ Product';
    default:
      return 'New message';
  }
}

async function hydrateReceipts(ids: string[]): Promise<Map<string, { delivered: string[]; read: string[] }>> {
  const map = new Map<string, { delivered: string[]; read: string[] }>();
  if (ids.length === 0) return map;
  const res = await query<{ message_id: string; user_id: string; delivered_at: Date | null; read_at: Date | null }>(
    `SELECT message_id, user_id, delivered_at, read_at
       FROM message_receipts WHERE message_id = ANY($1::uuid[])`,
    [ids],
  );
  for (const r of res.rows) {
    const entry = map.get(r.message_id) ?? { delivered: [], read: [] };
    if (r.delivered_at) entry.delivered.push(r.user_id);
    if (r.read_at) entry.read.push(r.user_id);
    map.set(r.message_id, entry);
  }
  return map;
}

function rowToMessage(
  row: MessageRow,
  receipts: Map<string, { delivered: string[]; read: string[] }>,
): StoredMessage {
  const r = receipts.get(row.id) ?? { delivered: [], read: [] };
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    clientId: row.client_id,
    type: row.type,
    text: row.text,
    mediaObjectKey: row.media_object_key,
    thumbnailObjectKey: row.thumbnail_object_key,
    fileName: row.file_name,
    fileSize: row.file_size != null ? Number(row.file_size) : null,
    mimeType: row.mime_type,
    durationMs: row.duration_ms,
    location: row.location,
    catalogItem: row.catalog_item,
    replyTo: row.reply_to,
    subtype: row.subtype,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    deletedForEveryone: row.deleted_for_everyone,
    deliveredTo: r.delivered,
    readBy: r.read,
    edited: row.edited ?? false,
    editedAt: row.edited_at ? row.edited_at.toISOString() : null,
  };
}

/**
 * Insert a message with a 72h TTL, idempotent on client_id (Req 5.3, 5.17).
 * Creates a receipt row per other member, marking `blocked_message` for anyone
 * who has blocked the sender (Req 5.10), and increments their unread count
 * unless the message is blocked for them. Returns the stored message and
 * whether it was newly created (false ⇒ returned the existing one).
 */
export async function sendMessage(
  chatId: string,
  senderId: string,
  input: MessageInput,
): Promise<{ message: StoredMessage; created: boolean }> {
  const result = await withTransaction(async (client: PoolClient) => {
    // Idempotency: return the existing message for a repeated client_id.
    if (input.clientId) {
      const existing = await client.query<MessageRow>(
        'SELECT * FROM messages WHERE chat_id = $1 AND sender_id = $2 AND client_id = $3',
        [chatId, senderId, input.clientId],
      );
      if (existing.rows[0]) {
        return { row: existing.rows[0], created: false };
      }
    }

    const expiresAt = new Date(Date.now() + MESSAGE_TTL_MS);
    const inserted = await client.query<MessageRow>(
      `INSERT INTO messages
         (chat_id, sender_id, client_id, type, text, media_object_key, thumbnail_object_key,
          file_name, file_size, mime_type, duration_ms, location, catalog_item, reply_to, subtype,
          expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [
        chatId,
        senderId,
        input.clientId ?? null,
        input.type,
        input.text ?? null,
        input.mediaObjectKey ?? null,
        input.thumbnailObjectKey ?? null,
        input.fileName ?? null,
        input.fileSize ?? null,
        input.mimeType ?? null,
        input.durationMs ?? null,
        input.location != null ? JSON.stringify(input.location) : null,
        input.catalogItem != null ? JSON.stringify(input.catalogItem) : null,
        input.replyTo != null ? JSON.stringify(input.replyTo) : null,
        input.subtype ?? null,
        expiresAt,
      ],
    );
    const row = inserted.rows[0];

    // Other members, and which of them blocked the sender.
    const members = await client.query<{ user_id: string }>(
      'SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2',
      [chatId, senderId],
    );
    const others = members.rows.map((m) => m.user_id);

    let blockedBy = new Set<string>();
    if (others.length > 0) {
      const blocks = await client.query<{ blocker_id: string }>(
        `SELECT blocker_id FROM blocked_users
          WHERE blocked_id = $1 AND blocker_id = ANY($2::text[])`,
        [senderId, others],
      );
      blockedBy = new Set(blocks.rows.map((b) => b.blocker_id));
    }

    for (const uid of others) {
      const isBlocked = blockedBy.has(uid);
      await client.query(
        `INSERT INTO message_receipts (message_id, user_id, blocked_message)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [row.id, uid, isBlocked],
      );
      // Unread increments only for non-blocked recipients (Req 5.10).
      if (!isBlocked) {
        await client.query(
          'UPDATE chat_members SET unread_count = unread_count + 1 WHERE chat_id = $1 AND user_id = $2',
          [chatId, uid],
        );
      }
    }

    // Update the chat preview.
    await client.query(
      `UPDATE chats SET last_message_text = $2, last_message_sender_id = $3, last_message_at = $4
         WHERE id = $1`,
      [chatId, previewFor(input), senderId, row.created_at],
    );

    return { row, created: true };
  });

  const receipts = await hydrateReceipts([result.row.id]);
  return { message: rowToMessage(result.row, receipts), created: result.created };
}

export interface Page {
  messages: StoredMessage[];
  nextCursor: string | null;
}

/**
 * Messages for a chat in descending creation order, cursor paginated, excluding
 * expired rows and rows deleted for everyone or for this viewer (Req 5.9, 11.7).
 */
export async function listMessages(
  chatId: string,
  viewerId: string,
  opts: { cursor?: string; limit?: number },
): Promise<Page> {
  const limit = clampLimit(opts.limit);
  const cursor = decodeCursor(opts.cursor);

  const params: unknown[] = [chatId, viewerId];
  let keyset = '';
  if (cursor) {
    params.push(cursor.createdAt, cursor.id);
    keyset = `AND (m.created_at, m.id) < ($3::timestamptz, $4::uuid)`;
  }

  const res = await query<MessageRow>(
    `SELECT m.* FROM messages m
       WHERE m.chat_id = $1
         AND m.expires_at > now()
         AND m.deleted_for_everyone = false
         AND NOT (m.deleted_for @> to_jsonb($2::text))
         ${keyset}
       ORDER BY m.created_at DESC, m.id DESC
       LIMIT ${limit + 1}`,
    params,
  );

  const hasMore = res.rows.length > limit;
  const pageRows = hasMore ? res.rows.slice(0, limit) : res.rows;
  const receipts = await hydrateReceipts(pageRows.map((r) => r.id));
  const messages = pageRows.map((r) => rowToMessage(r, receipts));
  const last = pageRows[pageRows.length - 1];
  return {
    messages,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at.toISOString(), id: last.id }) : null,
  };
}

/** Messages newer than a given message id, ascending — used on reconnect (Req 5.18). */
export async function messagesAfter(
  chatId: string,
  viewerId: string,
  afterMessageId: string,
): Promise<StoredMessage[]> {
  const res = await query<MessageRow>(
    `SELECT m.* FROM messages m
       WHERE m.chat_id = $1
         AND m.expires_at > now()
         AND m.deleted_for_everyone = false
         AND NOT (m.deleted_for @> to_jsonb($2::text))
         AND m.created_at > (SELECT created_at FROM messages WHERE id = $3)
       ORDER BY m.created_at ASC, m.id ASC
       LIMIT 500`,
    [chatId, viewerId, afterMessageId],
  );
  const receipts = await hydrateReceipts(res.rows.map((r) => r.id));
  return res.rows.map((r) => rowToMessage(r, receipts));
}

/** Record delivery for a recipient (Req 5.6). Returns the sender to notify. */
export async function markDelivered(messageId: string, userId: string): Promise<string | null> {
  const res = await query<{ sender_id: string }>(
    `UPDATE message_receipts SET delivered_at = COALESCE(delivered_at, now())
       WHERE message_id = $1 AND user_id = $2
     RETURNING (SELECT sender_id FROM messages WHERE id = $1) AS sender_id`,
    [messageId, userId],
  );
  return res.rows[0]?.sender_id ?? null;
}

/**
 * Record reads for a recipient across messages, and clear unread count (Req 5.7).
 * Returns the distinct sender ids whose messages were read, for emitting read
 * receipts (the route decides whether to emit based on the reader's privacy).
 */
export async function markRead(
  chatId: string,
  userId: string,
  messageIds: string[],
): Promise<string[]> {
  return withTransaction(async (client) => {
    let senders: string[] = [];
    if (messageIds.length > 0) {
      // RETURNING does not support DISTINCT; dedupe the sender ids in JS.
      const res = await client.query<{ sender_id: string }>(
        `UPDATE message_receipts r SET
           read_at = COALESCE(read_at, now()),
           delivered_at = COALESCE(delivered_at, now())
         FROM messages m
         WHERE r.message_id = m.id
           AND r.message_id = ANY($1::uuid[])
           AND r.user_id = $2
         RETURNING m.sender_id`,
        [messageIds, userId],
      );
      senders = Array.from(new Set(res.rows.map((x) => x.sender_id)));
    }
    // Clear unread for the chat.
    await client.query(
      'UPDATE chat_members SET unread_count = 0 WHERE chat_id = $1 AND user_id = $2',
      [chatId, userId],
    );
    return senders;
  });
}

export async function getMessageSender(messageId: string): Promise<string | null> {
  const res = await query<{ sender_id: string }>('SELECT sender_id FROM messages WHERE id = $1', [
    messageId,
  ]);
  return res.rows[0]?.sender_id ?? null;
}

/** Delete a message for everyone (sender only) or just for the caller (Req 5.14). */
export async function deleteMessage(
  messageId: string,
  userId: string,
  scope: 'everyone' | 'me',
): Promise<void> {
  if (scope === 'everyone') {
    await query(
      'UPDATE messages SET deleted_for_everyone = true, text = NULL, media_object_key = NULL WHERE id = $1 AND sender_id = $2',
      [messageId, userId],
    );
  } else {
    await query(
      `UPDATE messages SET deleted_for = deleted_for || to_jsonb($2::text) WHERE id = $1`,
      [messageId, userId],
    );
  }
}

/** Does a message belong to a chat the viewer can read? (used by delete) */
export async function messageChatId(messageId: string): Promise<string | null> {
  const res = await query<{ chat_id: string }>('SELECT chat_id FROM messages WHERE id = $1', [
    messageId,
  ]);
  return res.rows[0]?.chat_id ?? null;
}

/**
 * Edit the text of a message the caller sent (Req 5.x).
 * Only text-type messages owned by the sender may be edited.
 * Returns the updated message or null when the message is not found / not owned.
 */
export async function editMessage(
  messageId: string,
  senderId: string,
  newText: string,
): Promise<StoredMessage | null> {
  const res = await query<MessageRow & { edited: boolean; edited_at: Date | null }>(
    `UPDATE messages
        SET text = $3, edited = true, edited_at = now()
      WHERE id = $1 AND sender_id = $2 AND type = 'text'
     RETURNING *`,
    [messageId, senderId, newText],
  );
  if (!res.rows[0]) return null;
  // Re-hydrate receipts for the single updated row.
  const receipts = await hydrateReceipts([res.rows[0].id]);
  return rowToMessage(res.rows[0], receipts);
}
