import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { Errors } from '../errors.js';
import { getUserById } from '../../db/repositories/users.js';
import { getPrivacySettings } from '../../db/repositories/privacy.js';
import { query } from '../../db/pool.js';
import { isOnline } from '../../realtime/presence.js';

interface PresenceResponse {
  userId: string;
  online: boolean;
  lastSeen: string | null;
  lastSeenVisible: boolean;
}

export async function registerPresenceRoutes(app: FastifyInstance): Promise<void> {
  // GET /presence/:userId — current presence + last seen, privacy/block gated
  // (Req 7.4, 7.5). Used by useOtherUserPresence/useLastSeen for initial state.
  app.get<{ Params: { userId: string } }>(
    '/presence/:userId',
    { preHandler: requireAuth },
    async (request): Promise<PresenceResponse> => {
      const viewerId = request.identity!.userId;
      const targetId = request.params.userId;

      const target = await getUserById(targetId);
      if (!target) throw Errors.notFound('User not found');

      // If the target blocked the viewer, surface only the last-seen snapshot
      // taken at block time (mirrors the legacy client behavior).
      const blockRow = await query<{ last_seen_at_block: Date | null }>(
        'SELECT last_seen_at_block FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
        [targetId, viewerId],
      );
      if (blockRow.rows[0]) {
        const snap = blockRow.rows[0].last_seen_at_block;
        return {
          userId: targetId,
          online: false,
          lastSeen: snap ? snap.toISOString() : null,
          lastSeenVisible: true,
        };
      }

      const privacy = await getPrivacySettings(targetId);
      // Peers that reach this endpoint are chat contacts, so 'Contacts' is visible;
      // only 'Nobody' hides last seen / online status (Req 7.5).
      const lastSeenVisible = privacy.lastSeen !== 'Nobody';

      if (!lastSeenVisible) {
        return { userId: targetId, online: false, lastSeen: null, lastSeenVisible: false };
      }

      const online = await isOnline(targetId);
      return {
        userId: targetId,
        online,
        lastSeen: online ? null : target.last_seen ? target.last_seen.toISOString() : null,
        lastSeenVisible: true,
      };
    },
  );
}
