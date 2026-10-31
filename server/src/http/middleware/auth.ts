import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken, parseBearer, AuthError, type AuthedIdentity } from '../../auth/verifier.js';
import { accountGateStatus } from '../../db/repositories/users.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity?: AuthedIdentity;
  }
}

async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply,
  allowAnonymous: boolean,
): Promise<void> {
  const token = parseBearer(request.headers.authorization);
  try {
    request.identity = await verifyToken(token);
  } catch (err) {
    if (err instanceof AuthError) {
      const status = err.code === 'AUTH_NOT_CONFIGURED' ? 503 : 401;
      await reply.code(status).send({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }
  if (request.identity?.isAnonymous && !allowAnonymous) {
    await reply.code(403).send({
      error: { code: 'AUTH_ANONYMOUS_NOT_ALLOWED', message: 'Sign in to use this feature' },
    });
  }
}

/**
 * Fastify preHandler that verifies the Bearer token and attaches the resolved
 * identity to the request (Req 2.2, 2.4). Returns 401 with a machine-readable
 * code on any auth failure (Req 2.5). Handlers read `request.identity.userId`
 * and never trust a user id from the body (Req 2.11). Anonymous link-request
 * sessions are refused here.
 *
 * It also enforces the account gate server-side, so a modified client cannot
 * skip a screen to get in:
 *  - unregistered (OTP passed, face registration not done): only GET /me
 *    (answers 404) and POST /me/register are reachable; everything else is
 *    403 REGISTRATION_REQUIRED.
 *  - reported (verification required): only GET /me and POST /me/verify;
 *    everything else is 423 IDENTITY_VERIFICATION_REQUIRED.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply, false);
  if (reply.sent || !request.identity || request.identity.isGuest) return;

  const status = await accountGateStatus(request.identity.userId);
  if (status === 'ok') return;

  const route = request.routeOptions.url;
  const isGetMe = request.method === 'GET' && route === '/me';

  if (status === 'unregistered') {
    const allowed = isGetMe || (request.method === 'POST' && route === '/me/register');
    if (!allowed) {
      await reply.code(403).send({
        error: {
          code: 'REGISTRATION_REQUIRED',
          message: 'Complete face registration to continue',
        },
      });
    }
    return;
  }

  const allowedWhileUnverified = isGetMe || (request.method === 'POST' && route === '/me/verify');
  if (!allowedWhileUnverified) {
    await reply.code(423).send({
      error: {
        code: 'IDENTITY_VERIFICATION_REQUIRED',
        message: 'Complete live identity verification to continue',
      },
    });
  }
}

/**
 * Like requireAuth, but also accepts the anonymous session a not-yet-linked
 * companion device uses while it creates and polls its link request.
 */
export async function requireAuthAllowAnonymous(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await authenticate(request, reply, true);
}

/**
 * Owner-only actions (privacy, blocks, phone/profile changes, linking and
 * removing devices, deleting statuses, managing businesses) are not available
 * on companion devices — mirrors the old Firestore `!isCompanion()` rules.
 * Use after requireAuth: `{ preHandler: [requireAuth, requirePrimaryDevice] }`.
 */
export async function requirePrimaryDevice(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (reply.sent) return;
  if (request.identity?.isCompanion) {
    await reply.code(403).send({
      error: {
        code: 'COMPANION_NOT_ALLOWED',
        message: 'This action is only available on your primary device',
      },
    });
  }
}
