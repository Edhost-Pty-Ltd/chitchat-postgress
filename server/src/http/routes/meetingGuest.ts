import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parse } from '../validate.js';
import { Errors } from '../errors.js';
import { getMeeting } from '../../db/repositories/meetings.js';
import { issueGuestToken } from '../../auth/guestToken.js';
import { checkRateLimit } from '../../redis/rateLimit.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Load meet.html — read per-request in development so edits take effect
// without a server restart; cached in production for performance.
const MEET_HTML_PATH = resolve(__dirname, '../../public/meet.html');

function getMeetHtml(): string {
  // In production, read once and cache. In development, read fresh each time
  // so you can edit meet.html without restarting the server.
  if (process.env.NODE_ENV === 'production') {
    if (!_meetHtmlCache) _meetHtmlCache = readFileSync(MEET_HTML_PATH, 'utf-8');
    return _meetHtmlCache;
  }
  return readFileSync(MEET_HTML_PATH, 'utf-8');
}
let _meetHtmlCache: string | null = null;

/**
 * ─── Public meeting routes for browser guests ───────────────────────────────
 * These endpoints are UNAUTHENTICATED (no Firebase token) so a participant who
 * opens https://chitchatbusiness.com/meet/<id> in a browser can:
 *   1. GET  /meet/:id/info  — check the meeting exists / is joinable (no secrets).
 *   2. POST /meet/:id/guest — get a short-lived guest token scoped to this
 *      meeting, which the browser then uses on the Socket.IO handshake.
 *
 * They expose only the minimum a pre-join screen needs (title, type, active).
 * Knowing a UUID lets you JOIN as a guest but never read participants, chat
 * history, recordings, or any other meeting.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const guestJoinSchema = z
  .object({ displayName: z.string().trim().min(1).max(80) })
  .strict();

// Per-IP limits so the public endpoints can't be abused to probe UUIDs or mint
// tokens in bulk.
const INFO_LIMIT = 60;
const JOIN_LIMIT = 20;
const WINDOW_SEC = 60;

export async function registerMeetingGuestRoutes(app: FastifyInstance): Promise<void> {
  // GET /meet/:id — serve the standalone meeting room HTML page.
  // This route intentionally has NO auth requirement so anyone with a link can
  // join as a guest. The HTML page itself calls /meet/:id/info and
  // /meet/:id/guest to authenticate via a short-lived guest JWT.
  app.get<{ Params: { id: string } }>('/meet/:id', async (_request, reply) => {
    return reply
      .code(200)
      .header('Content-Type', 'text/html; charset=utf-8')
      // No-store: the page is tiny and always needs a fresh guest token.
      .header('Cache-Control', 'no-store')
      .send(getMeetHtml());
  });
  app.get<{ Params: { id: string } }>('/meet/:id/info', async (request, reply) => {
    const ip = request.ip ?? 'unknown';
    const rl = await checkRateLimit(ip, 'meet-info', INFO_LIMIT, WINDOW_SEC);
    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      throw Errors.tooManyRequests('Too many requests');
    }

    const meetingId = request.params.id;
    if (!UUID_RE.test(meetingId)) {
      return { exists: false, joinable: false, reason: 'invalid' as const };
    }
    const state = await getMeeting(meetingId);
    if (!state) {
      return { exists: false, joinable: false, reason: 'not_found' as const };
    }
    // A meeting is joinable while it has not been explicitly ended.
    const ended = !!state.endedAt;
    return {
      exists: true,
      joinable: !ended,
      reason: ended ? ('ended' as const) : ('ok' as const),
      meeting: {
        id: state.id,
        title: state.title,
        type: state.type,
        isActive: state.isActive,
        endedAt: state.endedAt,
        joinedCount: state.joinedMembers.length,
      },
    };
  });

  // POST /meet/:id/guest — mint a guest token for this one meeting.
  app.post<{ Params: { id: string } }>('/meet/:id/guest', async (request, reply) => {
    const ip = request.ip ?? 'unknown';
    const rl = await checkRateLimit(ip, 'meet-guest', JOIN_LIMIT, WINDOW_SEC);
    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfterSec));
      throw Errors.tooManyRequests('Too many requests');
    }

    const meetingId = request.params.id;
    if (!UUID_RE.test(meetingId)) throw Errors.badRequest('Invalid meeting id');

    const { displayName } = parse(guestJoinSchema, request.body);

    const state = await getMeeting(meetingId);
    if (!state) throw Errors.notFound('Meeting not found');
    if (state.endedAt) throw Errors.forbidden('This meeting has ended');

    const { token, claims } = issueGuestToken(meetingId, displayName);
    return reply.code(201).send({
      token,
      guestId: claims.guestId,
      displayName: claims.displayName,
      meeting: { id: state.id, title: state.title, type: state.type },
    });
  });
}
