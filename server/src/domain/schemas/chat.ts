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
  'poll',
  'order',
  'contact',
]);

// ─── Embedded card payloads (poll / order / contact) ─────────────────────────
export const pollPayloadSchema = z
  .object({
    question: z.string().min(1).max(512),
    options: z
      .array(z.object({ id: z.string().min(1).max(64), text: z.string().min(1).max(256) }).strict())
      .min(2)
      .max(12),
    multiple: z.boolean(),
  })
  .strict();

export const orderPayloadSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            name: z.string().min(1).max(256),
            price: z.string().max(64),
            imageObjectKey: z.string().max(512).nullable().optional(),
            quantity: z.number().int().positive().max(9999),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    total: z.string().max(64).nullable().optional(),
    currency: z.string().max(16).default(''),
  })
  .strict();

const sharedContactSchema = z
  .object({
    name: z.string().max(256),
    phone: z.string().max(64),
    userId: z.string().max(128).nullable().optional(),
    registered: z.boolean().optional(),
    photoObjectKey: z.string().max(512).nullable().optional(),
  })
  .strict();

export const contactPayloadSchema = sharedContactSchema
  .extend({ contacts: z.array(sharedContactSchema).max(200).optional() })
  .strict();

export const votePollSchema = z.object({ optionId: z.string().min(1).max(64) }).strict();

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
    poll: pollPayloadSchema.optional(),
    order: orderPayloadSchema.optional(),
    contact: contactPayloadSchema.optional(),
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
