// ─── mediaService ────────────────────────────────────────────────────────────
// Backend-backed media access via presigned URLs (Req 10). The App requests a
// presigned PUT URL + object key, uploads the bytes DIRECTLY to the object
// store (never through the backend, Req 10.8), and stores the object key.
// Downloads resolve an object key to a short-lived presigned GET URL.
//
// Native uploads use `expo-file-system/legacy` `createUploadTask` with a PUT
// BINARY_CONTENT body so SDK 57 can report real bytes sent/remaining. Web uses
// XMLHttpRequest because fetch does not expose upload progress.

import { Platform } from 'react-native';
import { apiClient, type ApiClient } from '../api/client';
import { getMimeType } from '../utils/fileUtils';

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

export interface MediaUploadProgress {
  bytesSent: number;
  totalBytes: number;
  remainingBytes: number;
  percentage: number;
}

export type MediaUploadProgressCallback = (progress: MediaUploadProgress) => void;

// Presigned GET URLs are valid for 1 hour server-side (DOWNLOAD_URL_TTL_SEC).
// Cache resolved URLs well under that so a cached URL is never served past its
// validity, and so the same object key isn't re-signed on every data reload
// (messages re-render, status refetches, etc.). This removes the bulk of the
// /media/download-url round-trips the app was making.
const DOWNLOAD_URL_CACHE_TTL_MS = 45 * 60 * 1000; // 45 min (< server's 60 min)

interface CachedUrl { url: string; expiresAt: number; }

export class MediaService {
  constructor(private readonly client: ApiClient = apiClient) {}

  /** In-memory cache of objectKey → resolved presigned GET URL. */
  private readonly urlCache = new Map<string, CachedUrl>();

  /** Return a non-expired cached URL for a key, or null. */
  private cachedUrl(objectKey: string): string | null {
    const hit = this.urlCache.get(objectKey);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      this.urlCache.delete(objectKey);
      return null;
    }
    return hit.url;
  }

  private cacheUrls(urls: Record<string, string>): void {
    const expiresAt = Date.now() + DOWNLOAD_URL_CACHE_TTL_MS;
    for (const [key, url] of Object.entries(urls)) {
      if (url) this.urlCache.set(key, { url, expiresAt });
    }
  }

  /** Drop a key from the cache (e.g. after the object is replaced/deleted). */
  invalidateUrl(objectKey: string): void {
    this.urlCache.delete(objectKey);
  }

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
   * stored object key (Req 10.8). Native uses SDK 57's progress-capable legacy
   * UploadTask; web uses XHR because fetch does not expose upload progress.
   */
  async upload(
    localUri: string,
    category: MediaCategory,
    params: UploadParams,
    onProgress?: MediaUploadProgressCallback,
  ): Promise<string> {
    const contentType = params.contentType ?? getMimeType(localUri);
    const target = await this.getUploadUrl(category, localUri, { ...params, contentType });

    const report = (bytesSent: number, expectedBytes: number) => {
      const totalBytes = expectedBytes > 0 ? expectedBytes : Math.max(0, params.sizeBytes);
      const safeSent = Math.max(0, Math.min(bytesSent, totalBytes || bytesSent));
      const percentage = totalBytes > 0 ? Math.round((safeSent / totalBytes) * 100) : 0;
      onProgress?.({
        bytesSent: safeSent,
        totalBytes,
        remainingBytes: Math.max(0, totalBytes - safeSent),
        percentage: Math.max(0, Math.min(100, percentage)),
      });
    };

    report(0, params.sizeBytes);

    if (Platform.OS === 'web') {
      const blob = await (await fetch(localUri)).blob();
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', target.uploadUrl);
        xhr.setRequestHeader('Content-Type', contentType);
        xhr.upload.onprogress = (event) => {
          report(event.loaded, event.lengthComputable ? event.total : blob.size || params.sizeBytes);
        };
        xhr.onerror = () => reject(new Error('Upload failed: network error'));
        xhr.onabort = () => reject(new Error('Upload cancelled'));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) resolve();
          else reject(new Error(`Upload failed: HTTP ${xhr.status}`));
        };
        xhr.send(blob);
      });
      report(blob.size, blob.size || params.sizeBytes);
    } else {
      const { createUploadTask, FileSystemUploadType } = await import('expo-file-system/legacy');
      const task = createUploadTask(
        target.uploadUrl,
        localUri,
        {
          httpMethod: 'PUT',
          uploadType: FileSystemUploadType.BINARY_CONTENT,
          headers: { 'Content-Type': contentType },
        },
        ({ totalBytesSent, totalBytesExpectedToSend }) => {
          report(totalBytesSent, totalBytesExpectedToSend || params.sizeBytes);
        },
      );
      const result = await task.uploadAsync();
      if (!result) throw new Error('Upload cancelled');
      if (result.status < 200 || result.status >= 300) {
        throw new Error(`Upload failed: HTTP ${result.status}`);
      }
      report(params.sizeBytes, params.sizeBytes);
    }

    return target.objectKey;
  }

  /** Resolve an object key to a short-lived download URL (Req 10.6). */
  async getDownloadUrl(objectKey: string): Promise<string | null> {
    if (!objectKey) return null;
    const cached = this.cachedUrl(objectKey);
    if (cached) return cached;
    const res = await this.client.post<{ urls: Record<string, string> }>('/media/download-url', {
      objectKeys: [objectKey],
    });
    if (!res.ok) return null;
    this.cacheUrls(res.data.urls);
    return res.data.urls[objectKey] ?? null;
  }

  /**
   * Resolve several object keys at once (Req 10.6). Keys already in the cache
   * are served from memory; only the cache-misses are requested from the
   * backend, so repeated reloads of the same media are near-free.
   */
  async getDownloadUrls(objectKeys: string[]): Promise<Record<string, string>> {
    const keys = objectKeys.filter(Boolean);
    if (keys.length === 0) return {};

    const result: Record<string, string> = {};
    const misses: string[] = [];
    for (const key of keys) {
      const cached = this.cachedUrl(key);
      if (cached) result[key] = cached;
      else misses.push(key);
    }
    if (misses.length === 0) return result;

    const res = await this.client.post<{ urls: Record<string, string> }>('/media/download-url', {
      objectKeys: misses,
    });
    if (res.ok) {
      this.cacheUrls(res.data.urls);
      Object.assign(result, res.data.urls);
    }
    return result;
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
