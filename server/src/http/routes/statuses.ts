import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import {
  createStatusSchema,
  createBroadcastSchema,
  updateBroadcastSchema,
  sendBroadcastSchema,
} from '../../domain/schemas/status.js';
import {
  createStatus,
  listOwnStatuses,
  listVisibleStatuses,
  recordView,
  deleteStatus,
  getStatusOwner,
} from '../../db/repositories/statuses.js';
import {
  listBroadcasts,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
  ownsBroadcast,
  getRecipients,
  recordSend,
} from '../../db/repositories/broadcasts.js';
import { getOrCreateDirectChat, getMembers } from '../../db/repositories/chats.js';
import { sendMessage, type MessageType } from '../../db/repositories/messages.js';
import { isBlocked, blockedEitherWay } from '../../db/repositories/blocks.js';
import { getUserById } from '../../db/repositories/users.js';
import { emitToUser } from '../../realtime/emitter.js';
import { enqueueMessagePush, enqueueDeleteObject } from '../../jobs/queues.js';
import { chatPeers } from '../../realtime/presence.js';
import { logger } from '../../config/logger.js';

export async function registerStatusRoutes(app: FastifyInstance): Promise<void> {
  // GET /statuses — own + visible others, with unviewed indicators (Req 9.2, 9.4).
  app.get('/statuses', { preHandler: requireAuth }, async (request) => {
    const userId = request.identity!.userId;
    const [mine, others] = await Promise.all([
      listOwnStatuses(userId),
      listVisibleStatuses(userId),
    ]);
    // Group others by user with an unviewed flag.
    const groups = new Map<
      string,
      { userId: string; displayName: string | null; hasUnviewed: boolean; statuses: typeof others }
    >();
    for (const s of others) {
      const g = groups.get(s.userId) ?? {
        userId: s.userId,
        displayName: s.displayName,
        hasUnviewed: false,
        statuses: [],
      };
      g.statuses.push(s);
      if (!s.viewedBy.includes(userId)) g.hasUnviewed = true;
      groups.set(s.userId, g);
    }
    return { myStatuses: mine, contactStatuses: Array.from(groups.values()) };
  });

  // POST /statuses — post a status with a 24h TTL (Req 9.1).
  app.post('/statuses', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.identity!.userId;
    const body = parse(createStatusSchema, request.body);
    const statusId = await createStatus(userId, {
      displayName: body.displayName ?? null,
      userPhone: body.userPhone ?? null,
      mediaObjectKey: body.mediaObjectKey ?? null,
      thumbnailObjectKey: body.thumbnailObjectKey ?? null,
      mediaType: body.mediaType,
      caption: body.caption ?? null,
      backgroundColor: body.backgroundColor ?? null,
      textColor: body.textColor ?? null,
      durationMs: body.durationMs ?? null,
      visibility: body.visibility,
      excludedUsers: body.excludedUsers,
      selectedUsers: body.selectedUsers,
    });

    // Notify the owner's chat peers that a new status is posted (Req 9.9).
    // Peers resolve their own visibility on the next GET /statuses fetch.
    for (const peer of await chatPeers(userId)) {
      emitToUser(peer, 'status:update', { statusId, ownerId: userId });
    }
    return reply.code(201).send({ statusId });
  });

  // POST /statuses/:id/view — record a view, notify the owner (Req 9.3).
  app.post<{ Params: { id: string } }>(
    '/statuses/:id/view',
    { preHandler: requireAuth },
    async (request) => {
      const viewerId = request.identity!.userId;
      const ownerId = await recordView(request.params.id, viewerId);
      if (ownerId && ownerId !== viewerId) {
        emitToUser(ownerId, 'status:viewed', { statusId: request.params.id, viewerId });
      }
      return { ok: true };
    },
  );

  // DELETE /statuses/:id — delete + request media cleanup (Req 9.5).
  app.delete<{ Params: { id: string } }>(
    '/statuses/:id',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const owner = await getStatusOwner(request.params.id);
      if (owner !== userId) throw Errors.forbidden('Not your status');
      const mediaKey = await deleteStatus(request.params.id, userId);
      // Delete the backing media object asynchronously (Req 9.5, 10.10).
      await enqueueDeleteObject(mediaKey);
      return { ok: true, mediaObjectKey: mediaKey };
    },
  );

  // ── Broadcasts (Req 9.6-9.8) ──
  app.get('/broadcasts', { preHandler: requireAuth }, async (request) => {
    return { lists: await listBroadcasts(request.identity!.userId) };
  });

  app.post('/broadcasts', { preHandler: requireAuth }, async (request, reply) => {
    const body = parse(createBroadcastSchema, request.body);
    const id = await createBroadcast(request.identity!.userId, body.name, body.recipients);
    return reply.code(201).send({ id });
  });

  app.patch<{ Params: { id: string } }>(
    '/broadcasts/:id',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      if (!(await ownsBroadcast(request.params.id, userId))) throw Errors.forbidden('Not your list');
      const patch = parse(updateBroadcastSchema, request.body);
      await updateBroadcast(request.params.id, patch);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/broadcasts/:id',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      if (!(await ownsBroadcast(request.params.id, userId))) throw Errors.forbidden('Not your list');
      await deleteBroadcast(request.params.id);
      return { ok: true };
    },
  );

  // POST /broadcasts/:id/send — one direct message per non-blocking recipient (Req 9.7, 9.8).
  app.post<{ Params: { id: string } }>(
    '/broadcasts/:id/send',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      if (!(await ownsBroadcast(request.params.id, userId))) throw Errors.forbidden('Not your list');
      const body = parse(sendBroadcastSchema, request.body);

      const recipients = await getRecipients(request.params.id);
      const sender = await getUserById(userId);
      const senderName = sender?.display_name ?? sender?.phone_number ?? 'New message';

      let sent = 0;
      const skipped: string[] = [];
      for (const recipientId of recipients) {
        // Skip recipients who blocked the sender; don't fail the batch (Req 9.8).
        if (await isBlocked(recipientId, userId)) {
          skipped.push(recipientId);
          continue;
        }
        const chatId = await getOrCreateDirectChat(userId, recipientId);
        const { message } = await sendMessage(chatId, userId, {
          type: body.type as MessageType,
          text: body.text ?? null,
          mediaObjectKey: body.mediaObjectKey ?? null,
        });
        // Deliver + push like a normal message.
        const others = (await getMembers(chatId)).filter((id) => id !== userId);
        const blocked = await blockedEitherWay(userId, others);
        for (const uid of others) {
          if (!blocked.has(uid)) emitToUser(uid, 'message:new', { message });
        }
        try {
          await enqueueMessagePush({
            chatId,
            messageId: message.id,
            senderId: userId,
            title: senderName,
            body: body.text ?? '📢 Broadcast',
          });
        } catch (err) {
          logger.warn({ err, messageId: message.id }, 'broadcast push enqueue failed');
        }
        sent += 1;
      }

      await recordSend(request.params.id, body.text ?? '📢 Broadcast');
      return { sent, skipped };
    },
  );
}
