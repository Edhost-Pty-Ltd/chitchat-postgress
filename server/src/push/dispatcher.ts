import { getEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { query } from '../db/pool.js';
import { userInChatRoom } from '../realtime/emitter.js';

export interface PushMessageJob {
  chatId: string;
  messageId: string;
  senderId: string;
  title: string;
  body: string;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  details?: { error?: string };
}

/**
 * Compute the recipient set for a message push (Property 12): chat members
 * minus sender, minus recipients who blocked the sender, minus recipients with
 * `blocked_message`, minus recipients with an open socket joined to the chat
 * room (Req 6.1, 6.3, 6.7).
 */
export async function resolvePushRecipients(job: PushMessageJob): Promise<string[]> {
  const res = await query<{ user_id: string }>(
    `SELECT cm.user_id
       FROM chat_members cm
       LEFT JOIN message_receipts r
         ON r.message_id = $2 AND r.user_id = cm.user_id
      WHERE cm.chat_id = $1
        AND cm.user_id <> $3
        AND COALESCE(r.blocked_message, false) = false
        AND NOT EXISTS (
          SELECT 1 FROM blocked_users b
           WHERE b.blocker_id = cm.user_id AND b.blocked_id = $3
        )`,
    [job.chatId, job.messageId, job.senderId],
  );
  const candidates = res.rows.map((r) => r.user_id);

  // Drop recipients that are actively connected to the chat room (Req 6.7).
  const filtered: string[] = [];
  for (const uid of candidates) {
    if (!(await userInChatRoom(uid, job.chatId))) filtered.push(uid);
  }
  return filtered;
}

async function tokensForUsers(userIds: string[]): Promise<{ userId: string; token: string }[]> {
  if (userIds.length === 0) return [];
  const res = await query<{ user_id: string; token: string }>(
    'SELECT user_id, token FROM push_tokens WHERE user_id = ANY($1::text[])',
    [userIds],
  );
  return res.rows.map((r) => ({ userId: r.user_id, token: r.token }));
}

/**
 * Send one message's push notifications. Pure-ish: the Expo transport and the
 * now-known recipients are injectable for testing (Property 12).
 */
export async function dispatchMessagePush(
  job: PushMessageJob,
  deps: {
    recipients?: (j: PushMessageJob) => Promise<string[]>;
    tokens?: (userIds: string[]) => Promise<{ userId: string; token: string }[]>;
    sendExpo?: (messages: unknown[]) => Promise<ExpoTicket[]>;
    removeToken?: (token: string) => Promise<void>;
  } = {},
): Promise<{ sent: number; removedTokens: number }> {
  const recipients = await (deps.recipients ?? resolvePushRecipients)(job);
  const tokens = await (deps.tokens ?? tokensForUsers)(recipients);
  if (tokens.length === 0) return { sent: 0, removedTokens: 0 };

  const messages = tokens.map(({ token }) => ({
    to: token,
    sound: 'default',
    title: job.title,
    body: job.body,
    categoryId: 'chat_message',
    data: { chatId: job.chatId, senderId: job.senderId, type: 'message' },
  }));

  const send = deps.sendExpo ?? sendExpoPush;
  let tickets: ExpoTicket[] = [];
  try {
    tickets = await send(messages);
  } catch (err) {
    logger.error({ err }, 'Expo push send failed');
    throw err; // let BullMQ retry (Req 6.5)
  }

  // Remove tokens reported DeviceNotRegistered (Req 6.4).
  const removeToken =
    deps.removeToken ?? (async (token: string) => void (await query('DELETE FROM push_tokens WHERE token = $1', [token])));
  let removed = 0;
  await Promise.all(
    tickets.map(async (ticket, i) => {
      if (ticket?.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
        await removeToken(tokens[i].token);
        removed += 1;
      }
    }),
  );

  return { sent: tokens.length, removedTokens: removed };
}

async function sendExpoPush(messages: unknown[]): Promise<ExpoTicket[]> {
  const url = getEnv().EXPO_PUSH_URL;
  const tickets: ExpoTicket[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100);
    const res = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) throw new Error(`Expo push HTTP ${res.status}`);
    const json = (await res.json()) as { data?: ExpoTicket[] };
    tickets.push(...(json.data ?? []));
  }
  return tickets;
}
