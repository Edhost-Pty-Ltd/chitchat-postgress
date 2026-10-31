// ─── FaceAISDK wrapper ───────────────────────────────────────────────────────
// Promisified, strongly-typed facade around @faceaisdk/react-native-face-sdk.
// All functions run entirely on-device: anti-spoofing, motion liveness and the
// 1:1 face match live inside the native SDK UI, so there is no camera glue
// here, no API calls, and no React component dance. Call a function, await a
// FaceResult, branch on code or on the typed helpers below.
//
// Why we expose named helpers instead of exporting the raw SDK:
//   • `faceVerify` returns code=1 when the live person matches the enrolled
//     reference, which is the ONLY code our business logic treats as success
//     for identity recovery.
//   • `livenessVerify` returns code=10 when all configured liveness steps
//     (motion + silent) complete, which is the only "live human" verdict we
//     accept outside of a full verification flow.
//   • `addFaceBySDKCamera` returns code=1 on successful enrollment, with the
//     1024-char feature we persist to the server.
// Those constants are easy to get wrong, so the helpers below name them.

import {
  addFaceBySDKCamera as sdkAddFaceBySDKCamera,
  addFaceByImage as sdkAddFaceByImage,
  deleteFaceFeature as sdkDeleteFaceFeature,
  faceVerify as sdkFaceVerify,
  getFaceFeature as sdkGetFaceFeature,
  insertFaceFeature as sdkInsertFaceFeature,
  isFaceAIModuleAvailable,
  livenessVerify as sdkLivenessVerify,
  type FaceResult,
} from '@faceaisdk/react-native-face-sdk';

export type { FaceResult };
export { isFaceAIModuleAvailable };

/** Package version pinned in package.json / native builds. */
export const FACE_AI_SDK_VERSION = '1.7.4';

/** Status codes we actually branch on. The SDK ships human-readable copy in
 *  `message`, so UIs should prefer that over mapping other numeric codes. */
export const FaceAICode = Object.freeze({
  DEFAULT: 0,
  VERIFY_SUCCESS: 1,
  VERIFY_FAILED: 2,
  MOTION_LIVENESS_TIMEOUT: 4,
  NO_FACE_MULTI: 5,
  NO_FACE_FEATURE: 6,
  COLOR_LIVENESS_FAILED: 8,
  COLOR_LIVENESS_LIGHT_TOO_HIGH: 9,
  ALL_LIVENESS_SUCCESS: 10,
  SILENT_LIVENESS_FAILED: 11,
  NOT_ALLOW_MULTI_FACES: 13,
});

/** 1024 is the SDK's fixed feature size on both platforms. */
export const FACE_FEATURE_LENGTH = 1024;

export function isValidFaceFeature(feature: unknown): feature is string {
  return typeof feature === 'string' && feature.length === FACE_FEATURE_LENGTH;
}

/** User-cancelled vs. real failure. The SDK uses code=0 for both init and
 *  user-cancel, but after we have driven the SDK forward (post-UI dismissal)
 *  code=0 unambiguously means "the user tapped back". */
export function isUserCancel(result: FaceResult): boolean {
  return result.code === FaceAICode.DEFAULT;
}

export interface EnrollOptions {
  /** 1 = balanced (default), 2 = high-precision. */
  mode?: 1 | 2;
  /** Show the SDK's own "save this face?" dialog after capture. */
  showConfirm?: boolean;
}

export interface LivenessOptions {
  /** 1 motion only · 2 motion+colorflash · 3 colorflash · 4 silent only.
   *  Default 1 is the right production trade-off for a phone camera indoors. */
  livenessType?: 1 | 2 | 3 | 4;
  /** Comma-separated motion ids. 1 open mouth, 2 smile, 3 blink,
   *  4 shake head, 5 nod. */
  motionTypes?: string;
  /** Total timeout for the motion phase, in seconds. */
  timeout?: number;
  /** How many random motions to require (1 or 2). */
  steps?: number;
  /** When false, SDK aborts if more than one face appears in frame. */
  allowMultiFaces?: boolean;
  /** Similarity threshold for `verify`. Default 0.83 matches the SDK demo. */
  threshold?: number;
}

const DEFAULT_LIVENESS: Required<Omit<LivenessOptions, 'threshold'>> = {
  livenessType: 1,
  motionTypes: '1,2,3,4,5',
  timeout: 7,
  steps: 2,
  allowMultiFaces: false,
};

/** Enroll a new face through the SDK's full-screen camera UI. The returned
 *  feature should be uploaded to the server so it can be restored on another
 *  device and used as the server-side reference for recovery. */
export async function enrollFace(
  faceID: string,
  options: EnrollOptions = {},
): Promise<FaceResult> {
  if (!faceID) throw new Error('faceID is required');
  return sdkAddFaceBySDKCamera(faceID, {
    mode: options.mode ?? 1,
    showConfirm: options.showConfirm ?? true,
  });
}

/** 1:1 face verify + liveness. code=1 means the live person matched the
 *  enrolled reference above `threshold`. Any other code is a failure. */
export async function verifyFace(
  faceID: string,
  options: LivenessOptions = {},
): Promise<FaceResult> {
  if (!faceID) throw new Error('faceID is required');
  return sdkFaceVerify(faceID, { ...DEFAULT_LIVENESS, ...options });
}

/** Pure liveness detection with no enrolled reference required.
 *  code=10 means the full liveness sequence completed. */
export async function verifyLiveness(
  options: LivenessOptions = {},
): Promise<FaceResult> {
  const merged = { ...DEFAULT_LIVENESS, ...options };
  // livenessType=2 (motion+color) is the SDK's own default for standalone
  // liveness. Keep that behaviour unless the caller overrides it.
  return sdkLivenessVerify({ ...merged, livenessType: merged.livenessType ?? 2 });
}

/** Read the locally-cached reference feature for a user. code=1 if present. */
export async function getLocalFaceFeature(faceID: string): Promise<FaceResult> {
  return sdkGetFaceFeature(faceID);
}

/** Store a reference feature retrieved from the server, so this device can
 *  verify without re-enrolling. */
export async function installFaceFeature(
  faceID: string,
  faceFeature: string,
): Promise<FaceResult> {
  if (!isValidFaceFeature(faceFeature)) {
    throw new Error(`faceFeature must be exactly ${FACE_FEATURE_LENGTH} chars`);
  }
  return sdkInsertFaceFeature(faceID, faceFeature);
}

/** Enroll from a base64-encoded still image (no SDK camera UI). Used by the
 *  administrator-assisted agent flow. */
export async function enrollFaceFromBase64(
  faceID: string,
  base64Image: string,
): Promise<FaceResult> {
  if (!faceID) throw new Error('faceID is required');
  if (!base64Image) throw new Error('base64Image is required');
  return sdkAddFaceByImage(faceID, base64Image);
}

/** Wipe the on-device reference for this user. Used on sign-out and when the
 *  server reports no enrollment on first restore. */
export async function removeLocalFaceFeature(
  faceID: string,
): Promise<FaceResult> {
  return sdkDeleteFaceFeature(faceID);
}
