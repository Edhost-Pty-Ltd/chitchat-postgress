import { z } from 'zod';

const visibility = z.enum(['Everyone', 'Contacts', 'Nobody']);

export const profilePatchSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    about: z.string().max(500).nullable().optional(),
    avatarObjectKey: z.string().max(512).nullable().optional(),
    email: z.string().email().max(254).nullable().optional(),
    website: z.string().max(512).nullable().optional(),
    catalog: z.string().max(512).nullable().optional(),
    operationalHours: z.string().max(512).nullable().optional(),
  })
  .strict();

export const updatePhoneSchema = z
  .object({
    phoneNumber: z.string().min(5).max(32),
  })
  .strict();

export const privacySettingsSchema = z
  .object({
    lastSeen: visibility,
    profilePhoto: visibility,
    statusVisibility: visibility,
    groups: visibility,
    calls: visibility,
    readReceipts: z.boolean(),
    disappearingMessages: z.boolean(),
  })
  .strict();

// Contact matching capped at 500 numbers (Req 4.5 → 413 when exceeded).
export const MAX_CONTACTS = 500;
export const contactsMatchSchema = z
  .object({
    phones: z.array(z.string().min(3).max(32)),
  })
  .strict();

export const blockSchema = z
  .object({
    userId: z.string().min(1).max(128),
    displayName: z.string().max(100).nullable().optional(),
    photoObjectKey: z.string().max(512).nullable().optional(),
    phone: z.string().max(32).nullable().optional(),
  })
  .strict();

export const pushTokenSchema = z
  .object({
    token: z.string().min(1).max(512),
    platform: z.string().max(16).nullable().optional(),
  })
  .strict();
