import { z } from 'zod';

/**
 * Environment schema (Req 1.3, 1.5).
 *
 * All configuration is read from environment variables. If a required variable
 * is missing or invalid, `loadEnv` throws an `EnvError` naming the offending
 * variable(s); `src/index.ts` turns that into a non-zero exit with a clear
 * message (Property 26).
 */
const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : v.trim().toLowerCase() === 'true'));

const DEV_FACE_RECEIPT_SECRET =
  'dev-insecure-face-verification-receipt-secret-change-me';
const DEV_AGENT_FACE_ENROLLMENT_SECRET =
  'dev-insecure-agent-face-enrollment-secret-change-me';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Optional HTTPS for local dev (required for camera/mic over LAN IPs)
  USE_HTTPS: booleanish.default(false),
  HTTPS_KEY_PATH: z.string().optional(),
  HTTPS_CERT_PATH: z.string().optional(),

  DATABASE_URL: z.string().min(1),
  // Postgres TLS. Managed providers (AWS RDS, etc.) require TLS in production.
  //   disable  — no TLS (local dev / docker-compose). Default.
  //   require  — TLS on, but the server certificate chain is NOT verified
  //              (use with RDS when you don't ship the RDS CA bundle).
  //   verify   — TLS on and the certificate chain IS verified against the
  //              system CAs plus any PEM in DATABASE_CA_CERT.
  DATABASE_SSL: z.enum(['disable', 'require', 'verify']).default('disable'),
  // Optional PEM (the RDS/global bundle) used when DATABASE_SSL=verify. Either
  // the certificate contents inline, or a path to a .pem file.
  DATABASE_CA_CERT: z.string().optional(),

  REDIS_URL: z.string().min(1),
  // Enable TLS for Redis (ElastiCache in-transit encryption). When the
  // REDIS_URL scheme is `rediss://` this is implied; set true to force it.
  REDIS_TLS: booleanish.default(false),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: booleanish.default(true),
  // Public-facing MinIO endpoint embedded in presigned URLs. Defaults to
  // S3_ENDPOINT when unset (fine for localhost dev). Set to the LAN IP when
  // the phone needs to reach MinIO directly (e.g. http://10.0.0.131:9000).
  S3_PUBLIC_ENDPOINT: z.string().optional(),

  // Firebase Admin: one of PATH or JSON must be present (checked below).
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),

  EXPO_PUSH_URL: z.string().default('https://exp.host/--/api/v2/push/send'),

  // How long (seconds) a verified Firebase token's decoded identity is cached
  // in memory to avoid a network round-trip to Firebase on every request. A
  // revoked/removed token can remain accepted for at most this long on the HTTP
  // path; the socket handshake always does a fresh checkRevoked verification.
  // Set to 0 to disable caching entirely.
  AUTH_TOKEN_CACHE_TTL_SEC: z.coerce.number().int().min(0).default(60),

  // AI meeting minutes (old summarizeMeetingRecording Cloud Function). Optional:
  // without a key the summarize endpoints answer 503 and everything else works.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.8-flash'),

  // Public web app that hosts the meeting room. Meeting invite cards link to
  // `${MEET_URL_BASE}/meet/<meetingId>`.
  // Set this to your Expo web URL: http://localhost:8081 for local dev,
  // your production domain when deployed. No hardcoded default — you must
  // set MEET_URL_BASE in server/.env.
  MEET_URL_BASE: z.string().min(1).default('http://localhost:8081'),

  // Secret used to sign short-lived guest tokens for browser participants who
  // join a meeting via its public link. Falls back to a dev-only default; set a
  // strong random value in production. Guests can only ever act on the single
  // meeting their token is scoped to.
  MEET_GUEST_SECRET: z.string().min(1).default('dev-insecure-meet-guest-secret-change-me'),

  // Google Places API key for the in-person venue search (server-side proxy so
  // the key never ships in the app). Optional: without it the /places routes
  // fall back to OpenStreetMap Nominatim, which also returns real places.
  GOOGLE_PLACES_API_KEY: z.string().optional(),

  // Shared ONLY with the standalone Django face service. Django signs
  // purpose-separated short-lived receipts for (a) new-account face-gated
  // registration and (b) reported-account re-verification. This API verifies
  // them before creating/unlocking an account. Never expose to the mobile app.
  FACE_VERIFICATION_RECEIPT_SECRET: z
    .string()
    .min(32)
    .default(DEV_FACE_RECEIPT_SECRET),

  // Separate capability for owner/admin-assisted agent enrollment. Node issues
  // a grant; Django consumes it and returns a completion receipt. Keeping this
  // distinct from report verification prevents cross-purpose token reuse.
  AGENT_FACE_ENROLLMENT_SECRET: z
    .string()
    .min(32)
    .default(DEV_AGENT_FACE_ENROLLMENT_SECRET),
});

export type Env = z.infer<typeof schema>;

export class EnvError extends Error {
  constructor(
    message: string,
    readonly missing: string[],
  ) {
    super(message);
    this.name = 'EnvError';
  }
}

/**
 * Parse and validate the given environment (defaults to process.env).
 * Throws EnvError listing every missing/invalid variable by name (Req 1.5).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);

  if (!parsed.success) {
    const names = Array.from(
      new Set(parsed.error.issues.map((i) => String(i.path[0] ?? '(unknown)'))),
    );
    throw new EnvError(
      `Invalid or missing environment variable(s): ${names.join(', ')}`,
      names,
    );
  }

  const env = parsed.data;

  // Cross-field rule: Firebase Admin needs a service account from a path or raw JSON.
  if (!env.FIREBASE_SERVICE_ACCOUNT_PATH && !env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const names = ['FIREBASE_SERVICE_ACCOUNT_PATH', 'FIREBASE_SERVICE_ACCOUNT_JSON'];
    throw new EnvError(
      `Missing Firebase credentials: set one of ${names.join(' or ')}`,
      names,
    );
  }

  if (
    env.NODE_ENV === 'production' &&
    env.FACE_VERIFICATION_RECEIPT_SECRET === DEV_FACE_RECEIPT_SECRET
  ) {
    throw new EnvError(
      'FACE_VERIFICATION_RECEIPT_SECRET must be set to a private random value in production',
      ['FACE_VERIFICATION_RECEIPT_SECRET'],
    );
  }
  if (
    env.NODE_ENV === 'production' &&
    env.AGENT_FACE_ENROLLMENT_SECRET === DEV_AGENT_FACE_ENROLLMENT_SECRET
  ) {
    throw new EnvError(
      'AGENT_FACE_ENROLLMENT_SECRET must be set to a private random value in production',
      ['AGENT_FACE_ENROLLMENT_SECRET'],
    );
  }

  return env;
}

let cached: Env | null = null;

/** Lazily load and cache the validated environment. */
export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}
