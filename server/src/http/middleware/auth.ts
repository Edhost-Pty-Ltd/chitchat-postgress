import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, parseBearer, AuthError, type AuthedIdentity } from '../../auth/verifier.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: AuthedIdentity;
  }
}

/**
 * Fastify preHandler that verifies the Bearer token and attaches the resolved
 * identity to the request (Req 2.2, 2.4). Returns 401 with a machine-readable
 * code on any auth failure (Req 2.5). Handlers read `request.identity.userId`
 * and never trust a user id from the body (Req 2.11).
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = parseBearer(request.headers.authorization);
  try {
    request.identity = await verifyToken(token);
  } catch (err) {
    if (err instanceof AuthError) {
      await reply.code(401).send({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }
}
