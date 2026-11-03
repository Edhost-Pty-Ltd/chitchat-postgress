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
  createBusinessAgentSchema,
  agentFaceEnrollmentCompleteSchema,
  agentStatusSchema,
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
  BusinessAgentError,
  addInternalNote,
  canIssueAgentFaceEnrollmentGrant,
  canManageBusinessAgents,
  chatAgents,
  completeBusinessAgentFaceEnrollment,
  createBusiness,
  getBusiness,
  getBusinessAgentForViewer,
  getBusinessDashboardForUser,
  getUserRoleStatus,
  isChatAgent,
  listBusinessesForUser,
  listInternalNotes,
  ownsBusiness,
  provisionBusinessAgent,
  setOwnBusinessAgentStatus,
  updateBusiness,
} from '../../db/repositories/businesses.js';
import { listSyncedContacts, replaceSyncedContacts } from '../../db/repositories/syncedContacts.js';
import {
  listChatLabels,
  createChatLabel,
  updateChatLabel,
  deleteChatLabel,
} from '../../db/repositories/chatLabels.js';
import {
  AgentFaceEnrollmentTokenError,
  mintAgentFaceEnrollmentGrant,
  verifyAgentFaceEnrollmentReceipt,
} from '../../security/agentFaceEnrollment.js';
import { getEnv } from '../../config/env.js';
import { logger } from '../../config/logger.js';

const primaryOnly = { preHandler: [requireAuth, requirePrimaryDevice] };

function throwBusinessAgentError(err: unknown): never {
  if (!(err instanceof BusinessAgentError)) throw err;
  switch (err.code) {
    case 'business_not_found':
    case 'agent_not_found':
      throw Errors.notFound(err.message);
    case 'not_business_member':
    case 'not_business_manager':
    case 'agent_membership_inactive':
      throw Errors.forbidden(err.message);
    case 'agent_identity_recovery_required':
      throw Errors.conflict(err.message);
    case 'agent_phone_conflict':
    case 'agent_already_assigned':
    case 'agent_already_registered':
    case 'agent_already_enrolled':
    case 'agent_receipt_replayed':
      throw Errors.conflict(err.message);
  }
}

