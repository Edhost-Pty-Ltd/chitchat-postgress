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
  })
  .strict();
