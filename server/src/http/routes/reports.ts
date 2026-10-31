import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requirePrimaryDevice } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import {
  completeRequiresVerification,
  getUserById,
  setRequiresVerification,
} from '../../db/repositories/users.js';
import {
  getOrCreateDirectChat,
  getSharedChatPeerIds,
  sharesChatWith,
} from '../../db/repositories/chats.js';
import { sendMessage } from '../../db/repositories/messages.js';
import { fanOutMessage, notificationName } from '../../domain/messaging.js';
import { emitToUser, refreshUserSocketAuthorization } from '../../realtime/emitter.js';
import { logger } from '../../config/logger.js';
import { getEnv } from '../../config/env.js';
import {
  FaceVerificationReceiptError,
  verifyFaceVerificationReceipt,
} from '../../security/faceVerificationReceipt.js';

const reportSchema = z.object({ userId: z.string().min(1).max(128) }).strict();
const verifySchema = z.object({ receipt: z.string().min(20).max(4096) }).strict();

/** Safe public status payload: never reveals who reported the user or why. */
function publicStatus(userId: string, identityVerified: boolean, verifiedAt: string | null) {
  return {
    userId,
    identityVerified,
    identityStatus: identityVerified ? 'verified' : 'verification_required',
    verifiedAt,
  } as const;
}

export async function registerReportRoutes(app: FastifyInstance): Promise<void> {
  // POST /reports — an accepted report atomically changes the target from
  // verified → verification_required and rotates its report generation.
  app.post('/reports', { preHandler: requireAuth }, async (request, reply) => {
    const reporterId = request.identity!.userId;
    const { userId: reportedId } = parse(reportSchema, request.body);
    if (reportedId === reporterId) throw Errors.badRequest('You cannot report yourself');

    const reported = await getUserById(reportedId);
    if (!reported) throw Errors.notFound('User not found');

    // Reporting is a moderation action for an actual interaction, not an
    // arbitrary account-lockout endpoint. The app exposes it from a chat, and
    // the backend independently enforces that relationship.
    if (!(await sharesChatWith(reporterId, reportedId))) {
      throw Errors.forbidden('You can only report someone you share a chat with');
    }

    const transition = await setRequiresVerification(reportedId, reporterId);
    const status = publicStatus(reportedId, false, null);

    // All of the target's devices lock immediately. Only the owner receives the
    // generation; it is needed to bind Django's proof to this exact report.
    emitToUser(reportedId, 'user:identity-status', {
      ...status,
      requiresVerification: true,
      verificationGeneration: transition.generation,
    });
    // Compatibility for already-running clients that only know the old event.
    emitToUser(reportedId, 'user:flagged', {
      reason: 'reported',
      verificationGeneration: transition.generation,
    });
    // Re-evaluate feature handlers immediately after the status commit. The
    // client reconnects into the gateway's status-only mode; per-packet checks
    // close any handshake/report race while reconnection is in progress.
    refreshUserSocketAuthorization(reportedId);

    // Safe public status goes to current chat peers so already-open profile
    // badges cannot continue showing Verified. No report metadata/generation is
    // included in this fan-out.
    const peers = await getSharedChatPeerIds(reportedId);
    for (const peerId of peers) {
      emitToUser(peerId, 'user:identity-status', status);
    }

    return reply.code(transition.duplicate ? 200 : 201).send({
      ok: true,
      identityVerified: false,
      alreadyReported: transition.duplicate,
    });
  });

  // POST /me/verify — finalizes a successful face check. This endpoint does
  // NOT accept `matched: true`; it accepts only a signed, short-lived receipt
  // minted by Django after the on-device FaceAISDK confirmed a live match
  // against the stored encrypted reference. Companion devices cannot finalize
  // owner identity.
  app.post(
    '/me/verify',
    { preHandler: [requireAuth, requirePrimaryDevice] },
    async (request) => {
      const userId = request.identity!.userId;
      const { receipt } = parse(verifySchema, request.body);

      let proof;
      try {
        proof = verifyFaceVerificationReceipt(
          receipt,
          getEnv().FACE_VERIFICATION_RECEIPT_SECRET,
        );
      } catch (err) {
        if (err instanceof FaceVerificationReceiptError) {
          throw Errors.forbidden('Face verification could not be confirmed');
        }
        throw err;
      }
      if (proof.sub !== userId) {
        // Same response as a bad signature: do not expose which part differed.
        throw Errors.forbidden('Face verification could not be confirmed');
      }

      const completed = await completeRequiresVerification(userId, proof.generation);
      if (completed.state === 'not_found') throw Errors.notFound('User not found');
      if (completed.state === 'stale') {
        // A report arrived after this check began. It must remain active.
        throw Errors.conflict('A newer verification request exists. Please start again.');
      }

      const status = publicStatus(userId, true, completed.verifiedAt);
      emitToUser(userId, 'user:identity-status', {
        ...status,
        requiresVerification: false,
        verificationGeneration: null,
      });
      refreshUserSocketAuthorization(userId);
      const peers = await getSharedChatPeerIds(userId);
      for (const peerId of peers) {
        emitToUser(peerId, 'user:identity-status', status);
      }

      // Notify every unresolved reporter only after the canonical DB transition
      // succeeds. A retry that sees already_verified does not duplicate messages.
      if (completed.state === 'cleared') {
        const me = await getUserById(userId);
        const name = notificationName(me);
        for (const reporterId of completed.reporterIds) {
          try {
            const chatId = await getOrCreateDirectChat(reporterId, userId);
            const { message, created } = await sendMessage(chatId, userId, {
              type: 'system',
              subtype: 'verification',
              text: `${name} completed identity verification.`,
            });
            if (created) await fanOutMessage(message, name);
            emitToUser(reporterId, 'user:verified', { name, ...status });
          } catch (err) {
            logger.warn({ err, userId, reporterId }, 'verify notify failed');
          }
        }
      }

      return { ok: true, verified: true, ...status };
    },
  );
}
