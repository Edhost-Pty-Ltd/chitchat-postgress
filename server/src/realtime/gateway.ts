import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { getEnv } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getPubClient, getSubClient } from '../redis/client.js';
import { verifyToken, AuthError, type AuthedIdentity } from '../auth/verifier.js';
import { accountGateStatus } from '../db/repositories/users.js';
import { verifyGuestToken } from '../auth/guestToken.js';
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

    // Browser meeting guests connect with a guest token instead of a Firebase
    // ID token. A guest is scoped to a single meeting and never gets a user row.
    const guestToken = socket.handshake.auth?.guestToken as string | undefined;
    if (guestToken) {
      const claims = verifyGuestToken(guestToken);
      if (!claims) {
        const e = new Error('Invalid or expired guest token') as Error & { data?: unknown };
        e.data = { code: 'AUTH_GUEST_INVALID' };
        next(e);
        return;
      }
      socket.identity = {
        userId: claims.guestId,
        firebaseUid: claims.guestId,
        phoneNumber: null,
        isGuest: true,
        guestMeetingId: claims.meetingId,
        displayName: claims.displayName,
      };
      next();
      return;
    }

    try {
      socket.identity = await verifyToken(token);
      // Anonymous link-request sessions only use REST polling, never sockets.
      if (socket.identity.isAnonymous) {
        const e = new Error('Sign in to connect') as Error & { data?: unknown };
        e.data = { code: 'AUTH_ANONYMOUS_NOT_ALLOWED' };
        next(e);
        return;
      }
      const gate = await accountGateStatus(socket.identity.userId);
      // No account until face registration completes. Not an AUTH_* code, so
      // the client does not retry; it reconnects after registering.
      if (gate === 'unregistered') {
        const e = new Error('Complete registration to connect') as Error & { data?: unknown };
        e.data = { code: 'REGISTRATION_REQUIRED' };
        next(e);
        return;
      }
      // Keep a reported socket connected only to its personal room so it can
      // receive status updates. Feature handlers are withheld below.
      socket.data.identityVerificationRequired = gate === 'verification_required';
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
    socket.data.isGuest = socket.identity!.isGuest === true;
    socket.data.guestMeetingId = socket.identity!.guestMeetingId;
    void socket.join(`user:${userId}`);
    logger.debug({ userId, socketId: socket.id }, 'socket connected');

    // Canonical check on every client packet closes the handshake/report race:
    // even if a socket connected just as a report committed and briefly has
    // feature handlers, no post-report chat/call/meeting packet can reach them.
    if (!socket.identity!.isGuest) {
      socket.use(async (_packet, next) => {
        try {
          const gate = await accountGateStatus(userId);
          if (gate !== 'ok') {
            next(
              new Error(
                gate === 'unregistered' ? 'REGISTRATION_REQUIRED' : 'IDENTITY_VERIFICATION_REQUIRED',
              ),
            );
            return;
          }
          next();
        } catch (err) {
          next(err as Error);
        }
      });
    }

    const verificationRestricted = socket.data.identityVerificationRequired === true;
    if (verificationRestricted) {
      logger.info(
        { userId, socketId: socket.id },
        'reported user connected in identity-status-only mode',
      );
    } else {
      registerChatHandlers(socket);
      registerPresenceHandlers(socket);
      registerSignalingHandlers(socket);
      registerMeetingHandlers(socket);
    }

    socket.on('disconnect', (reason) => {
      logger.debug({ userId, socketId: socket.id, reason }, 'socket disconnected');
    });
  });

  return io;
}
