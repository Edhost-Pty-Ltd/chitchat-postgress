import { z } from 'zod';

export const uploadUrlSchema = z
  .object({
    category: z.enum(['avatar', 'chat-media', 'chat-voice', 'group', 'status', 'meeting']),
    contentType: z.string().min(1).max(128),
    sizeBytes: z.number().int().positive(),
    chatId: z.string().uuid().optional(),
    meetingId: z.string().uuid().optional(),
    ext: z.string().max(10).optional(),
  })
  .strict();

export const downloadUrlSchema = z
  .object({
    objectKeys: z.array(z.string().min(1).max(512)).min(1).max(50),
  })
  .strict();
