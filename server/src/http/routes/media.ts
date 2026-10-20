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
import { isMember, sharesChatWith } from '../../db/repositories/chats.js';
import { isMeetingParticipant } from '../../db/repositories/meetings.js';
import { getPrivacySettings } from '../../db/repositories/privacy.js';
import { canViewStatusMediaKey } from '../../db/repositories/statuses.js';
import { isVisibleTo } from '../../domain/privacy.js';

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

// Per-category object-key shapes. Keys are authorized by matching one of these
// exactly, which also rejects path traversal ('..'), empty segments, and
// unexpected prefixes before any authorization decision (FINDING-2).
//   avatars/{ownerId}/{file}
//   status/{ownerId}/{file}
//   chats/{chatId}/(media|voice)/{file}
//   groups/{chatId}/{file}
//   meetings/{meetingId}/{file}
const SEG = '[\\w.-]+'; // no slashes, no '..' (a bare '..' can't match \w.- plus length, but we also reject below)
const KEY_PATTERNS = {
  avatars: new RegExp(`^avatars/(${SEG})/${SEG}$`),
  status: new RegExp(`^status/(${SEG})/${SEG}$`),
  chats: new RegExp(`^chats/(${SEG})/(?:media|voice)/${SEG}$`),
  groups: new RegExp(`^groups/(${SEG})/${SEG}$`),
  meetings: new RegExp(`^meetings/(${SEG})/${SEG}$`),
} as const;

function hasTraversal(objectKey: string): boolean {
  return objectKey.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * Authorize read of an object key (Req 10.6). Keys must match a known
 * per-category shape; then:
 *   - avatars: owner always; others only if the owner's profilePhoto privacy
 *     permits it (Everyone, or Contacts when the viewer shares a chat).
 *   - status: owner always; others only if a status referencing the key is
 *     currently visible to the viewer (block + visibility re-checked here).
 *   - chats/groups: chat membership. meetings: participation.
 * Anything else is denied.
 */
async function authorizeRead(userId: string, objectKey: string): Promise<boolean> {
  if (hasTraversal(objectKey)) return false;

  const avatar = KEY_PATTERNS.avatars.exec(objectKey);
  if (avatar) {
    const ownerId = avatar[1];
    if (ownerId === userId) return true;
    const privacy = await getPrivacySettings(ownerId);
    return isVisibleTo(privacy.profilePhoto, await sharesChatWith(ownerId, userId));
  }

  const status = KEY_PATTERNS.status.exec(objectKey);
  if (status) {
    const ownerId = status[1];
    if (ownerId === userId) return true;
    return canViewStatusMediaKey(userId, objectKey);
  }

  const chat = KEY_PATTERNS.chats.exec(objectKey);
  if (chat) return isMember(chat[1], userId);

  const group = KEY_PATTERNS.groups.exec(objectKey);
  if (group) return isMember(group[1], userId);

  const meeting = KEY_PATTERNS.meetings.exec(objectKey);
  if (meeting) return isMeetingParticipant(meeting[1], userId);

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
