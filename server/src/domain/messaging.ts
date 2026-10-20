// ─── Message fan-out + business auto-responder ──────────────────────────────
// Shared by every server path that creates a chat message (REST send, forward,
// broadcasts, meeting invitations, auto-replies). Replaces two Cloud Functions:
//   • sendMessageNotification — realtime delivery + Expo push (group chats are
//     titled with the group name and prefixed with the sender's name).
//   • autoResponder — a business's away message, sent outside its working
//     hours, at most once per "visit".

import { query } from '../db/pool.js';
import { getMembers } from '../db/repositories/chats.js';
import { blockedEitherWay, isBlocked } from '../db/repositories/blocks.js';
import { getUserById, type UserRow } from '../db/repositories/users.js';
import { sendMessage, type StoredMessage } from '../db/repositories/messages.js';
import { emitToUser } from '../realtime/emitter.js';
import { enqueueMessagePush } from '../jobs/queues.js';
import { logger } from '../config/logger.js';

export function previewBody(m: StoredMessage): string {
  if (m.text) return m.text;
  switch (m.type) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'file':
      return `📎 ${m.fileName ?? 'File'}`;
    case 'location':
      return '📍 Location';
    case 'catalog':
      return '🛍️ Product';
    case 'poll':
      return '📊 Poll';
    case 'order':
      return '🛒 Order';
    case 'contact':
      return '👤 Contact';
    default:
      return 'New message';
  }
}

const PHONE_LIKE = /^\+?[\d\s\-()]{5,}$/;

/** Display name for notifications: a real name if set, otherwise the phone. */
export function notificationName(user: Pick<UserRow, 'display_name' | 'phone_number'> | null): string {
  const dn = (user?.display_name ?? '').trim();
  const ph = (user?.phone_number ?? '').trim();
  if (dn && !PHONE_LIKE.test(dn) && dn !== ph) return dn;
  return ph || dn || 'Someone';
}

/**
 * Deliver a stored message to the other members over Socket.IO and enqueue its
 * push (Req 5.4, 6). Recipients who blocked the sender (either way) get
 * neither. Then gives the recipient's auto-responder a chance to reply.
 */
export async function fanOutMessage(message: StoredMessage, senderName?: string): Promise<void> {
  const members = await getMembers(message.chatId);
  const others = members.filter((id) => id !== message.senderId);
  const blocked = await blockedEitherWay(message.senderId, others);
  const recipients = others.filter((id) => !blocked.has(id));

  for (const uid of recipients) {
    emitToUser(uid, 'message:new', { message });
  }

  try {
    const name = senderName ?? notificationName(await getUserById(message.senderId));
    const chat = await query<{ type: string; group_name: string | null }>(
      'SELECT type, group_name FROM chats WHERE id = $1',
      [message.chatId],
    );
    const isGroup = chat.rows[0]?.type === 'group';
    const text = previewBody(message);
    await enqueueMessagePush({
      chatId: message.chatId,
      messageId: message.id,
      senderId: message.senderId,
      title: isGroup ? chat.rows[0]?.group_name ?? 'Group' : name,
      body: isGroup ? `${name}: ${text}` : text,
    });
  } catch (err) {
    // Push is best-effort; never fail the send because the queue is down.
    logger.warn({ err, messageId: message.id }, 'failed to enqueue push');
  }

  try {
    await maybeAutoRespond(message);
  } catch (err) {
    logger.warn({ err, messageId: message.id }, 'auto-responder failed');
  }
}

// ─── Auto-responder ──────────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Current weekday + minutes-since-midnight in the business's time zone. */
function zonedNow(timeZone: string | null | undefined): { day: string; minutes: number } {
  const now = new Date();
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now);
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      return { day: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
    } catch {
      /* invalid zone — fall back to server time */
    }
  }
  return { day: DAYS[now.getDay()], minutes: now.getHours() * 60 + now.getMinutes() };
}

/** "9:00 AM" / "09:00" → minutes since midnight. */
function toMinutes(t: string): number | null {
  const ampm = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(t);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const m = parseInt(ampm[2], 10);
    if (ampm[3].toUpperCase() === 'PM' && h < 12) h += 12;
    if (ampm[3].toUpperCase() === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  }
  const h24 = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (h24) return parseInt(h24[1], 10) * 60 + parseInt(h24[2], 10);
  return null;
}

/**
 * Same rules as the old Cloud Function: no schedule (or every day closed)
 * means "always auto-reply"; otherwise reply when today is closed or the time
 * is outside today's open/close window.
 */
export function isOutsideWorkingHours(
  schedule: Record<string, { open: string; close: string }> | null | undefined,
  timeZone?: string | null,
): boolean {
  if (!schedule || Object.keys(schedule).length === 0) return true;
  if (!Object.values(schedule).some((d) => d && d.open !== 'Closed')) return true;
  const { day, minutes } = zonedNow(timeZone);
  const today = schedule[day];
  if (!today || today.open === 'Closed') return true;
  const open = toMinutes(today.open);
  const close = toMinutes(today.close);
  if (open === null || close === null) return true;
  return minutes < open || minutes >= close;
}

async function maybeAutoRespond(message: StoredMessage): Promise<void> {
  // Never reply to system notices (invites, block notices) or to an auto-reply
  // — otherwise two off-hours businesses would bounce away messages forever.
  if (message.type === 'system' || message.subtype === 'auto_reply') return;

  const chat = await query<{ type: string }>('SELECT type FROM chats WHERE id = $1', [
    message.chatId,
  ]);
  if (chat.rows[0]?.type !== 'direct') return;
  const members = await getMembers(message.chatId);
  if (members.length !== 2) return;
  const recipientId = members.find((id) => id !== message.senderId);
  if (!recipientId) return;

  // Don't answer someone the business has blocked.
  if (await isBlocked(recipientId, message.senderId)) return;

  const recipient = await getUserById(recipientId);
  const reply = recipient?.auto_responder_message?.trim();
  if (!recipient?.auto_responder_enabled || !reply) return;
  if (!isOutsideWorkingHours(recipient.work_schedule, recipient.timezone)) return;

  // At most once per visit: skip if the business's latest message in this chat
  // already is the auto-reply.
  const recent = await query<{ sender_id: string; text: string | null }>(
    `SELECT sender_id, text FROM messages
      WHERE chat_id = $1 AND deleted_for_everyone = false AND id <> $2
      ORDER BY created_at DESC LIMIT 10`,
    [message.chatId, message.id],
  );
  const lastFromRecipient = recent.rows.find((r) => r.sender_id === recipientId);
  if (lastFromRecipient?.text?.trim() === reply) return;

  const { message: autoReply, created } = await sendMessage(message.chatId, recipientId, {
    type: 'text',
    text: reply,
    subtype: 'auto_reply',
  });
  if (created) {
    // Deliver it to the customer (and the business's other devices).
    emitToUser(recipientId, 'message:new', { message: autoReply });
    await fanOutMessage(autoReply, notificationName(recipient));
  }
  logger.info({ chatId: message.chatId, from: recipientId }, 'auto-reply sent');
}
