import type { AuthedSocket } from '../gateway.js';
import { rooms, getIO } from '../emitter.js';
import {
  isMeetingParticipant,
  setMeetingJoined,
  addMeetingMessage,
  getMeeting,
} from '../../db/repositories/meetings.js';
import { logger } from '../../config/logger.js';

type Ack = (response: { ok: boolean; error?: string }) => void;

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
    // Emit the updated participant state to the room (Req 8.15).
    const state = await getMeeting(meetingId);
    getIO()?.to(rooms.meeting(meetingId)).emit('meeting:participants', { meetingId, state });
    ack?.({ ok: true });
  });

  socket.on('meeting:leave', async (payload: { meetingId?: string }, ack?: Ack) => {
    const meetingId = payload?.meetingId;
    if (meetingId) {
      void socket.leave(rooms.meeting(meetingId));
      await setMeetingJoined(meetingId, userId, false);
      const state = await getMeeting(meetingId);
      getIO()?.to(rooms.meeting(meetingId)).emit('meeting:participants', { meetingId, state });
    }
    ack?.({ ok: true });
  });

  // Persist + deliver a meeting chat message (Req 8.16).
  socket.on(
    'meeting:message',
    async (payload: { meetingId?: string; text?: string; mediaObjectKey?: string }, ack?: Ack) => {
      const { meetingId, text, mediaObjectKey } = payload ?? {};
      if (!meetingId || !(await isMeetingParticipant(meetingId, userId))) {
        ack?.({ ok: false, error: 'FORBIDDEN' });
        return;
      }
      try {
        const saved = await addMeetingMessage(meetingId, userId, text ?? null, mediaObjectKey ?? null);
        getIO()?.to(rooms.meeting(meetingId)).emit('meeting:message', {
          meetingId,
          id: saved.id,
          senderId: userId,
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
