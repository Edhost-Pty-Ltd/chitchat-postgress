import { z } from 'zod';

export const messageTypeSchema = z.enum([
  'text',
  'image',
  'voice',
  'video',
  'file',
  'location',
  'system',
  'catalog',
]);

export const createChatSchema = z
  .object({
    type: z.enum(['direct', 'group']),
    // direct: exactly one other member; group: one or more members + a name.
    members: z.array(z.string().min(1).max(128)).min(1),
    groupName: z.string().min(1).max(120).optional(),
    groupPhotoObjectKey: z.string().max(512).optional(),
  })
  .strict();

export const updateChatSchema = z
  .object({
    groupName: z.string().min(1).max(120).optional(),
    groupPhotoObjectKey: z.string().max(512).nullable().optional(),
    addMembers: z.array(z.string().min(1).max(128)).optional(),
    removeMembers: z.array(z.string().min(1).max(128)).optional(),
  })
  .strict();

export const sendMessageSchema = z
  .object({
    clientId: z.string().min(1).max(128).optional(),
    type: messageTypeSchema,
    text: z.string().max(8192).nullable().optional(),
    mediaObjectKey: z.string().max(512).nullable().optional(),
    thumbnailObjectKey: z.string().max(512).nullable().optional(),
    fileName: z.string().max(256).nullable().optional(),
    fileSize: z.number().int().nonnegative().nullable().optional(),
    mimeType: z.string().max(128).nullable().optional(),
    durationMs: z.number().int().nonnegative().nullable().optional(),
    location: z.unknown().optional(),
    catalogItem: z.unknown().optional(),
    replyTo: z.unknown().optional(),
    subtype: z.string().max(64).nullable().optional(),
  })
  .strict();

export const deleteMessageSchema = z
  .object({
    scope: z.enum(['everyone', 'me']),
  })
  .strict();

export const forwardSchema = z
  .object({
    messageId: z.string().uuid(),
    targetChatIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .strict();

export const listMessagesQuerySchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    after: z.string().uuid().optional(),
  })
  .strict();

export const editMessageSchema = z
  .object({
    text: z.string().min(1).max(8192),
  })
  .strict();
