import { z } from 'zod';

const participant = z.object({
  userId: z.string().min(1).max(128),
  displayName: z.string().max(200),
  photoUrl: z.string().max(1024).nullable(),
});

export const createCallSchema = z
  .object({
    callId: z.string().min(1).max(256),
    calleeId: z.string().min(1).max(128),
    callerInfo: participant,
    calleeInfo: participant,
    type: z.enum(['audio', 'video']),
  })
  .strict();

export const historyQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict();

export const createMeetingSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    participants: z.array(z.string().min(1).max(128)).max(100).optional(),
    // Scheduled start/end (ISO-8601). Defaults: now → now + 1h.
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
    type: z.enum(['online', 'in-person']).optional(),
    reminders: z.array(z.number().int().min(0).max(10080)).max(10).optional(),
    // Organizer display name used in the invitation message.
    organizerName: z.string().max(200).nullable().optional(),
    // In-person venue (a real searched place). Only meaningful when type is
    // 'in-person'; ignored otherwise.
    location: z
      .object({
        name: z.string().max(256).nullable().optional(),
        address: z.string().max(512).nullable().optional(),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
        placeId: z.string().max(256).nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const sendMeetingMessageSchema = z
  .object({
    // Minutes and recaps can be long, so allow more than a chat message.
    text: z.string().min(1).max(100_000).optional(),
    mediaObjectKey: z.string().max(512).nullable().optional(),
    // System posts (minutes / recap) render with a label instead of a sender.
    isSystem: z.boolean().optional(),
    senderName: z.string().max(200).nullable().optional(),
  })
  .strict();

export const addMeetingParticipantsSchema = z
  .object({
    userIds: z.array(z.string().min(1).max(128)).min(1).max(100),
    organizerName: z.string().max(200).nullable().optional(),
  })
  .strict();

export const meetingMinutesSchema = z
  .object({ minutes: z.string().min(1).max(100_000) })
  .strict();

export const meetingRecordingStateSchema = z.object({ isRecording: z.boolean() }).strict();

export const addMeetingRecordingSchema = z
  .object({
    objectKey: z.string().min(1).max(512),
    durationMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000),
    // Run AI minutes generation in the background right away (default true).
    autoSummarize: z.boolean().optional(),
  })
  .strict();
