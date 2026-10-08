import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import { checkRateLimit } from '../../redis/rateLimit.js';
import {
  createChatSchema,
  updateChatSchema,
  sendMessageSchema,
  deleteMessageSchema,
  forwardSchema,
  listMessagesQuerySchema,
} from '../../domain/schemas/chat.js';
import {
  listChats,
  totalUnread,
  getOrCreateDirectChat,
  createGroupChat,
  updateGroup,
  isMember,
  isAdmin,
  getMembers,
} from '../../db/repositories/chats.js';
import {
  sendMessage,
  listMessages,
  messagesAfter,
  deleteMessage,
  messageChatId,
  getMessageSender,
  type StoredMessage,
} from '../../db/repositories/messages.js';
import { getUserById } from '../../db/repositories/users.js';
import { blockedEitherWay } from '../../db/repositories/blocks.js';
import { emitToUser, emitToChat } from '../../realtime/emitter.js';
import { enqueueMessagePush } from '../../jobs/queues.js';
import { logger } from '../../config/logger.js';

const SEND_LIMIT = 60; // messages per window
const SEND_WINDOW_SEC = 60;

function previewBody(m: StoredMessage): string {
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
    default:
      return 'New message';
  }
}

/** Deliver a stored message to recipients and enqueue a push (Req 5.4, 6). */
async function fanOutMessage(message: StoredMessage, senderDisplayName: string): Promise<void> {
  const members = await getMembers(message.chatId);
  const others = members.filter((id) => id !== message.senderId);
  // Recipients who blocked the sender (either way) must not receive the event.
  const blocked = await blockedEitherWay(message.senderId, others);
  const recipients = others.filter((id) => !blocked.has(id));

  for (const uid of recipients) {
    emitToUser(uid, 'message:new', { message });
  }

  try {
    await enqueueMessagePush({
      chatId: message.chatId,
      messageId: message.id,
      senderId: message.senderId,
      title: senderDisplayName,
      body: previewBody(message),
    });
  } catch (err) {
    // Push is best-effort; never fail the send because the queue is down.
    logger.warn({ err, messageId: message.id }, 'failed to enqueue push');
  }
}

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  // GET /chats — chat list + unread totals (Req 5.11).
  app.get('/chats', { preHandler: requireAuth }, async (request) => {
    const userId = request.identity!.userId;
    const [chats, total] = await Promise.all([listChats(userId), totalUnread(userId)]);
    return { chats, totalUnread: total };
  });

  // POST /chats — create a direct or group chat (Req 5.1, 5.12).
  app.post('/chats', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.identity!.userId;
    const body = parse(createChatSchema, request.body);

    if (body.type === 'direct') {
      const others = body.members.filter((id) => id !== userId);
      if (others.length !== 1) {
        throw Errors.badRequest('A direct chat needs exactly one other member');
      }
      const chatId = await getOrCreateDirectChat(userId, others[0]);
      return reply.code(201).send({ chatId, type: 'direct' });
    }

    if (!body.groupName) throw Errors.badRequest('A group chat needs a name');
    const chatId = await createGroupChat(
      userId,
      body.members,
      body.groupName,
      body.groupPhotoObjectKey ?? null,
    );
    return reply.code(201).send({ chatId, type: 'group' });
  });

  // PATCH /chats/:id — edit group metadata/members (admin only) (Req 5.13).
  app.patch<{ Params: { id: string } }>(
    '/chats/:id',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isAdmin(chatId, userId))) {
        throw Errors.forbidden('Only a chat admin can edit the group');
      }
      const patch = parse(updateChatSchema, request.body);
      await updateGroup(chatId, patch);
      emitToChat(chatId, 'chat:updated', { chatId });
      return { ok: true };
    },
  );

  // GET /chats/:id/messages — paginated, or ?after= for reconnect (Req 5.9, 5.18).
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/chats/:id/messages',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isMember(chatId, userId))) {
        throw Errors.forbidden('Not a member of this chat');
      }
      const q = parse(listMessagesQuerySchema, request.query);
      if (q.after) {
        const messages = await messagesAfter(chatId, userId, q.after);
        return { messages, nextCursor: null };
      }
      return listMessages(chatId, userId, { cursor: q.cursor, limit: q.limit });
    },
  );

  // POST /chats/:id/messages — send (idempotent on clientId) (Req 5.3, 5.5, 5.17).
  app.post<{ Params: { id: string } }>(
    '/chats/:id/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isMember(chatId, userId))) {
        throw Errors.forbidden('Not a member of this chat');
      }

      const rl = await checkRateLimit(userId, 'send', SEND_LIMIT, SEND_WINDOW_SEC);
      if (!rl.allowed) {
        reply.header('Retry-After', String(rl.retryAfterSec));
        throw Errors.tooManyRequests('Message rate limit exceeded');
      }

      const body = parse(sendMessageSchema, request.body);
      const { message, created } = await sendMessage(chatId, userId, body);

      if (created) {
        const sender = await getUserById(userId);
        await fanOutMessage(message, sender?.display_name ?? sender?.phone_number ?? 'New message');
      }
      return reply.code(created ? 201 : 200).send({ message });
    },
  );

  // POST /chats/:id/messages/:mid/delete — delete for me / everyone (Req 5.14).
  app.post<{ Params: { id: string; mid: string } }>(
    '/chats/:id/messages/:mid/delete',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isMember(chatId, userId))) {
        throw Errors.forbidden('Not a member of this chat');
      }
      const { scope } = parse(deleteMessageSchema, request.body);
      if (scope === 'everyone') {
        const sender = await getMessageSender(request.params.mid);
        if (sender !== userId) throw Errors.forbidden('Only the sender can delete for everyone');
      }
      await deleteMessage(request.params.mid, userId, scope);
      if (scope === 'everyone') {
        emitToChat(chatId, 'message:deleted', { chatId, messageId: request.params.mid });
      }
      return { ok: true };
    },
  );

  // POST /messages/forward — forward one message to N chats (Req 5.15).
  app.post('/messages/forward', { preHandler: requireAuth }, async (request) => {
    const userId = request.identity!.userId;
    const body = parse(forwardSchema, request.body);

    const sourceChat = await messageChatId(body.messageId);
    if (!sourceChat || !(await isMember(sourceChat, userId))) {
      throw Errors.forbidden('Cannot forward this message');
    }
    // Load the source once via a single-item page lookup.
    const page = await listMessages(sourceChat, userId, { limit: 100 });
    const source = page.messages.find((m) => m.id === body.messageId);
    if (!source) throw Errors.notFound('Message not found');

    const sender = await getUserById(userId);
    const senderName = sender?.display_name ?? sender?.phone_number ?? 'New message';
    const createdIds: string[] = [];
    for (const targetId of body.targetChatIds) {
      if (!(await isMember(targetId, userId))) continue;
      const { message } = await sendMessage(targetId, userId, {
        type: source.type,
        text: source.text,
        mediaObjectKey: source.mediaObjectKey,
        thumbnailObjectKey: source.thumbnailObjectKey,
        fileName: source.fileName,
        fileSize: source.fileSize,
        mimeType: source.mimeType,
        durationMs: source.durationMs,
        location: source.location,
        catalogItem: source.catalogItem,
      });
      createdIds.push(message.id);
      await fanOutMessage(message, senderName);
    }
    return { forwarded: createdIds.length, messageIds: createdIds };
  });
}
