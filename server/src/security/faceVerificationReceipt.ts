import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Short-lived proof minted ONLY by the Django face service after the
 * on-device FaceAISDK verdict (code=1 verify+liveness pass) is accepted and
 * the stored encrypted reference is still intact.
 *
 * The mobile client can carry this receipt, but cannot alter it. The report
 * generation binds it to the exact report state that started the check.
 */
const payloadSchema = z
  .object({
    v: z.literal(1),
    sub: z.string().min(1).max(128),
    purpose: z.literal('reported_user_reverification'),
    generation: z.string().uuid(),
    challengeId: z.string().uuid(),
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type FaceVerificationReceipt = z.infer<typeof payloadSchema>;

export class FaceVerificationReceiptError extends Error {
  constructor(message = 'Invalid face verification receipt') {
    super(message);
    this.name = 'FaceVerificationReceiptError';
  }
}

function fail(): never {
  // Deliberately one generic failure: callers must not learn whether the
  // payload, signature, subject, or expiry was the invalid part.
  throw new FaceVerificationReceiptError();
}

/** Verify signature, shape, purpose, clock bounds, and deliberately short TTL. */
export function verifyFaceVerificationReceipt(
  receipt: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): FaceVerificationReceipt {
  if (!secret || secret.length < 32 || receipt.length > 4096) fail();

  const parts = receipt.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail();
  const [encoded, encodedSignature] = parts;

  let supplied: Buffer;
  try {
    supplied = Buffer.from(encodedSignature, 'base64url');
  } catch {
    fail();
  }
  const expected = createHmac('sha256', secret).update(encoded, 'ascii').digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) fail();

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    fail();
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) fail();

  const payload = parsed.data;
  // Allow a small positive clock skew, but never a long-lived or back-dated
  // capability. Django uses a 120-second default TTL; 5 minutes is the ceiling.
  if (
    payload.iat > nowSeconds + 30 ||
    payload.exp <= nowSeconds ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 300
  ) {
    fail();
  }
  return payload;
}
