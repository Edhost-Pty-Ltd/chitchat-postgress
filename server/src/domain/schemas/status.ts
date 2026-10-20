import { z } from 'zod';

export const createStatusSchema = z
  .object({
    displayName: z.string().max(200).nullable().optional(),
    userPhone: z.string().max(32).nullable().optional(),
    mediaObjectKey: z.string().max(512).nullable().optional(),
    thumbnailObjectKey: z.string().max(512).nullable().optional(),
    mediaType: z.enum(['image', 'video', 'text']),
    caption: z.string().max(2000).nullable().optional(),
    backgroundColor: z.string().max(32).nullable().optional(),
    textColor: z.string().max(32).nullable().optional(),
    durationMs: z.number().int().positive().max(60000).nullable().optional(),
    visibility: z.enum(['everyone', 'contacts', 'except', 'only']).default('everyone'),
    excludedUsers: z.array(z.string().min(1).max(128)).max(1000).optional(),
    selectedUsers: z.array(z.string().min(1).max(128)).max(1000).optional(),
  })
  .strict();

export const createBroadcastSchema = z
  .object({
    name: z.string().min(1).max(120),
    recipients: z.array(z.string().min(1).max(128)).max(1000),
  })
  .strict();

export const updateBroadcastSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    recipients: z.array(z.string().min(1).max(128)).max(1000).optional(),
  })
  .strict();

export const sendBroadcastSchema = z
  .object({
    type: z.enum(['text', 'image', 'voice', 'video', 'file', 'location', 'catalog']).default('text'),
    text: z.string().max(8192).nullable().optional(),
    mediaObjectKey: z.string().max(512).nullable().optional(),
  })
  .strict();
