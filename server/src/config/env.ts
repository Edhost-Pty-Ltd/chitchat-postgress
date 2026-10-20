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

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

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

  // AI meeting minutes (old summarizeMeetingRecording Cloud Function). Optional:
  // without a key the summarize endpoints answer 503 and everything else works.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.8-flash'),
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

  return env;
}

let cached: Env | null = null;

/** Lazily load and cache the validated environment. */
export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}
