import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import { checkRateLimit } from '../../redis/rateLimit.js';
import { uploadUrlSchema, downloadUrlSchema } from '../../domain/schemas/media.js';
import {
  buildObjectKey,
  validateUpload,
  presignUpload,
  presignDownload,
  assertSelfScoped,
  MediaValidationError,
  type MediaCategory,
} from '../../media/presign.js';
import { isMember } from '../../db/repositories/chats.js';
import { isMeetingParticipant } from '../../db/repositories/meetings.js';

const UPLOAD_LIMIT = 60; // upload-url requests per window
const UPLOAD_WINDOW_SEC = 60;

/**
 * Authorize that `userId` may write under `category`. Self-scoped categories
 * (avatar/status) embed the caller id; chat/group require membership; meeting
 * requires participation (Req 10.3).
 */
async function authorizeWrite(
  userId: string,
  category: MediaCategory,
  params: { chatId?: string; meetingId?: string },
): Promise<void> {
  if (assertSelfScoped(category)) return;
  if (category === 'chat-media' || category === 'chat-voice' || category === 'group') {
    if (!params.chatId || !(await isMember(params.chatId, userId))) {
      throw Errors.forbidden('Not a member of this chat');
    }
    return;
  }
  if (category === 'meeting') {
    if (!params.meetingId || !(await isMeetingParticipant(params.meetingId, userId))) {
      throw Errors.forbidden('Not a participant of this meeting');
    }
    return;
  }
  throw Errors.forbidden('Unauthorized media category');
}

/**
 * Authorize read of an object key. The caller may read their own avatar/status,
 * and any chat/group/meeting object they are a member/participant of (Req 10.6).
 */
async function authorizeRead(userId: string, objectKey: string): Promise<boolean> {
  const parts = objectKey.split('/');
  const kind = parts[0];
  if (kind === 'avatars' || kind === 'status') {
    return parts[1] === userId;
  }
  if (kind === 'chats' || kind === 'groups') {
    return isMember(parts[1], userId);
  }
  if (kind === 'meetings') {
    return isMeetingParticipant(parts[1], userId);
  }
  return false;
}

export async function registerMediaRoutes(app: FastifyInstance): Promise<void> {
  // POST /media/upload-url — presigned PUT URL + object key (Req 10.1-10.5).
  app.post('/media/upload-url', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.identity!.userId;

    const rl = await checkRateLimit(userId, 'media-upload', UPLOAD_LIMIT, UPLOAD_WINDOW_SEC);
    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      throw Errors.tooManyRequests('Media upload rate limit exceeded');
    }

    const body = parse(uploadUrlSchema, request.body);
    const category = body.category as MediaCategory;

    await authorizeWrite(userId, category, { chatId: body.chatId, meetingId: body.meetingId });

    try {
      validateUpload(category, body.contentType, body.sizeBytes);
      const objectKey = buildObjectKey(userId, category, {
        chatId: body.chatId,
        meetingId: body.meetingId,
        ext: body.ext,
      });
      const target = await presignUpload(objectKey, body.contentType);
      return reply.code(201).send(target);
    } catch (err) {
      if (err instanceof MediaValidationError) throw Errors.badRequest(err.message);
      throw err;
    }
  });

  // POST /media/download-url — presigned GET URL(s) for authorized keys (Req 10.6).
  app.post('/media/download-url', { preHandler: requireAuth }, async (request) => {
    const userId = request.identity!.userId;
    const { objectKeys } = parse(downloadUrlSchema, request.body);

    const urls: Record<string, string> = {};
    for (const key of objectKeys) {
      if (await authorizeRead(userId, key)) {
        urls[key] = await presignDownload(key);
      }
    }
    return { urls };
  });
}
