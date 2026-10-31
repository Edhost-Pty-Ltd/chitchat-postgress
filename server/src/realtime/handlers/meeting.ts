import type { AuthedSocket } from '../gateway.js';
import { rooms, getIO, emitToUser } from '../emitter.js';
import {
  isMeetingParticipant,
  setMeetingJoined,
  addMeetingMessage,
  getMeeting,
  setParticipantMuted,
  kickParticipant,
} from '../../db/repositories/meetings.js';
import { broadcastMeetingUpdate } from '../../domain/meetings.js';
import { logger } from '../../config/logger.js';

type Ack = (response: { ok: boolean; error?: string }) => void;

async function emitParticipants(meetingId: string): Promise<void> {
  const state = await getMeeting(meetingId);
  getIO()?.to(rooms.meeting(meetingId)).emit('meeting:participants', { meetingId, state });
}

export function registerMeetingHandlers(socket: AuthedSocket): void {
  const userId = socket.identity!.userId;
  const isGuest = socket.identity!.isGuest === true;
  const guestMeetingId = socket.identity!.guestMeetingId;
  const guestName = socket.identity!.displayName ?? 'Guest';

  /**
   * A caller may act on a meeting if they are an invited participant OR a guest
   * whose token is scoped to exactly this meeting. Guests have no DB row, so we
   * never touch meeting_participants for them.
   */
  const canAccess = async (meetingId: string): Promise<boolean> => {
    if (isGuest) return meetingId === guestMeetingId;
    return isMeetingParticipant(meetingId, userId);
  };

  socket.on('meeting:join', async (payload: { meetingId?: string }, ack?: Ack) => {
    const meetingId = payload?.meetingId;
    if (!meetingId || !(await canAccess(meetingId))) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    await socket.join(rooms.meeting(meetingId));
    if (!isGuest) {
      // Only real participants have a DB presence row; guests are room-only.
      await setMeetingJoined(meetingId, userId, true);
    }
    // Tell everyone already in the room about this joiner (so peers can offer).
    socket.to(rooms.meeting(meetingId)).emit('meeting:peer-joined', {
      meetingId,
      userId,
      isGuest,
      displayName: isGuest ? guestName : undefined,
    });
    // Emit the updated participant state to the room (Req 8.15) and refresh
    // everyone's calendar (live badge, attendance).
    await emitParticipants(meetingId);
    if (!isGuest) await broadcastMeetingUpdate(meetingId, 'joined');
    ack?.({ ok: true });
  });

  socket.on('meeting:leave', async (payload: { meetingId?: string }, ack?: Ack) => {
    const meetingId = payload?.meetingId;
    if (meetingId) {
      void socket.leave(rooms.meeting(meetingId));
      socket.to(rooms.meeting(meetingId)).emit('meeting:peer-left', { meetingId, userId });
      if (!isGuest) {
        await setMeetingJoined(meetingId, userId, false);
        await broadcastMeetingUpdate(meetingId, 'left');
      }
      await emitParticipants(meetingId);
    }
    ack?.({ ok: true });
  });

  // Browser guests disconnect by closing the tab — tell the room so peers tear
  // down the connection and the participant tile disappears.
  socket.on('disconnect', () => {
    if (!guestMeetingId) return;
    socket.to(rooms.meeting(guestMeetingId)).emit('meeting:peer-left', {
      meetingId: guestMeetingId,
      userId,
    });
  });

  // Organizer controls: mute / unmute / remove (old mutedUsers / kickedUsers).
  const organizerAction = async (
    payload: { meetingId?: string; targetId?: string },
    ack: Ack | undefined,
    action: (meetingId: string, targetId: string) => Promise<void>,
  ) => {
    const { meetingId, targetId } = payload ?? {};
    if (!meetingId || !targetId) {
      ack?.({ ok: false, error: 'BAD_REQUEST' });
      return;
    }
    const state = await getMeeting(meetingId);
    if (!state || state.organizerId !== userId) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    try {
      await action(meetingId, targetId);
      await emitParticipants(meetingId);
      await broadcastMeetingUpdate(meetingId, 'participants');
      ack?.({ ok: true });
    } catch (err) {
      logger.warn({ err, meetingId }, 'meeting organizer action failed');
      ack?.({ ok: false, error: 'INTERNAL' });
    }
  };

  socket.on('meeting:mute', (payload: { meetingId?: string; targetId?: string }, ack?: Ack) =>
    organizerAction(payload, ack, async (meetingId, targetId) => {
      await setParticipantMuted(meetingId, targetId, true);
      emitToUser(targetId, 'meeting:muted', { meetingId, muted: true });
    }),
  );

  socket.on('meeting:unmute', (payload: { meetingId?: string; targetId?: string }, ack?: Ack) =>
    organizerAction(payload, ack, async (meetingId, targetId) => {
      await setParticipantMuted(meetingId, targetId, false);
      emitToUser(targetId, 'meeting:muted', { meetingId, muted: false });
    }),
  );

  socket.on('meeting:kick', (payload: { meetingId?: string; targetId?: string }, ack?: Ack) =>
    organizerAction(payload, ack, async (meetingId, targetId) => {
      if (targetId === userId) throw new Error('Organizer cannot remove themselves');
      await kickParticipant(meetingId, targetId);
      emitToUser(targetId, 'meeting:kicked', { meetingId });
      // Drop the removed user's sockets from the meeting room.
      getIO()?.in(rooms.user(targetId)).socketsLeave(rooms.meeting(meetingId));
    }),
  );

  // Persist + deliver a meeting chat message (Req 8.16). System posts (recap /
  // minutes) carry a label instead of the sender's name.
  socket.on(
    'meeting:message',
    async (
      payload: {
        meetingId?: string;
        text?: string;
        mediaObjectKey?: string;
        isSystem?: boolean;
        senderName?: string;
      },
      ack?: Ack,
    ) => {
      const { meetingId, text, mediaObjectKey } = payload ?? {};
      if (!meetingId || !(await canAccess(meetingId))) {
        ack?.({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      if (typeof text === 'string' && text.length > 100_000) {
        ack?.({ ok: false, error: 'TOO_LONG' });
        return;
      }
      const isSystem = payload?.isSystem === true;
      const senderName = isGuest
        ? guestName
        : typeof payload?.senderName === 'string'
          ? payload.senderName.slice(0, 200)
          : isSystem
            ? 'Meeting Recap'
            : null;
      try {
        // Guests have no users row (FK), so their chat is relayed live only and
        // not persisted to meeting_messages. Real participants are persisted.
        let id: string;
        let createdAt: string;
        if (isGuest) {
          id = `g-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          createdAt = new Date().toISOString();
        } else {
          const saved = await addMeetingMessage(
            meetingId,
            userId,
            text ?? null,
            mediaObjectKey ?? null,
            { senderName, isSystem },
          );
          id = saved.id;
          createdAt = saved.createdAt;
        }
        getIO()?.to(rooms.meeting(meetingId)).emit('meeting:message', {
          meetingId,
          id,
          senderId: userId,
          senderName,
          isSystem,
          text: text ?? null,
          mediaObjectKey: mediaObjectKey ?? null,
          createdAt,
        });
        ack?.({ ok: true });
      } catch (err) {
        logger.warn({ err, meetingId }, 'meeting:message failed');
        ack?.({ ok: false, error: 'INTERNAL' });
      }
    },
  );

  // Relay meeting signaling between participants (Req 8.17). For a mesh of many
  // participants, offers/answers/ICE are targeted at ONE peer via `to`; when
  // `to` is omitted the signal is broadcast to the whole room (back-compat).
  socket.on(
    'meeting:signal',
    async (payload: { meetingId?: string; to?: string; data?: unknown }, ack?: Ack) => {
      const { meetingId, to, data } = payload ?? {};
      if (!meetingId || !(await canAccess(meetingId))) {
        ack?.({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      const relayed = { meetingId, from: userId, to, data };
      if (to) {
        // Targeted: deliver only to the named peer's socket(s) in this room.
        getIO()?.to(rooms.user(to)).emit('meeting:signal', relayed);
      } else {
        socket.to(rooms.meeting(meetingId)).emit('meeting:signal', relayed);
      }
      ack?.({ ok: true });
    },
  );
}
