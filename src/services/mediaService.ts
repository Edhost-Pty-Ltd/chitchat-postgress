// ─── mediaService ────────────────────────────────────────────────────────────
// Backend-backed media access via presigned URLs (Req 10). The App requests a
// presigned PUT URL + object key, uploads the bytes DIRECTLY to the object
// store (never through the backend, Req 10.8), and stores the object key.
// Downloads resolve an object key to a short-lived presigned GET URL.
//
// Native uploads use `expo-file-system/legacy` `uploadAsync` with a PUT and
// BINARY_CONTENT body — verified against the installed expo-file-system@57 API
// per AGENTS.md (the top-level uploadAsync is deprecated/throws in SDK 57; the
// `/legacy` entry is the supported path). Web uploads use fetch + Blob.

import { Platform } from 'react-native';
import { apiClient, type ApiClient } from '../api/client';
import { getMimeType } from '../config/storage';

export type MediaCategory =
  | 'avatar'
  | 'chat-media'
  | 'chat-voice'
  | 'group'
  | 'status'
  | 'meeting';

export interface UploadTarget {
  uploadUrl: string;
  objectKey: string;
  expiresAt: string;
}

export interface UploadParams {
  chatId?: string;
  meetingId?: string;
  /** File size in bytes; required by the backend for validation. */
  sizeBytes: number;
  /** Content type; inferred from the URI when omitted. */
  contentType?: string;
  /** File extension (without dot) to append to the object key. */
  ext?: string;
}

export class MediaService {
  constructor(private readonly client: ApiClient = apiClient) {}

  /** Request a presigned upload URL + object key (Req 10.1). */
  async getUploadUrl(category: MediaCategory, localUri: string, params: UploadParams): Promise<UploadTarget> {
    const contentType = params.contentType ?? getMimeType(localUri);
    const res = await this.client.post<UploadTarget>('/media/upload-url', {
      category,
      contentType,
      sizeBytes: params.sizeBytes,
      chatId: params.chatId,
      meetingId: params.meetingId,
      ext: params.ext ?? extFromUri(localUri),
    });
    if (!res.ok) throw new Error(`getUploadUrl failed: ${res.error.message}`);
    return res.data;
  }

  /**
   * Upload a local file to the object store via a presigned PUT and return the
   * stored object key (Req 10.8).
   */
  async upload(localUri: string, category: MediaCategory, params: UploadParams): Promise<string> {
    const contentType = params.contentType ?? getMimeType(localUri);
    const target = await this.getUploadUrl(category, localUri, { ...params, contentType });

    if (Platform.OS === 'web') {
      const blob = await (await fetch(localUri)).blob();
      const put = await fetch(target.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: blob,
      });
      if (!put.ok) throw new Error(`Upload failed: HTTP ${put.status}`);
    } else {
      // expo-file-system@57: use the supported /legacy uploadAsync.
      const { uploadAsync, FileSystemUploadType } = await import('expo-file-system/legacy');
      const result = await uploadAsync(target.uploadUrl, localUri, {
        httpMethod: 'PUT',
        uploadType: FileSystemUploadType.BINARY_CONTENT,
        headers: { 'Content-Type': contentType },
      });
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Upload failed: HTTP ${result.status}`);
      }
    }

    return target.objectKey;
  }

  /** Resolve an object key to a short-lived download URL (Req 10.6). */
  async getDownloadUrl(objectKey: string): Promise<string | null> {
    if (!objectKey) return null;
    const res = await this.client.post<{ urls: Record<string, string> }>('/media/download-url', {
      objectKeys: [objectKey],
    });
    if (!res.ok) return null;
    return res.data.urls[objectKey] ?? null;
  }

  /** Resolve several object keys at once (Req 10.6). */
  async getDownloadUrls(objectKeys: string[]): Promise<Record<string, string>> {
    const keys = objectKeys.filter(Boolean);
    if (keys.length === 0) return {};
    const res = await this.client.post<{ urls: Record<string, string> }>('/media/download-url', {
      objectKeys: keys,
    });
    return res.ok ? res.data.urls : {};
  }
}

function extFromUri(uri: string): string | undefined {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(uri);
  return m ? m[1] : undefined;
}

/**
 * Best-effort local file size in bytes, used for the backend's upload-size
 * validation. Falls back to 0 when it can't be determined (the backend still
 * enforces the hard cap on the actual object).
 */
export async function fileSize(localUri: string): Promise<number> {
  try {
    if (Platform.OS === 'web') {
      const blob = await (await fetch(localUri)).blob();
      return blob.size;
    }
    const { File } = await import('expo-file-system');
    const f = new File(localUri);
    return f.size ?? 0;
  } catch {
    return 0;
  }
}

export const mediaService = new MediaService();
