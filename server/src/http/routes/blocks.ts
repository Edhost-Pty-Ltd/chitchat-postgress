import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { blockSchema } from '../../domain/schemas/user.js';
import { listBlocked, blockUser, unblockUser } from '../../db/repositories/blocks.js';

export async function registerBlockRoutes(app: FastifyInstance): Promise<void> {
  // GET /blocks — list the authenticated user's blocked contacts (Req 4.12).
  app.get('/blocks', { preHandler: requireAuth }, async (request) => {
    return { blocked: await listBlocked(request.identity!.userId) };
  });

  // POST /blocks — block a user (Req 4.11).
  app.post('/blocks', { preHandler: requireAuth }, async (request, reply) => {
    const blockerId = request.identity!.userId;
    const body = parse(blockSchema, request.body);
    await blockUser(blockerId, body.userId, {
      displayName: body.displayName ?? null,
      photoObjectKey: body.photoObjectKey ?? null,
      phone: body.phone ?? null,
    });
    return reply.code(201).send({ ok: true });
  });

  // DELETE /blocks/:userId — unblock a user (Req 4.11).
  app.delete<{ Params: { userId: string } }>(
    '/blocks/:userId',
    { preHandler: requireAuth },
    async (request) => {
      await unblockUser(request.identity!.userId, request.params.userId);
      return { ok: true };
    },
  );
}
