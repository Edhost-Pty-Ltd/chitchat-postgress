import type { AuthedSocket } from '../gateway.js';
import { rooms, emitToUser } from '../emitter.js';
import { isMember } from '../../db/repositories/chats.js';
import { markDelivered, markRead } from '../../db/repositories/messages.js';
import { getPrivacySettings } from '../../db/repositories/privacy.js';
import { logger } from '../../config/logger.js';

type Ack = (response: { ok: boolean; error?: string }) => void;

/**
 * Register chat realtime handlers on a connected socket:
 * join/leave rooms, delivered acks, read acks (Req 5.5-5.8).
 */
export function registerChatHandlers(socket: AuthedSocket): void {
  const userId = socket.identity!.userId;

  socket.on('chat:join', async (payload: { chatId?: string }, ack?: Ack) => {
    const chatId = payload?.chatId;
    if (!chatId || !(await isMember(chatId, userId))) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    await socket.join(rooms.chat(chatId));
    ack?.({ ok: true });
  });

  socket.on('chat:leave', (payload: { chatId?: string }, ack?: Ack) => {
    if (payload?.chatId) void socket.leave(rooms.chat(payload.chatId));
    ack?.({ ok: true });
  });

  // Recipient acknowledges delivery (Req 5.6).
  socket.on('message:delivered', async (payload: { chatId?: string; messageId?: string }, ack?: Ack) => {
    const { chatId, messageId } = payload ?? {};
    if (!chatId || !messageId || !(await isMember(chatId, userId))) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    try {
      const senderId = await markDelivered(messageId, userId);
      if (senderId) {
        emitToUser(senderId, 'message:delivered', { chatId, messageId, userId });
      }
      ack?.({ ok: true });
    } catch (err) {
      logger.warn({ err }, 'message:delivered failed');
      ack?.({ ok: false, error: 'INTERNAL' });
    }
  });

  // Recipient opened the chat and read messages (Req 5.7, 5.8).
  socket.on('message:read', async (payload: { chatId?: string; messageIds?: string[] }, ack?: Ack) => {
    const { chatId, messageIds } = payload ?? {};
    if (!chatId || !Array.isArray(messageIds) || !(await isMember(chatId, userId))) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    try {
      const senders = await markRead(chatId, userId, messageIds);
      // Emit read receipts to senders only if the reader allows read receipts (Req 5.8).
      const privacy = await getPrivacySettings(userId);
      if (privacy.readReceipts) {
        for (const senderId of senders) {
          emitToUser(senderId, 'message:read', { chatId, messageIds, userId });
        }
      }
      ack?.({ ok: true });
    } catch (err) {
      logger.warn({ err }, 'message:read failed');
      ack?.({ ok: false, error: 'INTERNAL' });
    }
  });
}
