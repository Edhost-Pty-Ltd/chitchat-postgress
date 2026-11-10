import { readFileSync } from 'node:fs';
import * as nodeHttps from 'node:https';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import { getEnv } from '../config/env.js';
import { loggerOptions } from '../config/logger.js';
import { ApiError } from './errors.js';
import { registerHealthRoute } from './routes/health.js';
import { registerMeRoutes } from './routes/me.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerPushTokenRoutes } from './routes/pushTokens.js';
import { registerBlockRoutes } from './routes/blocks.js';
import { registerChatRoutes } from './routes/chats.js';
import { registerPresenceRoutes } from './routes/presence.js';
import { registerCallRoutes } from './routes/calls.js';
import { registerStatusRoutes } from './routes/statuses.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerFeatureRoutes } from './routes/features.js';
import { registerMeetingRoutes } from './routes/meetings.js';
import { registerMeetingGuestRoutes } from './routes/meetingGuest.js';
import { registerPlacesRoutes } from './routes/places.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerRegistrationRoutes } from './routes/registration.js';

/**
 * Build the Fastify app: structured logging with a request id (Req 1.10),
 * CORS restricted to the configured origin allow-list (Req 12.5), a shared
 * error handler, and the /health route (Req 1.8, 1.9).
 */
export async function buildServer(): Promise<FastifyInstance> {
  const env = getEnv();

  // HTTPS for local dev: use Node's https.createServer via serverFactory so
  // Fastify's type stays as the plain HTTP flavour (all route types stay
  // compatible). The TLS context is set once at startup; the server cert is
  // read from disk using paths in .env.
  let serverFactory: FastifyServerOptions['serverFactory'] | undefined;
  if (env.USE_HTTPS && env.HTTPS_KEY_PATH && env.HTTPS_CERT_PATH) {
    try {
      const tlsOpts = {
        key:  readFileSync(env.HTTPS_KEY_PATH),
        cert: readFileSync(env.HTTPS_CERT_PATH),
      };
      serverFactory = (handler) => {
        return nodeHttps.createServer(tlsOpts, handler);
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Failed to load HTTPS certificates; falling back to HTTP:', err);
    }
  }

  const app = Fastify({
    logger: loggerOptions,
    ...(serverFactory ? { serverFactory } : {}),
    // Attach a request id to every request for traceable JSON logs (Req 1.10).
    genReqId: (req) => (req.headers['x-request-id'] as string) ?? randomUUID(),
    requestIdHeader: 'x-request-id',
    requestIdLogLabel: 'requestId',
    trustProxy: true,
  });

  const allowAll = env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes('*');
  await app.register(cors, {
    origin: allowAll ? true : env.CORS_ORIGINS,
    credentials: true,
  });

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ApiError) {
      request.log.warn({ code: err.code, statusCode: err.statusCode }, err.message);
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    // Fastify validation errors → 400.
    if ((err as { validation?: unknown }).validation) {
      return reply
        .code(400)
        .send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    request.log.error({ err }, 'Unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });

  await registerHealthRoute(app);
  await registerMeRoutes(app);
  await registerContactRoutes(app);
  await registerPushTokenRoutes(app);
  await registerBlockRoutes(app);
  await registerChatRoutes(app);
  await registerPresenceRoutes(app);
  await registerCallRoutes(app);
  await registerStatusRoutes(app);
  await registerMediaRoutes(app);
  await registerFeatureRoutes(app);
  await registerMeetingRoutes(app);
  await registerMeetingGuestRoutes(app);
  await registerPlacesRoutes(app);
  await registerReportRoutes(app);
  await registerRegistrationRoutes(app);

  return app;
}
