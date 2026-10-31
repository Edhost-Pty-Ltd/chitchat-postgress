// ─── Facial-recognition API client ───────────────────────────────────────────
// Talks to the standalone Django service (NOT the Node backend) using the same
// Firebase ID token the rest of the app uses for auth. The service verifies
// that token with Firebase Admin and resolves it to the user's Firebase UID.
//
// FaceAISDK handles anti-spoofing and motion/silent liveness on-device. This
// client sends Django the SDK's 1024-char feature (so another device can
// restore it) AND the liveness-verified face image. Django runs InsightFace
// on that image: at enrollment it stores an encrypted ArcFace reference, and
// at recovery it matches the live image against that reference before minting
// a short-lived HMAC receipt. Django keeps only encrypted embeddings, never the
// image itself.

import { FACE_API_URL } from '../config/env';
import { createFirebaseTokenSource, getFreshIdToken } from './token';
import { FACE_FEATURE_LENGTH, isValidFaceFeature } from '../sdk/faceAI';

export interface FaceStatus {
  enrolled: boolean;
  locked: boolean;
  lastVerifiedAt: string | null;
  enrolledAt: string | null;
}

export type EnrollResult =
  | { ok: true; enrolled: true }
  | { ok: false; error: string; status: number; hint?: string };

export type FeatureRestoreResult =
  | { ok: true; enrolled: true; faceFeature: string }
  | { ok: true; enrolled: false }
  | { ok: false; error: string; status: number };

export interface ReportedVerifyPayload {
  reportGeneration: string;
  /** 1024-char feature returned by the SDK's `faceVerify` on code=1. */
  faceFeature: string;
  /** SDK liveness score (0..1). */
  livenessScore: number;
  /** SDK result code (1 = verify success, 10 = all liveness success). */
  livenessCode: number;
  /** SDK similarity score (0..1), reported for audit; not used for the match. */
  similarity: number;
  /**
   * Base64 of the live face image captured after liveness passed. When
   * present, the server runs InsightFace on it and makes the authoritative
   * ArcFace match against the stored reference. When absent (older builds),
   * the server falls back to the SDK-feature cosine check. The SDK feature is
   * still sent either way for the fallback path and audit.
   */
  faceImage?: string | null;
}

export type ReportedVerifyResult =
  | {
      ok: true;
      matched: true;
      receipt: string;
      receiptExpiresAt: string;
      verifiedAt: string;
      /** Cosine similarity 0..1 (DEBUG builds of the service only). */
      score?: number;
      /** Match threshold 0..1 (DEBUG builds of the service only). */
      threshold?: number;
    }
  | { ok: true; matched: false; score?: number; threshold?: number }
  | { ok: false; error: string; status: number; hint?: string };

const tokenSource = createFirebaseTokenSource();

async function authHeader(): Promise<Record<string, string>> {
  const token = await getFreshIdToken(tokenSource);
  if (!token) throw new Error('Not signed in');
  return { Authorization: `Bearer ${token}` };
}

