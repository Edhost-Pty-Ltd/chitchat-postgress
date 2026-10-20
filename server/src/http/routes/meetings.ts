import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth.js';
import { parse } from '../validate.js';
import { Errors, ApiError } from '../errors.js';
import {
  createMeetingSchema,
  sendMeetingMessageSchema,
  addMeetingParticipantsSchema,
  meetingMinutesSchema,
  meetingRecordingStateSchema,
  addMeetingRecordingSchema,
} from '../../domain/schemas/call.js';
import {
  createMeeting,
  getMeeting,
  isMeetingParticipant,
  listMeetings,
  getMeetingMessages,
  addMeetingMessage,
  endMeetingById,
  addMeetingParticipants,
  setMeetingMinutes,
  setMeetingRecording,
  addMeetingRecording,
  listMeetingRecordings,
  getMeetingRecording,
} from '../../db/repositories/meetings.js';
import { getUserById } from '../../db/repositories/users.js';
import { presignDownload } from '../../media/presign.js';
import { emitToMeeting, emitToUser } from '../../realtime/emitter.js';
import {
  broadcastMeetingUpdate,
  sendMeetingInvites,
  summarizeMeetingRecording,
} from '../../domain/meetings.js';
import { geminiConfigured, SummarizeError } from '../../ai/summarizeRecording.js';
import { logger } from '../../config/logger.js';

async function requireParticipant(meetingId: string, userId: string): Promise<void> {
  if (!(await isMeetingParticipant(meetingId, userId))) {
    throw Errors.forbidden('Not a participant of this meeting');
  }
}

async function requireOrganizer(meetingId: string, userId: string) {
  const state = await getMeeting(meetingId);
  if (!state) throw Errors.notFound('Meeting not found');
  if (state.organizerId !== userId) throw Errors.forbidden('Only the organizer can do this');
  return state;
}

function summarizeFailure(err: unknown): ApiError {
  if (err instanceof SummarizeError && err.code === 'NOT_CONFIGURED') {
    return new ApiError(503, 'AI_NOT_CONFIGURED', 'AI minutes are not configured on the server');
  }
  const message = err instanceof Error ? err.message : 'Could not generate minutes';
  return new ApiError(502, 'SUMMARIZE_FAILED', message);
}

