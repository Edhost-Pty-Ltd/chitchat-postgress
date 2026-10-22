import type { FastifyInstance } from 'fastify';
import { requireAuth, requireAuthAllowAnonymous, requirePrimaryDevice } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import { getAdminAuth } from '../../auth/firebaseAdmin.js';
import { getUserById } from '../../db/repositories/users.js';
import { isMember } from '../../db/repositories/chats.js';
import { isBlocked } from '../../db/repositories/blocks.js';
import { emitToUser } from '../../realtime/emitter.js';
import {
  muteSchema,
  recordProfileViewSchema,
  createLinkTokenSchema,
  claimLinkSchema,
  registerDeviceSchema,
  createBusinessSchema,
  updateBusinessSchema,
  agentStatusSchema,
  userRoleSchema,
  internalNoteSchema,
  syncedContactsSchema,
  chatLabelSchema,
  chatLabelPatchSchema,
} from '../../domain/schemas/features.js';
import { listMutedChats, setChatMuted } from '../../db/repositories/mutes.js';
import { recordProfileView, getProfileViewCounters } from '../../db/repositories/profileViews.js';
import { computeMessageStats } from '../../db/repositories/analytics.js';
import {
  createLinkToken,
  getLinkToken,
  findLiveTokenByCode,
  claimLinkToken,
  listLinkedDevices,
  registerDevice,
  touchDevice,
  removeDevice,
  removeOtherDevices,
} from '../../db/repositories/linkedDevices.js';
import {
  listBusinessesForUser,
  getBusiness,
  createBusiness,
  ownsBusiness,
  updateBusiness,
  setUserRole,
  setAgentStatus,
  getUserRoleStatus,
  listInternalNotes,
  addInternalNote,
  chatAgents,
  isChatAgent,
} from '../../db/repositories/businesses.js';
import { listSyncedContacts, replaceSyncedContacts } from '../../db/repositories/syncedContacts.js';
import {
  listChatLabels,
  createChatLabel,
  updateChatLabel,
  deleteChatLabel,
} from '../../db/repositories/chatLabels.js';

const primaryOnly = { preHandler: [requireAuth, requirePrimaryDevice] };

