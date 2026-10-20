// ─── Feature flags ───────────────────────────────────────────────────────────
// During the Firebase → backend migration, each feature can run on the new
// backend path or the legacy Firebase path (Req 3.9). Flags default to the
// legacy path and are flipped to `true` slice by slice as each feature is
// verified against the backend.
//
// An EXPO_PUBLIC_BACKEND_<FEATURE>=true env var overrides the default, so a
// build can opt a feature into the backend without a code change.

export type FeatureName =
  | 'users' // Slice 1: profile, privacy, blocks, contacts, push tokens
  | 'messaging' // Slice 2: chats, messages, receipts, push
  | 'presence' // Slice 3: presence, last seen, typing
  | 'calls' // Slice 4: call signaling, history, meetings
  | 'status' // Slice 5: status, broadcasts
  | 'media'; // Slice 6: presigned-URL storage

const DEFAULTS: Record<FeatureName, boolean> = {
  users: false,
  messaging: false,
  presence: false,
  calls: false,
  status: false,
  media: false,
};

// Static reads so Expo can inline them at build time.
const ENV_OVERRIDES: Record<FeatureName, string | undefined> = {
  users: process.env.EXPO_PUBLIC_BACKEND_USERS,
  messaging: process.env.EXPO_PUBLIC_BACKEND_MESSAGING,
  presence: process.env.EXPO_PUBLIC_BACKEND_PRESENCE,
  calls: process.env.EXPO_PUBLIC_BACKEND_CALLS,
  status: process.env.EXPO_PUBLIC_BACKEND_STATUS,
  media: process.env.EXPO_PUBLIC_BACKEND_MEDIA,
};

/** True when a feature should use the backend path instead of Firebase. */
export function useBackend(feature: FeatureName): boolean {
  const override = ENV_OVERRIDES[feature];
  if (override != null) return override === 'true';
  return DEFAULTS[feature];
}
