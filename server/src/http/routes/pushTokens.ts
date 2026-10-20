import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { pushTokenSchema } from '../../domain/schemas/user.js';
import { addPushToken, removePushToken } from '../../db/repositories/pushTokens.js';

export async function registerPushTokenRoutes(app: FastifyInstance): Promise<void> {
  // POST /push-tokens — register an Expo push token (Req 4.7).
  app.post('/push-tokens', { preHandler: requireAuth }, async (request, reply) => {
    const { token, platform, deviceId } = parse(pushTokenSchema, request.body);
    // A companion's token is always tied to the device it was linked with.
    const device = request.identity!.isCompanion ? request.identity!.deviceId ?? null : deviceId ?? null;
    await addPushToken(request.identity!.userId, token, platform ?? null, device);
    return reply.code(201).send({ ok: true });
  });

  // DELETE /push-tokens/:token — remove this device's push token (Req 4.8).
  app.delete<{ Params: { token: string } }>(
    '/push-tokens/:token',
    { preHandler: requireAuth },
    async (request) => {
      await removePushToken(request.identity!.userId, decodeURIComponent(request.params.token));
      return { ok: true };
    },
  );
}