async function resolveAgentFirebaseUser(phoneNumber: string, displayName: string): Promise<{
  uid: string;
  created: boolean;
}> {
  const auth = getAdminAuth();
  try {
    const existing = await auth.getUserByPhoneNumber(phoneNumber);
    return { uid: existing.uid, created: false };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'auth/user-not-found') throw err;
  }
  const created = await auth.createUser({ phoneNumber, displayName });
  return { uid: created.uid, created: true };
}

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
      const { muted, mutedUntil } = parse(muteSchema, request.body);
      const until = muted && mutedUntil ? new Date(mutedUntil) : null;
      await setChatMuted(chatId, userId, muted, until);
      return { chatId, muted, mutedUntil: until?.toISOString() ?? null };
    },
  );

  // ─── Profile views / owner analytics ──────────────────────────────────────
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

  app.get('/me/message-stats', { preHandler: requireAuth }, async (request) => {
    return computeMessageStats(request.identity!.userId);
  });

  // ─── Linked / companion devices ──────────────────────────────────────────
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

  app.get<{ Params: { requestId: string } }>(
    '/device-links/:requestId',
    { preHandler: requireAuthAllowAnonymous },
    async (request) => {
      const token = await getLinkToken(request.params.requestId);
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
      try {
        const customToken = await getAdminAuth().createCustomToken(token.owner_uid, {
          companion: true,
          deviceId: token.device_id,
        });
        return { consumed: true, expired: false, ownerUid: token.owner_uid, customToken };
      } catch (err) {
        request.log.error({ err }, 'createCustomToken failed');
        throw Errors.badRequest('Could not finish linking. Please try again.');
      }
    },
  );

  app.get<{ Querystring: { code?: string } }>('/device-links', primaryOnly, async (request) => {
    const code = (request.query.code ?? '').trim();
    if (code.length < 4) return { requestId: null };
    const token = await findLiveTokenByCode(code);
    return { requestId: token?.id ?? null };
  });

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

  // ─── Synced contacts ──────────────────────────────────────────────────────
  app.get('/me/synced-contacts', { preHandler: requireAuth }, async (request) => {
    return { contacts: await listSyncedContacts(request.identity!.userId) };
  });

  app.put('/me/synced-contacts', primaryOnly, async (request) => {
    const { contacts } = parse(syncedContactsSchema, request.body);
    const saved = await replaceSyncedContacts(
      request.identity!.userId,
      contacts.map((contact) => ({
        phone: contact.phone,
        displayName: contact.displayName,
        userId: contact.userId ?? null,
        isSaved: !!contact.isSaved,
        avatarObjectKey: contact.avatarObjectKey ?? null,
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

  // ─── Multi-agent business dashboard ──────────────────────────────────────
  // Any standalone business account gets an idempotently bootstrapped business
  // the first time it opens this screen. Existing agents instead receive their
  // existing company context and their own dashboard view.
  app.get('/businesses/dashboard', { preHandler: requireAuth }, async (request) => {
    try {
      return { dashboard: await getBusinessDashboardForUser(request.identity!.userId) };
    } catch (err) {
      throwBusinessAgentError(err);
    }
  });

  app.get('/businesses', { preHandler: requireAuth }, async (request) => {
    return { businesses: await listBusinessesForUser(request.identity!.userId) };
  });

  app.post('/businesses', primaryOnly, async (request, reply) => {
    const ownerId = request.identity!.userId;
    const body = parse(createBusinessSchema, request.body);
    try {
      const business = await createBusiness(ownerId, body);
      return reply.code(201).send({ business });
    } catch (err) {
      throwBusinessAgentError(err);
    }
  });

  app.get<{ Params: { id: string } }>(
    '/businesses/:id',
    { preHandler: requireAuth },
    async (request) => {
      const business = await getBusiness(request.params.id);
      if (!business) throw Errors.notFound('Business not found');
      const manager = await canManageBusinessAgents(request.params.id, request.identity!.userId);
      if (!business.agents.includes(request.identity!.userId)) {
        throw Errors.forbidden('Not part of this business');
      }
      return { business: manager ? business : { ...business, agents: [] } };
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

  app.get<{ Params: { id: string; agentId: string } }>(
    '/businesses/:id/agents/:agentId',
    { preHandler: requireAuth },
    async (request) => {
      try {
        return {
          agent: await getBusinessAgentForViewer(
            request.params.id,
            request.params.agentId,
            request.identity!.userId,
          ),
        };
      } catch (err) {
        throwBusinessAgentError(err);
      }
    },
  );

  /** Owner/admin provisioning of a distinct Firebase phone identity. */
  app.post<{ Params: { id: string } }>(
    '/businesses/:id/agents',
    primaryOnly,
    async (request, reply) => {
      const managerId = request.identity!.userId;
      const body = parse(createBusinessAgentSchema, request.body);
      // Do this BEFORE Firebase Admin lookup/create. A caller who is not an
      // active owner/admin cannot cause any external authentication side effect.
      if (!(await canManageBusinessAgents(request.params.id, managerId))) {
        throw Errors.forbidden('Only an active business manager can add agents');
      }
      const displayName = `${body.firstName} ${body.surname}`.trim();
      let firebase: { uid: string; created: boolean };
      try {
        firebase = await resolveAgentFirebaseUser(body.phoneNumber, displayName);
      } catch (err) {
        request.log.warn({ code: (err as { code?: string }).code }, 'agent Firebase provisioning failed');
        throw Errors.badRequest('Could not create the agent phone account');
      }

      try {
        const agent = await provisionBusinessAgent({
          businessId: request.params.id,
          managerId,
          agentId: firebase.uid,
          phoneNumber: body.phoneNumber,
          firstName: body.firstName,
          surname: body.surname,
          consentConfirmedAt: new Date(),
        });
        const grant = await canIssueAgentFaceEnrollmentGrant(
          request.params.id,
          managerId,
          firebase.uid,
        );
        const minted = mintAgentFaceEnrollmentGrant(
          { managerId, agentId: firebase.uid, businessId: request.params.id },
          getEnv().AGENT_FACE_ENROLLMENT_SECRET,
        );
        emitToUser(managerId, 'business:agents-updated', { businessId: request.params.id });
        return reply.code(201).send({
          agent,
          enrollmentGrant: minted.grant,
          enrollmentGrantExpiresAt: minted.expiresAt,
          firebaseAccountCreated: firebase.created,
          requiresPhoneSignIn: true,
          consentRecordedAt: grant.biometricConsentAt,
        });
      } catch (err) {
        // Compensate only a Firebase account created by this request. Never
        // delete an existing agent's Auth identity because a business attach failed.
        if (firebase.created) {
          try { await getAdminAuth().deleteUser(firebase.uid); } catch (cleanupErr) {
            logger.warn({ cleanupErr, uid: firebase.uid }, 'could not clean up agent Firebase account');
          }
        }
        throwBusinessAgentError(err);
      }
    },
  );

  /** Issue a fresh one-time face grant after an image/upload failure. */
  app.post<{ Params: { id: string; agentId: string } }>(
    '/businesses/:id/agents/:agentId/face-enrollment-grant',
    primaryOnly,
    async (request) => {
      const managerId = request.identity!.userId;
      try {
        const agent = await canIssueAgentFaceEnrollmentGrant(
          request.params.id,
          managerId,
          request.params.agentId,
        );
        const minted = mintAgentFaceEnrollmentGrant(
          { managerId, agentId: request.params.agentId, businessId: request.params.id },
          getEnv().AGENT_FACE_ENROLLMENT_SECRET,
        );
        return { agent, enrollmentGrant: minted.grant, enrollmentGrantExpiresAt: minted.expiresAt };
      } catch (err) {
        throwBusinessAgentError(err);
      }
    },
  );

  /** Final state transition is accepted only with Django's signed receipt. */
  app.post<{ Params: { id: string; agentId: string } }>(
    '/businesses/:id/agents/:agentId/face-enrollment-complete',
    primaryOnly,
    async (request) => {
      const managerId = request.identity!.userId;
      const { receipt } = parse(agentFaceEnrollmentCompleteSchema, request.body);
      let proof;
      try {
        proof = verifyAgentFaceEnrollmentReceipt(
          receipt,
          getEnv().AGENT_FACE_ENROLLMENT_SECRET,
        );
      } catch (err) {
        if (err instanceof AgentFaceEnrollmentTokenError) {
          throw Errors.forbidden('Agent face enrollment could not be confirmed');
        }
        throw err;
      }
      if (
        proof.managerId !== managerId ||
        proof.businessId !== request.params.id ||
        proof.agentId !== request.params.agentId
      ) {
        throw Errors.forbidden('Agent face enrollment could not be confirmed');
      }
      try {
        const agent = await completeBusinessAgentFaceEnrollment({
          businessId: request.params.id,
          managerId,
          agentId: request.params.agentId,
          receiptJti: proof.jti,
        });
        emitToUser(managerId, 'business:agents-updated', { businessId: request.params.id });
        return { agent };
      } catch (err) {
        throwBusinessAgentError(err);
      }
    },
  );

  /** Agents control their own availability in their own business dashboard. */
  app.put<{ Params: { id: string } }>(
    '/businesses/:id/me/agent-status',
    primaryOnly,
    async (request) => {
      const { status } = parse(agentStatusSchema, request.body);
      try {
        const agent = await setOwnBusinessAgentStatus(
          request.params.id,
          request.identity!.userId,
          status,
        );
        emitToUser(request.identity!.userId, 'business:agents-updated', { businessId: request.params.id });
        return { agent };
      } catch (err) {
        throwBusinessAgentError(err);
      }
    },
  );

  // Legacy role endpoint deliberately fails closed. A user can no longer turn
  // themselves into an admin; business membership is granted by an owner/admin.
  app.put('/me/role', primaryOnly, async () => {
    throw Errors.forbidden('Roles are managed by business owners');
  });

  app.get('/me/agent', { preHandler: requireAuth }, async (request) => {
    return getUserRoleStatus(request.identity!.userId);
  });

  // Internal notes on a chat — visible only to active business agents, never
  // to the customer in the conversation.
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
