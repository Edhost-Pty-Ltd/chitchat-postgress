import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Short-lived proof minted ONLY by the Django face service after a new user
 * completed on-device face enrollment AND a live 1:1 verification (motion +
 * silent anti-spoofing) against that enrollment. POST /me/register requires
 * it, so an OTP-verified session cannot create an account without the face
 * step. The `purpose` literal keeps it from being accepted as a reported-
 * account receipt (and vice versa), even though both use the same secret.
 */
const payloadSchema = z
  .object({
    v: z.literal(1),
    sub: z.string().min(1).max(128),
    purpose: z.literal('self_registration_face_enrollment'),
    jti: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
  })
  .strict();

export type SelfRegistrationReceipt = z.infer<typeof payloadSchema>;

export class RegistrationReceiptError extends Error {
  constructor(message = 'Invalid registration receipt') {
    super(message);
    this.name = 'RegistrationReceiptError';
  }
}

function fail(): never {
  // One generic failure: callers must not learn which part was invalid.
  throw new RegistrationReceiptError();
}

/** Verify signature, shape, purpose, clock bounds, and the short TTL. */
export function verifySelfRegistrationReceipt(
  receipt: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SelfRegistrationReceipt {
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
  // Small positive clock skew allowed; never a long-lived or back-dated proof.
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
