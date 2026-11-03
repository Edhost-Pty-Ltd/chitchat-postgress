import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import { createCallSchema, historyQuerySchema } from '../../domain/schemas/call.js';
import {
  createCall,
  getCall,
  listCallHistory,
  clearCallHistory,
  markCallsSeen,
  updateCallStatus,
  isParticipant,
} from '../../db/repositories/calls.js';
import { isBlocked } from '../../db/repositories/blocks.js';
import { notifyIncomingCall } from '../../realtime/handlers/signaling.js';
import { scheduleCallTimeout } from '../../jobs/queues.js';
import { logger } from '../../config/logger.js';

export async function registerCallRoutes(app: FastifyInstance): Promise<void> {
  // POST /calls — create a call record, notify the callee, schedule the
  // unanswered timeout (Req 8.4, 8.5, 8.6, 8.10).
  app.post('/calls', { preHandler: requireAuth }, async (request, reply) => {
    const callerId = request.identity!.userId;
    const body = parse(createCallSchema, request.body);

    // Reject if the caller is blocked by the callee, without notifying (Req 8.6).
    if (await isBlocked(body.calleeId, callerId)) {
      throw Errors.forbidden('Cannot call this user');
    }

    await createCall({
      callId: body.callId,
      callerId,
      calleeId: body.calleeId,
      callerInfo: body.callerInfo,
      calleeInfo: body.calleeInfo,
      type: body.type,
    });

    const call = await getCall(body.callId);
    if (call) {
      const notified = await notifyIncomingCall(call);
      if (!notified) throw Errors.forbidden('Cannot call this user');
      try {
        await scheduleCallTimeout(call.id);
      } catch (err) {
        logger.warn({ err, callId: call.id }, 'failed to schedule call timeout');
      }
    }
    return reply.code(201).send({ callId: body.callId });
  });

  // GET /calls/history — descending, cursor paginated (Req 8.11).
  app.get<{ Querystring: Record<string, string> }>(
    '/calls/history',
    { preHandler: requireAuth },
    async (request) => {
      const q = parse(historyQuerySchema, request.query);
      return listCallHistory(request.identity!.userId, { cursor: q.cursor, limit: q.limit });
    },
  );

  // DELETE /calls/history — clear the user's history (Req 8.12).
  app.delete('/calls/history', { preHandler: requireAuth }, async (request) => {
    await clearCallHistory(request.identity!.userId);
    return { ok: true };
  });

  // POST /calls/history/seen — mark the user's call history as seen so the
  // Calls tab badge clears when they open the Calls screen. History is retained.
  app.post('/calls/history/seen', { preHandler: requireAuth }, async (request) => {
    await markCallsSeen(request.identity!.userId);
    return { ok: true };
  });

  // POST /calls/:callId/end — client-initiated call termination. Sets status to
  // 'ended' and records end time for both participants' history.
  app.post<{ Params: { callId: string } }>(
    '/calls/:callId/end',
    { preHandler: requireAuth },
    async (request) => {
      const { callId } = request.params;
      // IDOR guard: only a participant (caller or callee) may end the call.
      // Without this any authenticated user could force-end an arbitrary call
      // by its id. Mirrors the participant check enforced on the socket path.
      if (!(await isParticipant(callId, request.identity!.userId))) {
        throw Errors.forbidden('Not a participant of this call');
      }
      await updateCallStatus(callId, 'ended');
      return { ok: true };
    },
  );

  // Meeting routes live in ./meetings.ts.
}
