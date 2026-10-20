import { z } from 'zod';

// ─── Chat mute ───────────────────────────────────────────────────────────────
export const muteSchema = z.object({ muted: z.boolean() }).strict();

// ─── Profile views ───────────────────────────────────────────────────────────
export const recordProfileViewSchema = z
  .object({ viewedUid: z.string().min(1).max(128) })
  .strict();

// ─── Linked devices ──────────────────────────────────────────────────────────
const deviceTypeSchema = z.enum(['phone', 'tablet', 'desktop', 'web']);
const platformSchema = z.enum(['ios', 'android', 'web']);

export const createLinkTokenSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    displayCode: z.string().min(4).max(16),
    requesterUid: z.string().max(128).nullable().optional(),
    deviceId: z.string().min(1).max(256),
    deviceName: z.string().max(256).nullable().optional(),
    deviceType: deviceTypeSchema.default('phone'),
    os: z.string().max(128).nullable().optional(),
    platform: platformSchema.default('android'),
  })
  .strict();

export const claimLinkSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    ownerName: z.string().max(256).nullable().optional(),
  })
  .strict();

export const registerDeviceSchema = z
  .object({
    deviceId: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    type: deviceTypeSchema.default('phone'),
    os: z.string().max(128).default(''),
    platform: platformSchema.default('android'),
  })
  .strict();

// ─── Multi-agent / business ──────────────────────────────────────────────────
const planSchema = z.enum(['free', 'pro', 'enterprise']);
const routingSchema = z.enum(['round-robin', 'least-active', 'manual']);

export const createBusinessSchema = z
  .object({
    name: z.string().min(1).max(256),
    plan: planSchema.optional(),
    agents: z.array(z.string().min(1).max(128)).max(200).optional(),
    autoAssign: z.boolean().optional(),
    routingStrategy: routingSchema.optional(),
  })
  .strict();

export const updateBusinessSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    plan: planSchema.optional(),
    agents: z.array(z.string().min(1).max(128)).max(200).optional(),
    autoAssign: z.boolean().optional(),
    routingStrategy: routingSchema.optional(),
  })
  .strict();

export const agentStatusSchema = z
  .object({ status: z.enum(['available', 'busy', 'away']).nullable() })
  .strict();

export const userRoleSchema = z
  .object({ role: z.enum(['customer', 'agent', 'admin']) })
  .strict();

export const internalNoteSchema = z
  .object({ text: z.string().min(1).max(4096) })
  .strict();

// ─── Synced contacts (companion devices) ─────────────────────────────────────
export const syncedContactsSchema = z
  .object({
    contacts: z
      .array(
        z
          .object({
            phone: z.string().min(3).max(32),
            displayName: z.string().max(200),
            userId: z.string().max(128).nullable().optional(),
            isSaved: z.boolean().optional(),
            avatarObjectKey: z.string().max(512).nullable().optional(),
          })
          .strip(),
      )
      .max(5000),
  })
  .strict();

// ─── Chat labels ─────────────────────────────────────────────────────────────
export const chatLabelSchema = z
  .object({
    title: z.string().min(1).max(60),
    memberIds: z.array(z.string().min(1).max(128)).max(500).default([]),
    groupIds: z.array(z.string().min(1).max(128)).max(500).default([]),
  })
  .strict();

export const chatLabelPatchSchema = z
  .object({
    title: z.string().min(1).max(60).optional(),
    memberIds: z.array(z.string().min(1).max(128)).max(500).optional(),
    groupIds: z.array(z.string().min(1).max(128)).max(500).optional(),
  })
  .strict();
