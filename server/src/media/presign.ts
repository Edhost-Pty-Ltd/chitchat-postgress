import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getEnv } from '../config/env.js';

export type MediaCategory = 'avatar' | 'chat-media' | 'chat-voice' | 'group' | 'status' | 'meeting';

export const UPLOAD_URL_TTL_SEC = 15 * 60; // 15 minutes (Req 10.4)
const DOWNLOAD_URL_TTL_SEC = 60 * 60; // 1 hour

// Per-category size + content-type limits (Req 10.5).
const LIMITS: Record<MediaCategory, { maxBytes: number; prefixes: string[] }> = {
  avatar: { maxBytes: 10 * 1024 * 1024, prefixes: ['image/'] },
  'chat-media': { maxBytes: 100 * 1024 * 1024, prefixes: ['image/', 'video/', 'application/', 'text/'] },
  'chat-voice': { maxBytes: 25 * 1024 * 1024, prefixes: ['audio/'] },
  group: { maxBytes: 10 * 1024 * 1024, prefixes: ['image/'] },
  status: { maxBytes: 100 * 1024 * 1024, prefixes: ['image/', 'video/'] },
  meeting: { maxBytes: 500 * 1024 * 1024, prefixes: ['video/', 'audio/', 'application/'] },
};

let client: S3Client | null = null;
let publicClient: S3Client | null = null;

/** Internal client — used for operations like DeleteObject that run server-side. */
function s3(): S3Client {
  if (!client) {
    const env = getEnv();
    client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

/**
 * Public client — used to sign presigned URLs. When S3_PUBLIC_ENDPOINT is set
 * (e.g. http://10.0.0.165:9000 for LAN device testing) URLs are signed with
 * that endpoint so the phone can verify the signature when it uploads directly.
 * Signing with localhost and then rewriting the host breaks the signature.
 */
function s3Public(): S3Client {
  if (!publicClient) {
    const env = getEnv();
    const endpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;
    publicClient = new S3Client({
      region: env.S3_REGION,
      endpoint,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return publicClient;
}

export class MediaAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaAuthError';
  }
}
export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

/**
 * Build an authorized object key for a category, enforcing the per-category
 * prefix and that the caller may write under it (Req 10.2, 10.3, Property 20).
 */
export function buildObjectKey(
  userId: string,
  category: MediaCategory,
  params: { chatId?: string; meetingId?: string; ext?: string },
): string {
  const name = `${randomUUID()}${params.ext ? `.${params.ext.replace(/^\./, '')}` : ''}`;
  switch (category) {
    case 'avatar':
      return `avatars/${userId}/${name}`;
    case 'status':
      return `status/${userId}/${name}`;
    case 'chat-media':
      if (!params.chatId) throw new MediaValidationError('chatId required');
      return `chats/${params.chatId}/media/${name}`;
    case 'chat-voice':
      if (!params.chatId) throw new MediaValidationError('chatId required');
      return `chats/${params.chatId}/voice/${name}`;
    case 'group':
      if (!params.chatId) throw new MediaValidationError('chatId required');
      return `groups/${params.chatId}/${name}`;
    case 'meeting':
      if (!params.meetingId) throw new MediaValidationError('meetingId required');
      return `meetings/${params.meetingId}/${name}`;
    default:
      throw new MediaValidationError('unknown category');
  }
}

/** Validate the declared content type and size against the category limits. */
export function validateUpload(
  category: MediaCategory,
  contentType: string,
  sizeBytes: number,
): void {
  const limit = LIMITS[category];
  if (!limit) throw new MediaValidationError('unknown category');
  if (sizeBytes > limit.maxBytes) {
    throw new MediaValidationError(
      `File too large for ${category}: ${sizeBytes} > ${limit.maxBytes}`,
    );
  }
  if (!limit.prefixes.some((p) => contentType.startsWith(p))) {
    throw new MediaValidationError(`Content type ${contentType} not allowed for ${category}`);
  }
}

export interface UploadTarget {
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
}

/** Issue a presigned PUT URL (expires ≤ 15 min, Req 10.1, 10.4). */
export async function presignUpload(objectKey: string, contentType: string): Promise<UploadTarget> {
  const env = getEnv();
  // Sign with the public client so the URL hostname matches what the device
  // will send in the Host header — a hostname mismatch breaks the signature.
  const url = await getSignedUrl(
    s3Public(),
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_TTL_SEC },
  );
  return {
    uploadUrl: url,
    objectKey,
    expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SEC * 1000).toISOString(),
  };
}

/** Issue a presigned GET URL for a stored object (Req 10.6). */
export async function presignDownload(objectKey: string): Promise<string> {
  const env = getEnv();
  return getSignedUrl(
    s3Public(),
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }),
    { expiresIn: DOWNLOAD_URL_TTL_SEC },
  );
}

/** Delete an object from the store (Req 10.10). */
export async function deleteObject(objectKey: string): Promise<void> {
  const env = getEnv();
  await s3().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
}

/**
 * Authorize that a caller may write the requested category. Avatars/status are
 * always self-scoped (the key embeds the caller's id). Chat/group/meeting keys
 * require membership, checked by the route before calling this. Here we enforce
 * the self-scoped categories and leave membership to the caller (Req 10.3).
 */
export function assertSelfScoped(category: MediaCategory): boolean {
  return category === 'avatar' || category === 'status';
}

/**
 * Read an object's bytes server-side through the internal endpoint (used by the
 * meeting-minutes summarizer, which cannot use a LAN-signed presigned URL).
 */
export async function getObjectBuffer(objectKey: string): Promise<{ bytes: Buffer; contentType: string | null }> {
  const env = getEnv();
  const res = await s3().send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: objectKey }));
  if (!res.Body) throw new Error(`Object ${objectKey} has no body`);
  const bytes = Buffer.from(await res.Body.transformToByteArray());
  return { bytes, contentType: res.ContentType ?? null };
}
