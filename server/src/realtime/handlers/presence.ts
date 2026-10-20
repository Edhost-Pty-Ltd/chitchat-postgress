import type { AuthedSocket } from '../gateway.js';
import { emitToUser, rooms } from '../emitter.js';
import {
  addSocket,
  removeSocket,
  refreshPresence,
  setTyping,
  clearTyping,
  chatPeers,
  PRESENCE_TTL_SEC,
} from '../presence.js';
import { getPrivacySettings } from '../../db/repositories/privacy.js';
import { blockedEitherWay } from '../../db/repositories/blocks.js';
import { isMember } from '../../db/repositories/chats.js';
import { getIO } from '../emitter.js';
import { logger } from '../../config/logger.js';

type Ack = (response: { ok: boolean; error?: string }) => void;

/**
 * Compute the peers permitted to see this user's presence/last-seen:
 * chat peers minus anyone blocked either way, minus everyone when the owner's
 * lastSeen privacy is 'Nobody' (Req 7.4, 7.5, 7.9). Peers share a chat so they
 * count as contacts, which satisfies the 'Contacts' setting.
 */
async function visiblePeers(userId: string): Promise<string[]> {
  const privacy = await getPrivacySettings(userId);
  if (privacy.lastSeen === 'Nobody') return [];
  const peers = await chatPeers(userId);
  if (peers.length === 0) return [];
  const blocked = await blockedEitherWay(userId, peers);
  return peers.filter((p) => !blocked.has(p));
}

async function broadcastPresence(userId: string, online: boolean): Promise<void> {
  const peers = await visiblePeers(userId);
  const payload = { userId, online, lastSeen: online ? null : new Date().toISOString() };
  for (const peer of peers) emitToUser(peer, 'presence', payload);
}

export function registerPresenceHandlers(socket: AuthedSocket): void {
  const userId = socket.identity!.userId;

  // Mark online on connect; refresh on a periodic ping (Req 7.1, 7.2).
  void addSocket(userId, socket.id).then((firstSocket) => {
    if (firstSocket) void broadcastPresence(userId, true);
  });

  socket.on('presence:ping', async (_payload: unknown, ack?: Ack) => {
    try {
      await refreshPresence(userId);
      ack?.({ ok: true });
    } catch (err) {
      logger.warn({ err }, 'presence:ping failed');
      ack?.({ ok: false, error: 'INTERNAL' });
    }
  });

  // Typing start/stop relayed to the chat room, block-filtered (Req 7.6, 7.9).
  socket.on('typing:start', async (payload: { chatId?: string }, ack?: Ack) => {
    const chatId = payload?.chatId;
    if (!chatId || !(await isMember(chatId, userId))) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    await setTyping(chatId, userId);
    await relayTyping(chatId, userId, true);
    ack?.({ ok: true });
  });

  socket.on('typing:stop', async (payload: { chatId?: string }, ack?: Ack) => {
    const chatId = payload?.chatId;
    if (!chatId || !(await isMember(chatId, userId))) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    await clearTyping(chatId, userId);
    await relayTyping(chatId, userId, false);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    void removeSocket(userId, socket.id).then((lastSocket) => {
      if (lastSocket) void broadcastPresence(userId, false);
    });
  });
}

/**
 * Relay a typing event to the other members in a chat room, except members who
 * are blocked either way with the typer (Req 7.6, 7.9).
 */
async function relayTyping(chatId: string, userId: string, isTyping: boolean): Promise<void> {
  const io = getIO();
  if (!io) return;
  const socketsInChat = await io.in(rooms.chat(chatId)).fetchSockets();
  const peerIds = Array.from(
    new Set(
      socketsInChat
        .map((s) => (s.data as { userId?: string }).userId)
        .filter((id): id is string => !!id && id !== userId),
    ),
  );
  if (peerIds.length === 0) return;
  const blocked = await blockedEitherWay(userId, peerIds);
  for (const peer of peerIds) {
    if (blocked.has(peer)) continue;
    emitToUser(peer, 'typing', { chatId, userId, isTyping });
  }
}

export { PRESENCE_TTL_SEC };
