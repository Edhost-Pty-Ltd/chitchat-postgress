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

  socket.on('meeting:join', async (payload: { meetingId?: string }, ack?: Ack) => {
    const meetingId = payload?.meetingId;
    if (!meetingId || !(await isMeetingParticipant(meetingId, userId))) {
      ack?.({ ok: false, error: 'FORBIDDEN' });
      return;
    }
    await socket.join(rooms.meeting(meetingId));
    await setMeetingJoined(meetingId, userId, true);
    // Emit the updated participant state to the room (Req 8.15) and refresh
    // everyone's calendar (live badge, attendance).
    await emitParticipants(meetingId);
    await broadcastMeetingUpdate(meetingId, 'joined');
    ack?.({ ok: true });
  });

  socket.on('meeting:leave', async (payload: { meetingId?: string }, ack?: Ack) => {
    const meetingId = payload?.meetingId;
    if (meetingId) {
      void socket.leave(rooms.meeting(meetingId));
      await setMeetingJoined(meetingId, userId, false);
      await emitParticipants(meetingId);
      await broadcastMeetingUpdate(meetingId, 'left');
    }
    ack?.({ ok: true });
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
      if (!meetingId || !(await isMeetingParticipant(meetingId, userId))) {
        ack?.({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      if (typeof text === 'string' && text.length > 100_000) {
        ack?.({ ok: false, error: 'TOO_LONG' });
        return;
      }
      const isSystem = payload?.isSystem === true;
      const senderName =
        typeof payload?.senderName === 'string'
          ? payload.senderName.slice(0, 200)
          : isSystem
            ? 'Meeting Recap'
            : null;
      try {
        const saved = await addMeetingMessage(meetingId, userId, text ?? null, mediaObjectKey ?? null, {
          senderName,
          isSystem,
        });
        getIO()?.to(rooms.meeting(meetingId)).emit('meeting:message', {
          meetingId,
          id: saved.id,
          senderId: userId,
          senderName,
          isSystem,
          text: text ?? null,
          mediaObjectKey: mediaObjectKey ?? null,
          createdAt: saved.createdAt,
        });
        ack?.({ ok: true });
      } catch (err) {
        logger.warn({ err, meetingId }, 'meeting:message failed');
        ack?.({ ok: false, error: 'INTERNAL' });
      }
    },
  );

  // Relay meeting signaling between participants (Req 8.17).
  socket.on(
    'meeting:signal',
    async (payload: { meetingId?: string; data?: unknown }, ack?: Ack) => {
      const { meetingId, data } = payload ?? {};
      if (!meetingId || !(await isMeetingParticipant(meetingId, userId))) {
        ack?.({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      socket.to(rooms.meeting(meetingId)).emit('meeting:signal', { meetingId, from: userId, data });
      ack?.({ ok: true });
    },
  );
}
