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