export async function registerFeatureRoutes(app: FastifyInstance): Promise<void> {
  // ─── Chat mute ─────────────────────────────────────────────────────────────
  app.get('/me/muted-chats', { preHandler: requireAuth }, async (request) => {
    return { chatIds: await listMutedChats(request.identity!.userId) };
  });

  app.put<{ Params: { id: string } }>(
    '/chats/:id/mute',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      if (!(await isMember(chatId, userId))) throw Errors.forbidden('Not a member of this chat');
      const { muted } = parse(muteSchema, request.body);
      await setChatMuted(chatId, userId, muted);
      return { chatId, muted };
    },
  );

  // ─── Profile views (old recordProfileView Cloud Function) ─────────────────
  app.post('/profile-views', { preHandler: requireAuth }, async (request) => {
    const viewerId = request.identity!.userId;
    const { viewedUid } = parse(recordProfileViewSchema, request.body);
    // Don't let a blocked viewer bump (or a user arbitrarily inflate) another
    // user's profile-view counters. recordProfileView already ignores
    // self-views; here we additionally drop the view when either party has
    // blocked the other. (This is a soft counter, so we no-op silently rather
    // than error.)
    const [iBlocked, blockedMe] = await Promise.all([
      isBlocked(viewerId, viewedUid),
      isBlocked(viewedUid, viewerId),
    ]);
    if (!iBlocked && !blockedMe) {
      await recordProfileView(viewedUid, viewerId);
    }
    return { ok: true };
  });

  app.get('/me/profile-views', { preHandler: requireAuth }, async (request) => {
    return getProfileViewCounters(request.identity!.userId);
  });

  // ─── Message analytics ───────────────────────────────────────────────────
  app.get('/me/message-stats', { preHandler: requireAuth }, async (request) => {
    return computeMessageStats(request.identity!.userId);
  });

  // ─── Linked / companion devices (old mintCompanionToken + revokeDeviceToken) ─
  // A not-yet-linked device signs in anonymously and creates a link request.
  // The requester is always the authenticated (anonymous) caller — never a
  // value from the body.
  app.post('/device-links', { preHandler: requireAuthAllowAnonymous }, async (request) => {
    const body = parse(createLinkTokenSchema, request.body);
    await createLinkToken({
      requestId: body.requestId,
      displayCode: body.displayCode,
      requesterUid: request.identity!.userId,
      deviceId: body.deviceId,
      deviceName: body.deviceName ?? null,
      deviceType: body.deviceType,
      os: body.os ?? null,
      platform: body.platform,
    });
    return { requestId: body.requestId, displayCode: body.displayCode };
  });

  // The companion polls its own request. Once the primary has claimed it, the
  // backend mints a Firebase custom token for the OWNER tagged
  // { companion: true, deviceId } so the companion signs in as the owner and
  // every later request can be checked against linked_devices.
  app.get<{ Params: { requestId: string } }>(
    '/device-links/:requestId',
    { preHandler: requireAuthAllowAnonymous },
    async (request) => {
      const token = await getLinkToken(request.params.requestId);
      // Only the device that created the request may poll it.
      if (!token || token.requester_uid !== request.identity!.userId) {
        throw Errors.notFound('Link request not found');
      }
      const expired = new Date() > token.expires_at;
      if (!token.consumed || !token.owner_uid) {
        return { consumed: false, expired, ownerUid: null, customToken: null };
      }
      if (expired) {
        return { consumed: true, expired: true, ownerUid: token.owner_uid, customToken: null };
      }
      let customToken: string | null = null;
      try {
        customToken = await getAdminAuth().createCustomToken(token.owner_uid, {
          companion: true,
          deviceId: token.device_id,
        });
      } catch (err) {
        request.log.error({ err }, 'createCustomToken failed');
        throw Errors.badRequest('Could not finish linking. Please try again.');
      }
      return { consumed: true, expired: false, ownerUid: token.owner_uid, customToken };
    },
  );

  // Look up a pending request by its human display code (primary device).
  app.get<{ Querystring: { code?: string } }>('/device-links', primaryOnly, async (request) => {
    const code = (request.query.code ?? '').trim();
    if (code.length < 4) return { requestId: null };
    const token = await findLiveTokenByCode(code);
    return { requestId: token?.id ?? null };
  });

  // Primary device claims a pending request, registering the companion device.
  // Companions cannot link further devices.
  app.post('/device-links/claim', primaryOnly, async (request) => {
    const ownerUid = request.identity!.userId;
    const { requestId, ownerName } = parse(claimLinkSchema, request.body);
    const result = await claimLinkToken(requestId, ownerUid, ownerName ?? null);
    if (!result.ok) throw Errors.badRequest(result.error ?? 'Failed to claim link request');
    return { success: true };
  });

  app.get('/me/devices', { preHandler: requireAuth }, async (request) => {
    return { devices: await listLinkedDevices(request.identity!.userId) };
  });

  // Register this device. A companion can only (re)register the device it was
  // linked with.
  app.post('/me/devices', { preHandler: requireAuth }, async (request) => {
    const identity = request.identity!;
    const body = parse(registerDeviceSchema, request.body);
    if (identity.isCompanion && body.deviceId !== identity.deviceId) {
      throw Errors.forbidden('A companion can only register itself');
    }
    await registerDevice(identity.userId, body);
    return { ok: true };
  });

  app.post<{ Params: { deviceId: string } }>(
    '/me/devices/:deviceId/touch',
    { preHandler: requireAuth },
    async (request) => {
      await touchDevice(request.identity!.userId, request.params.deviceId);
      return { ok: true };
    },
  );

  // Removing a device takes effect immediately: the companion's next request is
  // rejected (verifier checks linked_devices) and its push tokens are dropped.
  app.delete<{ Params: { deviceId: string } }>(
    '/me/devices/:deviceId',
    primaryOnly,
    async (request) => {
      const userId = request.identity!.userId;
      const { deviceId } = request.params;
      await removeDevice(userId, deviceId);
      emitToUser(userId, 'device:removed', { deviceId });
      return { ok: true };
    },
  );

  app.delete<{ Querystring: { keep?: string } }>('/me/devices', primaryOnly, async (request) => {
    const userId = request.identity!.userId;
    const removed = await removeOtherDevices(userId, request.query.keep ?? '');
    for (const deviceId of removed) emitToUser(userId, 'device:removed', { deviceId });
    return { ok: true, removed: removed.length };
  });

  // ─── Synced contacts (companions show the owner's phone book) ─────────────
  app.get('/me/synced-contacts', { preHandler: requireAuth }, async (request) => {
    return { contacts: await listSyncedContacts(request.identity!.userId) };
  });

  app.put('/me/synced-contacts', primaryOnly, async (request) => {
    const { contacts } = parse(syncedContactsSchema, request.body);
    const saved = await replaceSyncedContacts(
      request.identity!.userId,
      contacts.map((c) => ({
        phone: c.phone,
        displayName: c.displayName,
        userId: c.userId ?? null,
        isSaved: !!c.isSaved,
        avatarObjectKey: c.avatarObjectKey ?? null,
      })),
    );
    return { saved };
  });

  // ─── Chat labels ─────────────────────────────────────────────────────────
  app.get('/me/chat-labels', { preHandler: requireAuth }, async (request) => {
    return { labels: await listChatLabels(request.identity!.userId) };
  });

  app.post('/me/chat-labels', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.identity!.userId;
    const body = parse(chatLabelSchema, request.body);
    const label = await createChatLabel(userId, body);
    emitToUser(userId, 'labels:updated', {});
    return reply.code(201).send({ label });
  });

  app.patch<{ Params: { id: string } }>(
    '/me/chat-labels/:id',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const patch = parse(chatLabelPatchSchema, request.body);
      const label = await updateChatLabel(userId, request.params.id, patch);
      if (!label) throw Errors.notFound('Label not found');
      emitToUser(userId, 'labels:updated', {});
      return { label };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/me/chat-labels/:id',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const ok = await deleteChatLabel(userId, request.params.id);
      if (!ok) throw Errors.notFound('Label not found');
      emitToUser(userId, 'labels:updated', {});
      return { ok: true };
    },
  );

  // ─── Multi-agent / business ──────────────────────────────────────────────
  app.get('/businesses', { preHandler: requireAuth }, async (request) => {
    return { businesses: await listBusinessesForUser(request.identity!.userId) };
  });

  app.post('/businesses', primaryOnly, async (request, reply) => {
    const ownerId = request.identity!.userId;
    const body = parse(createBusinessSchema, request.body);
    const business = await createBusiness(ownerId, body);
    return reply.code(201).send({ business });
  });

  app.get<{ Params: { id: string } }>(
    '/businesses/:id',
    { preHandler: requireAuth },
    async (request) => {
      const business = await getBusiness(request.params.id);
      if (!business) throw Errors.notFound('Business not found');
      const userId = request.identity!.userId;
      if (business.ownerId !== userId && !business.agents.includes(userId)) {
        throw Errors.forbidden('Not part of this business');
      }
      return { business };
    },
  );

  app.patch<{ Params: { id: string } }>('/businesses/:id', primaryOnly, async (request) => {
    const ownerId = request.identity!.userId;
    if (!(await ownsBusiness(request.params.id, ownerId))) {
      throw Errors.forbidden('Only the business owner can edit it');
    }
    const patch = parse(updateBusinessSchema, request.body);
    const business = await updateBusiness(request.params.id, patch);
    return { business };
  });

  // Agent role + live status on the authenticated user.
  app.get('/me/agent', { preHandler: requireAuth }, async (request) => {
    return getUserRoleStatus(request.identity!.userId);
  });

  app.put('/me/role', primaryOnly, async (request) => {
    const { role } = parse(userRoleSchema, request.body);
    await setUserRole(request.identity!.userId, role);
    return { role };
  });

  app.put('/me/agent-status', { preHandler: requireAuth }, async (request) => {
    const { status } = parse(agentStatusSchema, request.body);
    await setAgentStatus(request.identity!.userId, status);
    return { status };
  });

  // Internal notes on a chat — visible only to the business's owner/agents,
  // never to the customer in the conversation.
  app.get<{ Params: { id: string } }>(
    '/chats/:id/notes',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      if (!(await isChatAgent(request.params.id, userId))) {
        throw Errors.forbidden('Internal notes are only visible to business agents');
      }
      return { notes: await listInternalNotes(request.params.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/chats/:id/notes',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.identity!.userId;
      const chatId = request.params.id;
      const agents = await chatAgents(chatId);
      if (!agents.includes(userId)) {
        throw Errors.forbidden('Internal notes are only visible to business agents');
      }
      const { text } = parse(internalNoteSchema, request.body);
      const author = await getUserById(userId);
      const note = await addInternalNote(
        chatId,
        userId,
        author?.display_name ?? author?.phone_number ?? null,
        text,
      );
      for (const agentId of agents) emitToUser(agentId, 'note:added', { note });
      return reply.code(201).send({ note });
    },
  );
}
