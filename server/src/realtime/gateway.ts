import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { getEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getPubClient, getSubClient } from '../redis/client.js';
import { verifyToken, AuthError, type AuthedIdentity } from '../auth/verifier.js';
import { setIO } from './emitter.js';
import { registerChatHandlers } from './handlers/chat.js';
import { registerPresenceHandlers } from './handlers/presence.js';
import { registerSignalingHandlers } from './handlers/signaling.js';
import { registerMeetingHandlers } from './handlers/meeting.js';

export interface AuthedSocket extends Socket {
  identity?: AuthedIdentity;
}

/**
 * Attach a Socket.IO server to the HTTP server with the Redis adapter for
 * cross-instance fan-out (Req 5.16) and a handshake that verifies the Firebase
 * ID token (Req 2.7, 2.8). Authenticated sockets auto-join `user:{userId}`.
 */
export function createGateway(httpServer: HttpServer): IOServer {
  const env = getEnv();
  const allowAll = env.CORS_ORIGINS.length === 0 || env.CORS_ORIGINS.includes('*');

  const io = new IOServer(httpServer, {
    cors: {
      origin: allowAll ? true : env.CORS_ORIGINS,
      credentials: true,
    },
  });

  io.adapter(createAdapter(getPubClient(), getSubClient()));
  setIO(io);

  // Handshake auth: reject connections without a valid token (Req 2.8).
  io.use(async (socket: AuthedSocket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    try {
      // A new socket connection is infrequent and long-lived, so pay for a
      // fresh checkRevoked verification rather than trusting the HTTP cache.
      socket.identity = await verifyToken(token, { useCache: false });
      // Anonymous link-request sessions only use REST polling, never sockets.
      if (socket.identity.isAnonymous) {
        const e = new Error('Sign in to connect') as Error & { data?: unknown };
        e.data = { code: 'AUTH_ANONYMOUS_NOT_ALLOWED' };
        next(e);
        return;
      }
      next();
    } catch (err) {
      if (err instanceof AuthError) {
        const e = new Error(err.message) as Error & { data?: unknown };
        e.data = { code: err.code };
        next(e);
        return;
      }
      next(err as Error);
    }
  });

  io.on('connection', (socket: AuthedSocket) => {
    const userId = socket.identity!.userId;
    // Store the userId on socket.data so room membership can be attributed to a
    // user (used by the Push_Dispatcher's userInChatRoom check, Req 6.7).
    socket.data.userId = userId;
    void socket.join(`user:${userId}`);
    logger.debug({ userId, socketId: socket.id }, 'socket connected');

    registerChatHandlers(socket);
    registerPresenceHandlers(socket);
    registerSignalingHandlers(socket);
    registerMeetingHandlers(socket);

    socket.on('disconnect', (reason) => {
      logger.debug({ userId, socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  return io;
}
