import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * One-time capability flow for administrator-assisted agent face enrollment.
 *
 * Node mints a short-lived grant only after verifying the caller manages the
 * business and the target belongs to it. Django verifies/consumes the grant,
 * stores only an encrypted embedding, then mints a completion receipt. Node
 * verifies that receipt before marking the roster entry enrolled.
 *
 * The client only transports signed values: it never chooses target Firebase
 * UID, business id, or final enrollment state.
 */
const grantSchema = z
  .object({
    v: z.literal(1),
    purpose: z.literal('admin_assisted_agent_enrollment_grant'),
    managerId: z.string().min(1).max(128),
    agentId: z.string().min(1).max(128),
    businessId: z.string().uuid(),
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

const receiptSchema = z
  .object({
    v: z.literal(1),
    purpose: z.literal('admin_assisted_agent_enrollment_complete'),
    managerId: z.string().min(1).max(128),
    agentId: z.string().min(1).max(128),
    businessId: z.string().uuid(),
    grantId: z.string().uuid(),
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type AgentFaceEnrollmentGrant = z.infer<typeof grantSchema>;
export type AgentFaceEnrollmentReceipt = z.infer<typeof receiptSchema>;

export class AgentFaceEnrollmentTokenError extends Error {
  constructor(message = 'Invalid agent face-enrollment token') {
    super(message);
    this.name = 'AgentFaceEnrollmentTokenError';
  }
}

function fail(): never {
  // Keep every parsing/signature failure indistinguishable to callers.
  throw new AgentFaceEnrollmentTokenError();
}

function sign(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(body, 'ascii').digest('base64url');
  return `${body}.${signature}`;
}

function verifyToken<T>(
  token: string,
  secret: string,
  schema: z.ZodType<T>,
  nowSeconds = Math.floor(Date.now() / 1000),
): T {
  if (!secret || secret.length < 32 || token.length > 4096) fail();
  const pieces = token.split('.');
  if (pieces.length !== 2 || !pieces[0] || !pieces[1]) fail();
  const [body, encodedSignature] = pieces;

  let supplied: Buffer;
  try {
    supplied = Buffer.from(encodedSignature, 'base64url');
  } catch {
    fail();
  }
  const expected = createHmac('sha256', secret).update(body, 'ascii').digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail();

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    fail();
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) fail();

  const payload = parsed.data as T & { iat: number; exp: number };
  // Cap capabilities at 15 minutes and tolerate only a small positive clock skew.
  if (
    payload.iat > nowSeconds + 30 ||
    payload.exp <= nowSeconds ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 900
  ) {
    fail();
  }
  return payload;
}

export function mintAgentFaceEnrollmentGrant(
  input: { managerId: string; agentId: string; businessId: string },
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): { grant: string; expiresAt: string; grantId: string } {
  if (!secret || secret.length < 32) fail();
  const jti = randomUUID();
  const exp = nowSeconds + 10 * 60;
  const payload: AgentFaceEnrollmentGrant = {
    v: 1,
    purpose: 'admin_assisted_agent_enrollment_grant',
    managerId: input.managerId,
    agentId: input.agentId,
    businessId: input.businessId,
    jti,
    iat: nowSeconds,
    exp,
  };
  return {
    grant: sign(payload, secret),
    grantId: jti,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyAgentFaceEnrollmentReceipt(
  receipt: string,
  secret: string,
): AgentFaceEnrollmentReceipt {
  return verifyToken(receipt, secret, receiptSchema);
}

/** Exported for isolated test/interop tooling; Django verifies grants too. */
export function verifyAgentFaceEnrollmentGrant(
  grant: string,
  secret: string,
): AgentFaceEnrollmentGrant {
  return verifyToken(grant, secret, grantSchema);
}
