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
  editMessageSchema,
  forwardSchema,
  listMessagesQuerySchema,
  votePollSchema,
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
  editMessage,
  messageChatId,
  getMessageSender,
  getMessageMeta,
  votePoll,
  reactToMessage,
} from '../../db/repositories/messages.js';
import { getUserById } from '../../db/repositories/users.js';
import {
  leaveChat,
  listPastMembers,
  wasMember,
  clearChatForUser,
} from '../../db/repositories/chats.js';
import { emitToUser, emitToChat } from '../../realtime/emitter.js';
import { fanOutMessage, notificationName } from '../../domain/messaging.js';
import { enqueueReactionPush } from '../../jobs/queues.js';
import { logger } from '../../config/logger.js';

const SEND_LIMIT = 60; // messages per window
const SEND_WINDOW_SEC = 60;

export async function registerChatRoutes(app: FastifyInstance): Promise<void> {
  // POST /chats/:id/clear — clear the chat for the caller only; the other
  // members keep their messages (old per-user `clearedAt` on the chat doc).
  app.post<{ Params: { id: string } }>(
    '/chats/:id/clear',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isMember(chatId, userId))) throw Errors.forbidden('Not a member of this chat');
      const clearedAt = await clearChatForUser(chatId, userId);
      emitToUser(userId, 'chat:cleared', { chatId, clearedAt });
      return { chatId, clearedAt };
    },
  );

  // POST /chats/:id/leave — leave a group (any member; no admin rights needed).
  app.post<{ Params: { id: string } }>(
    '/chats/:id/leave',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isMember(chatId, userId))) throw Errors.forbidden('Not a member of this chat');
      const before = await getMembers(chatId);
      await leaveChat(chatId, userId);
      for (const uid of before) emitToUser(uid, 'chat:updated', { chatId });
      emitToChat(chatId, 'chat:updated', { chatId });
      return { ok: true };
    },
  );

  // GET /chats/:id/past-members — people who left or were removed from a group.
  app.get<{ Params: { id: string } }>(
    '/chats/:id/past-members',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await wasMember(chatId, userId))) throw Errors.forbidden('Not a member of this chat');
      return { pastMembers: await listPastMembers(chatId) };
    },
  );
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
        await fanOutMessage(message, notificationName(sender));
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

  // PATCH /chats/:id/messages/:mid — edit the text of an own text message.
  app.patch<{ Params: { id: string; mid: string } }>(
    '/chats/:id/messages/:mid',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isMember(chatId, userId))) {
        throw Errors.forbidden('Not a member of this chat');
      }
      const { text } = parse(editMessageSchema, request.body);
      const updated = await editMessage(request.params.mid, userId, text);
      if (!updated) {
        throw Errors.forbidden('Message not found or you are not the sender');
      }
      // Notify all chat members of the edit so they can update their local state.
      emitToChat(chatId, 'message:edited', { chatId, message: updated });
      return { message: updated };
    },
  );

  // POST /chats/:id/messages/:mid/vote — cast/toggle a poll vote.
  app.post<{ Params: { id: string; mid: string } }>(
    '/chats/:id/messages/:mid/vote',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isMember(chatId, userId))) {
        throw Errors.forbidden('Not a member of this chat');
      }
      const { optionId } = parse(votePollSchema, request.body);
      const meta = await getMessageMeta(request.params.mid);
      if (!meta || meta.chatId !== chatId || meta.type !== 'poll' || !meta.poll) {
        throw Errors.notFound('Poll not found in this chat');
      }
      if (!meta.poll.options.some((o) => o.id === optionId)) {
        throw Errors.badRequest('Unknown poll option');
      }
      const updated = await votePoll(request.params.mid, userId, optionId);
      if (!updated) throw Errors.notFound('Poll not found');
      // Broadcast the refreshed poll (with projected votes) to the whole chat.
      emitToChat(chatId, 'poll:updated', { chatId, message: updated });
      return { message: updated };
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
    const senderName = notificationName(sender);
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
        poll: source.poll,
        order: source.order,
        contact: source.contact,
      });
      createdIds.push(message.id);
      await fanOutMessage(message, senderName);
    }
    return { forwarded: createdIds.length, messageIds: createdIds };
  });

  // POST /chats/:id/messages/:mid/react
  // Add or toggle an emoji reaction. Same emoji from same user = remove (toggle).
  // Different emoji from same user = replace. Broadcasts message:reacted to the
  // whole chat room and enqueues a push to the message author.
  app.post<{ Params: { id: string; mid: string } }>(
    '/chats/:id/messages/:mid/react',
    { preHandler: requireAuth },
    async (request, reply) => {
      const chatId = request.params.id;
      const messageId = request.params.mid;
      const userId = request.identity!.userId;

      if (!(await isMember(chatId, userId))) {
        throw Errors.forbidden('Not a member of this chat');
      }

      const body = request.body as { emoji?: string };
      const emoji = typeof body?.emoji === 'string' ? body.emoji.trim() : '';
      if (!emoji || emoji.length > 16) {
        throw Errors.badRequest('emoji is required (max 16 chars)');
      }

      const { chatId: msgChatId, senderId, reactions } =
        await reactToMessage(messageId, userId, emoji);

      if (msgChatId !== chatId) throw Errors.forbidden('Message not in this chat');

      // Broadcast the fresh reactions map to everyone in the chat so all
      // connected clients update instantly without re-fetching.
      emitToChat(chatId, 'message:reacted', {
        chatId,
        messageId,
        reactions,   // full reactions object: emoji → userId[]
        reactorId: userId,
      });

      // Push to the message author if they're not the reactor and not in the
      // chat room right now (same pattern as message pushes).
      if (senderId !== userId) {
        const reactor = await getUserById(userId);
        const reactorName = notificationName(reactor);
        try {
          await enqueueReactionPush({
            chatId,
            messageId,
            senderId,      // the original message author (receives the push)
            reactorId: userId,
            reactorName,
            emoji,
          });
        } catch (err) {
          logger.warn({ err, messageId }, 'failed to enqueue reaction push');
        }
      }

      return reply.code(200).send({ reactions });
    },
  );
}
