import { z } from 'zod';

const visibility = z.enum(['Everyone', 'Contacts', 'Nobody']);

const addressSchema = z
  .object({
    street: z.string().max(200).optional().default(''),
    city: z.string().max(120).optional().default(''),
    province: z.string().max(120).optional().default(''),
    postalCode: z.string().max(32).optional().default(''),
    country: z.string().max(120).optional().default(''),
  })
  .strip();

const daySchema = z.object({ open: z.string().max(16), close: z.string().max(16) }).strip();

const catalogItemSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().max(256),
    price: z.string().max(64).optional().default(''),
    description: z.string().max(2000).nullable().optional(),
    // Object key of the uploaded product image (media service), not a URL.
    imageUri: z.string().max(1024).nullable().optional(),
    collectionId: z.string().max(128).nullable().optional(),
  })
  .passthrough();

const catalogCollectionSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().max(256),
    emoji: z.string().max(16).nullable().optional(),
    createdAt: z.number().optional(),
  })
  .passthrough();

export const profilePatchSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    about: z.string().max(2000).nullable().optional(),
    avatarObjectKey: z.string().max(512).nullable().optional(),
    email: z.string().email().max(254).nullable().optional(),
    website: z.string().max(512).nullable().optional(),
    // Legacy free-text fields (kept for older clients).
    catalog: z.string().max(20000).nullable().optional(),
    operationalHours: z.string().max(4000).nullable().optional(),
    // Business profile (restored from the Firestore user doc).
    industry: z.string().max(64).nullable().optional(),
    address: addressSchema.nullable().optional(),
    workSchedule: z.record(daySchema).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    autoResponderEnabled: z.boolean().optional(),
    autoResponderMessage: z.string().max(1000).nullable().optional(),
    catalogItems: z.array(catalogItemSchema).max(500).optional(),
    catalogCollections: z.array(catalogCollectionSchema).max(100).optional(),
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
    deviceId: z.string().max(256).nullable().optional(),
  })
  .strict();
