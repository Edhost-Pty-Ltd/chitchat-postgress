// ─── Meeting side effects ────────────────────────────────────────────────────
// Invitations, realtime refreshes and the recording → AI minutes pipeline.

import { getOrCreateDirectChat } from '../db/repositories/chats.js';
import { sendMessage } from '../db/repositories/messages.js';
import {
  getMeeting,
  getMeetingRecording,
  setRecordingStatus,
  setMeetingMinutes,
  addMeetingMessage,
} from '../db/repositories/meetings.js';
import { emitToUser, emitToMeeting } from '../realtime/emitter.js';
import { summarizeRecordingObject } from '../ai/summarizeRecording.js';
import { fanOutMessage } from './messaging.js';
import { logger } from '../config/logger.js';

/**
 * Push the latest meeting state to every invited (and removed) user's personal
 * room so Calendar lists and open meeting rooms refresh — the replacement for
 * the old Firestore onSnapshot listeners.
 */
export async function broadcastMeetingUpdate(meetingId: string, reason: string): Promise<void> {
  const state = await getMeeting(meetingId);
  if (!state) return;
  const recipients = new Set([...state.participants, ...state.kickedUsers]);
  for (const uid of recipients) {
    emitToUser(uid, 'meeting:updated', { meetingId, reason, state });
  }
}

/**
 * Invite people the way the old app did: a system message from the organizer
 * in each invitee's direct chat, which also triggers their push notification.
 */
export async function sendMeetingInvites(
  organizerId: string,
  organizerName: string,
  title: string,
  inviteeIds: string[],
): Promise<void> {
  for (const inviteeId of inviteeIds) {
    if (inviteeId === organizerId) continue;
    try {
      const chatId = await getOrCreateDirectChat(organizerId, inviteeId);
      const { message, created } = await sendMessage(chatId, organizerId, {
        type: 'system',
        subtype: 'meeting_invite',
        text: `You're invited to the meeting "${title}" by ${organizerName}.`,
      });
      if (created) await fanOutMessage(message, organizerName);
    } catch (err) {
      logger.warn({ err, inviteeId }, 'meeting invite failed');
    }
  }
}

// One summarization per recording at a time; concurrent callers share it.
const inflight = new Map<string, Promise<string>>();

/**
 * Generate AI minutes for a recording (old summarizeMeetingRecording). Saves
 * them on the recording and the meeting, optionally posts them to the meeting
 * chat (the in-call "Meeting minutes generated" post), and refreshes clients.
 */
export function summarizeMeetingRecording(
  meetingId: string,
  recordingId: string,
  opts: { postToChat: boolean; fallbackSenderId: string },
): Promise<string> {
  const existing = inflight.get(recordingId);
  if (existing) return existing;

  const run = (async () => {
    const rec = await getMeetingRecording(recordingId);
    if (!rec || rec.meetingId !== meetingId) throw new Error('Recording not found');

    await setRecordingStatus(recordingId, 'processing');
    await broadcastMeetingUpdate(meetingId, 'recording-processing');
    try {
      const minutes = await summarizeRecordingObject(rec.objectKey, rec.id);
      await setRecordingStatus(recordingId, 'done', { minutes });
      await setMeetingMinutes(meetingId, minutes);

      if (opts.postToChat) {
        const text = `📋 Meeting minutes generated:\n\n${minutes}`;
        const senderId = rec.createdBy ?? opts.fallbackSenderId;
        const saved = await addMeetingMessage(meetingId, senderId, text, null, {
          senderName: 'Meeting Minutes',
          isSystem: true,
        });
        emitToMeeting(meetingId, 'meeting:message', {
          id: saved.id,
          meetingId,
          senderId,
          senderName: 'Meeting Minutes',
          isSystem: true,
          text,
          mediaObjectKey: null,
          createdAt: saved.createdAt,
        });
      }
      await broadcastMeetingUpdate(meetingId, 'minutes');
      return minutes;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await setRecordingStatus(recordingId, 'failed', { error: message.slice(0, 1000) });
      await broadcastMeetingUpdate(meetingId, 'recording-failed');
      throw err;
    }
  })();

  inflight.set(recordingId, run);
  void run.catch(() => undefined).finally(() => inflight.delete(recordingId));
  return run;
}