export async function registerMeetingRoutes(app: FastifyInstance): Promise<void> {
  // POST /meetings — schedule a meeting with the caller as organizer, invite the
  // participants (system message in their chat + push), refresh calendars.
  app.post('/meetings', { preHandler: requireAuth }, async (request, reply) => {
    const organizerId = request.identity!.userId;
    const body = parse(createMeetingSchema, request.body);
    const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
    const endsAt = body.endsAt
      ? new Date(body.endsAt)
      : new Date(startsAt.getTime() + 60 * 60 * 1000);
    if (endsAt <= startsAt) throw Errors.badRequest('End time must be after start time');

    const title = body.title ?? 'Meeting';
    const { meetingId, participants } = await createMeeting(organizerId, {
      title,
      participants: body.participants ?? [],
      startsAt,
      endsAt,
      type: body.type,
      reminders: body.reminders,
    });

    const organizer = await getUserById(organizerId);
    const organizerName =
      body.organizerName?.trim() || organizer?.display_name?.trim() || 'A business';
    await sendMeetingInvites(organizerId, organizerName, title, participants);
    await broadcastMeetingUpdate(meetingId, 'created');

    const state = await getMeeting(meetingId);
    return reply.code(201).send({ meetingId, state });
  });

  // GET /meetings — every meeting the caller is invited to, by start time.
  app.get('/meetings', { preHandler: requireAuth }, async (request) => {
    return { meetings: await listMeetings(request.identity!.userId) };
  });

  // GET /meetings/:id — meeting state (participants only).
  app.get<{ Params: { id: string } }>('/meetings/:id', { preHandler: requireAuth }, async (request) => {
    const meetingId = request.params.id;
    await requireParticipant(meetingId, request.identity!.userId);
    const state = await getMeeting(meetingId);
    if (!state) throw Errors.notFound('Meeting not found');
    return { state };
  });

  // POST /meetings/:id/participants — organizer adds people mid-meeting or later.
  app.post<{ Params: { id: string } }>(
    '/meetings/:id/participants',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const meetingId = request.params.id;
      const state = await requireOrganizer(meetingId, userId);
      const body = parse(addMeetingParticipantsSchema, request.body);
      const added = await addMeetingParticipants(meetingId, body.userIds);
      const organizer = await getUserById(userId);
      const organizerName =
        body.organizerName?.trim() || organizer?.display_name?.trim() || 'A business';
      await sendMeetingInvites(userId, organizerName, state.title, added);
      await broadcastMeetingUpdate(meetingId, 'participants');
      return { added };
    },
  );

  // GET/POST /meetings/:id/messages — in-meeting chat.
  app.get<{ Params: { id: string } }>(
    '/meetings/:id/messages',
    { preHandler: requireAuth },
    async (request) => {
      await requireParticipant(request.params.id, request.identity!.userId);
      return { messages: await getMeetingMessages(request.params.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/meetings/:id/messages',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.identity!.userId;
      const meetingId = request.params.id;
      await requireParticipant(meetingId, userId);
      const body = parse(sendMeetingMessageSchema, request.body);
      const senderName = body.isSystem ? body.senderName ?? 'Meeting' : body.senderName ?? null;
      const msg = await addMeetingMessage(meetingId, userId, body.text ?? null, body.mediaObjectKey ?? null, {
        senderName,
        isSystem: !!body.isSystem,
      });
      emitToMeeting(meetingId, 'meeting:message', {
        id: msg.id,
        meetingId,
        senderId: userId,
        senderName,
        isSystem: !!body.isSystem,
        text: body.text ?? null,
        mediaObjectKey: body.mediaObjectKey ?? null,
        createdAt: msg.createdAt,
      });
      return reply.code(201).send({ message: { id: msg.id, createdAt: msg.createdAt } });
    },
  );

  // PUT /meetings/:id/minutes — save minutes (participants).
  app.put<{ Params: { id: string } }>(
    '/meetings/:id/minutes',
    { preHandler: requireAuth },
    async (request) => {
      const meetingId = request.params.id;
      await requireParticipant(meetingId, request.identity!.userId);
      const { minutes } = parse(meetingMinutesSchema, request.body);
      await setMeetingMinutes(meetingId, minutes);
      await broadcastMeetingUpdate(meetingId, 'minutes');
      return { ok: true };
    },
  );

  // PUT /meetings/:id/recording-state — organizer toggles the "being recorded"
  // flag everyone sees.
  app.put<{ Params: { id: string } }>(
    '/meetings/:id/recording-state',
    { preHandler: requireAuth },
    async (request) => {
      const meetingId = request.params.id;
      await requireOrganizer(meetingId, request.identity!.userId);
      const { isRecording } = parse(meetingRecordingStateSchema, request.body);
      await setMeetingRecording(meetingId, isRecording);
      emitToMeeting(meetingId, 'meeting:recording', { meetingId, isRecording });
      await broadcastMeetingUpdate(meetingId, 'recording-state');
      return { isRecording };
    },
  );

  // POST /meetings/:id/recordings — register an uploaded recording (object key
  // from the media service). By default AI minutes are generated right away in
  // the background, like the old in-call flow.
  app.post<{ Params: { id: string } }>(
    '/meetings/:id/recordings',
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.identity!.userId;
      const meetingId = request.params.id;
      await requireParticipant(meetingId, userId);
      const body = parse(addMeetingRecordingSchema, request.body);
      if (!body.objectKey.startsWith(`meetings/${meetingId}/`)) {
        throw Errors.badRequest('Recording must be uploaded to this meeting');
      }
      const recording = await addMeetingRecording(meetingId, userId, body.objectKey, body.durationMs);
      await broadcastMeetingUpdate(meetingId, 'recording-added');

      const autoSummarize = body.autoSummarize ?? true;
      if (autoSummarize && geminiConfigured()) {
        void summarizeMeetingRecording(meetingId, recording.id, {
          postToChat: true,
          fallbackSenderId: userId,
        }).catch((err) => logger.warn({ err, recordingId: recording.id }, 'auto minutes failed'));
      }
      return reply.code(201).send({
        recording: { ...recording, url: await presignDownload(recording.objectKey) },
        summarizing: autoSummarize && geminiConfigured(),
      });
    },
  );

  // GET /meetings/:id/recordings — recordings with short-lived playback URLs.
  app.get<{ Params: { id: string } }>(
    '/meetings/:id/recordings',
    { preHandler: requireAuth },
    async (request) => {
      const meetingId = request.params.id;
      await requireParticipant(meetingId, request.identity!.userId);
      const recordings = await listMeetingRecordings(meetingId);
      return {
        recordings: await Promise.all(
          recordings.map(async (r) => ({ ...r, url: await presignDownload(r.objectKey) })),
        ),
      };
    },
  );

  // POST /meetings/:id/recordings/:recId/summarize — (re)generate minutes and
  // return them (Calendar "Summarize" / "Re-summarize"). Can take minutes.
  app.post<{ Params: { id: string; recId: string } }>(
    '/meetings/:id/recordings/:recId/summarize',
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.identity!.userId;
      const { id: meetingId, recId } = request.params;
      await requireParticipant(meetingId, userId);
      const rec = await getMeetingRecording(recId);
      if (!rec || rec.meetingId !== meetingId) throw Errors.notFound('Recording not found');
      if (!geminiConfigured()) throw summarizeFailure(new SummarizeError('', 'NOT_CONFIGURED'));
      try {
        const minutes = await summarizeMeetingRecording(meetingId, recId, {
          postToChat: false,
          fallbackSenderId: userId,
        });
        return { minutes };
      } catch (err) {
        throw summarizeFailure(err);
      }
    },
  );

  // POST /meetings/:id/end — organizer ends the meeting for everyone.
  app.post<{ Params: { id: string } }>('/meetings/:id/end', { preHandler: requireAuth }, async (request) => {
    const meetingId = request.params.id;
    const state = await requireOrganizer(meetingId, request.identity!.userId);
    await endMeetingById(meetingId);
    emitToMeeting(meetingId, 'meeting:ended', { meetingId });
    for (const uid of state.participants) emitToUser(uid, 'meeting:ended', { meetingId });
    await broadcastMeetingUpdate(meetingId, 'ended');
    return { ok: true };
  });
}