function faceUrl(path: string): string {
  return `${FACE_API_URL.replace(/\/+$/, '')}${path}`;
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

export type RegistrationFaceResult =
  | {
      ok: true;
      enrolled: true;
      receipt: string;
      receiptExpiresAt: string;
      reconciled: boolean;
    }
  | { ok: false; error: string; status: number; hint?: string };

/**
 * Complete the biometric part of NEW account registration. Django accepts the
 * reference feature extracted during SDK enrollment only when the subsequent
 * SDK 1:1 + liveness check returned code=1. It stores the encrypted reference
 * and returns a signed, short-lived receipt; Node requires that receipt before
 * it creates the user row.
 */
export async function registerFaceForAccount(
  faceFeature: string,
  meta: { livenessScore: number; livenessCode: number; sdkVersion?: string; faceImage?: string | null },
): Promise<RegistrationFaceResult> {
  if (!isValidFaceFeature(faceFeature)) {
    return {
      ok: false,
      error: 'bad_feature',
      status: 400,
      hint: `faceFeature must be exactly ${FACE_FEATURE_LENGTH} chars`,
    };
  }
  const headers = await authHeader();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  let res: Response;
  try {
    res = await fetch(faceUrl('/api/face/register/'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        face_feature: faceFeature,
        liveness_score: meta.livenessScore,
        liveness_code: meta.livenessCode,
        sdk_version: meta.sdkVersion ?? '',
        ...(meta.faceImage ? { face_image: meta.faceImage } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = await readJson(res);
  if (res.status === 201 && body?.ok && typeof body?.receipt === 'string') {
    return {
      ok: true,
      enrolled: true,
      receipt: body.receipt,
      receiptExpiresAt: body.receipt_expires_at,
      reconciled: body.reconciled === true,
    };
  }
  return {
    ok: false,
    error: body?.error ?? 'face_registration_failed',
    status: res.status,
    hint: body?.hint,
  };
}

/**
 * Persist a newly-enrolled reference feature on the server, so another device
 * owned by the same user can restore it without re-enrolling. The server
 * encrypts the feature at rest (Fernet) and stores it in private object
 * storage; the plaintext never hits a log.
 */
export async function uploadEnrollment(
  faceFeature: string,
  meta: { livenessScore: number; livenessCode: number; sdkVersion?: string; faceImage?: string | null } = {
    livenessScore: 0,
    livenessCode: 1,
  },
): Promise<EnrollResult> {
  if (!isValidFaceFeature(faceFeature)) {
    return {
      ok: false,
      error: 'bad_feature',
      status: 400,
      hint: `faceFeature must be exactly ${FACE_FEATURE_LENGTH} chars`,
    };
  }
  const headers = await authHeader();
  const res = await fetch(faceUrl('/api/face/enroll/'), {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      face_feature: faceFeature,
      liveness_score: meta.livenessScore,
      liveness_code: meta.livenessCode,
      sdk_version: meta.sdkVersion ?? '',
      ...(meta.faceImage ? { face_image: meta.faceImage } : {}),
    }),
  });
  const body = await readJson(res);
  if (res.status === 201 && body?.ok) return { ok: true, enrolled: true };
  return {
    ok: false,
    error: body?.error ?? 'enrollment_failed',
    status: res.status,
    hint: body?.hint,
  };
}

/**
 * Fetch the server's stored reference feature for this user so the SDK can
 * `insertFaceFeature` it locally. Returns `enrolled:false` when the user has
 * never enrolled — not an error condition.
 */
export async function fetchEnrollmentFeature(): Promise<FeatureRestoreResult> {
  const headers = await authHeader();
  const res = await fetch(faceUrl('/api/face/feature/'), {
    method: 'GET',
    headers,
  });
  const body = await readJson(res);
  if (res.ok) {
    if (body?.enrolled && typeof body?.face_feature === 'string') {
      return { ok: true, enrolled: true, faceFeature: body.face_feature };
    }
    return { ok: true, enrolled: false };
  }
  return {
    ok: false,
    error: body?.error ?? 'feature_fetch_failed',
    status: res.status,
  };
}

/**
 * Reported-account recovery. The SDK has already (on-device) run anti-spoofing,
 * the random motion-liveness challenge and the 1:1 match. We pass the fresh
 * live feature plus the SDK's liveness verdict to Django, which independently
 * computes the cosine similarity between the submitted feature and the stored
 * reference. Only when BOTH check out (SDK verdict live + server cosine above
 * threshold) does Django mint the short-lived HMAC receipt that Node accepts.
 *
 * The client cannot forge the receipt — it is signed with a secret shared only
 * between Django and Node — and cannot replay it, because it is bound to the
 * current report generation and expires in ~2 minutes.
 */
export async function verifyReportedAccount(
  payload: ReportedVerifyPayload,
): Promise<ReportedVerifyResult> {
  if (!isValidFaceFeature(payload.faceFeature)) {
    return {
      ok: false,
      error: 'bad_feature',
      status: 400,
      hint: `faceFeature must be exactly ${FACE_FEATURE_LENGTH} chars`,
    };
  }
  if (!payload.reportGeneration) {
    return { ok: false, error: 'report_generation_invalid', status: 400 };
  }
  const headers = await authHeader();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  let res: Response;
  try {
    res = await fetch(faceUrl('/api/face/verify-live/'), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_generation: payload.reportGeneration,
        face_feature: payload.faceFeature,
        liveness_score: payload.livenessScore,
        liveness_code: payload.livenessCode,
        similarity: payload.similarity,
        ...(payload.faceImage ? { face_image: payload.faceImage } : {}),
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  const body = await readJson(res);

  const score = typeof body?.similarity === 'number' ? body.similarity : undefined;
  const threshold = typeof body?.threshold === 'number' ? body.threshold : undefined;
  if (res.ok && body?.ok && body?.matched === true && body?.receipt) {
    return {
      ok: true,
      matched: true,
      receipt: body.receipt,
      receiptExpiresAt: body.receipt_expires_at,
      verifiedAt: body.verified_at,
      score,
      threshold,
    };
  }
  if (res.ok && body?.ok && body?.matched === false) {
    return { ok: true, matched: false, score, threshold };
  }
  return {
    ok: false,
    error: body?.error ?? 'verification_failed',
    status: res.status,
    hint: body?.hint,
  };
}

/** Read the current user's enrollment state (no biometric data returned). */
export async function faceStatus(): Promise<FaceStatus | null> {
  try {
    const headers = await authHeader();
    const res = await fetch(faceUrl('/api/face/status/'), {
      method: 'GET',
      headers,
    });
    if (!res.ok) return null;
    const body = await readJson(res);
    return {
      enrolled: !!body.enrolled,
      locked: !!body.locked,
      lastVerifiedAt: body.last_verified_at ?? null,
      enrolledAt: body.enrolled_at ?? null,
    };
  } catch {
    return null;
  }
}
