// ─── Firebase Storage Utilities ───────────────────────────────────────────────
// Uses @react-native-firebase/storage on native (iOS/Android) and the
// firebase/storage JS SDK on web — both accessed via the unified `storage`
// export from ./firebase so callers never import from either SDK directly.

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { storage } from './firebase';

export type UploadType = 'avatar' | 'chatMedia' | 'voice' | 'groupIcon' | 'status';

// Maximum size for the base64 fallback (bytes). Beyond this we refuse to
// fall back — reading a huge file into JS memory would crash the bridge.
const MAX_BASE64_FALLBACK_BYTES = 25 * 1024 * 1024; // 25 MB

// ── Build storage path ────────────────────────────────────────────────────────
function buildPath(type: UploadType, params: {
  userId?:  string;
  chatId?:  string;
  fileName: string;
}): string {
  const { userId, chatId, fileName } = params;
  switch (type) {
    case 'avatar':    return `avatars/${userId}/${fileName}`;
    case 'chatMedia': return `chats/${chatId}/media/${fileName}`;
    case 'voice':     return `chats/${chatId}/voice/${fileName}`;
    case 'groupIcon': return `groups/${chatId}/${fileName}`;
    case 'status':    return `status/${userId}/${fileName}`;
    default:          return `misc/${fileName}`;
  }
}

// ── Strip iOS metadata fragment + query string from a local URI ───────────────
// Photos-library assets on iOS can come back as:
//   file:///.../IMG_0007.MOV#YnBsaXN0MDDRAQJfEBtSZWNvbW1lbmRlZEZvckltbWVyc2l2ZU1vZGUQAAgL...
// The `#...` fragment is base64 metadata, NOT part of the file path, and it
// breaks both the Storage path (bad extension) and the native read.
function sanitizeLocalUri(uri: string): string {
  if (!uri) return uri;
  return uri.split('#')[0].split('?')[0];
}

// ── Upload native file, with base64 fallback for storage/unknown ──────────────
// On iOS, `@react-native-firebase/storage`'s putFile() can fail with
// `storage/unknown` even when the file exists, is non-empty, and is readable
// by expo-file-system. The root cause is inside the SDK's NSInputStream code
// path (something about how it opens files inside the app's Library/Caches).
//
// The reliable workaround is to read the file into JS as base64 and push it
// via `putString(base64, 'base64')`, which bypasses the native file-read
// code path entirely. We only do this for errors that actually indicate a
// file-read problem — auth/quota/network errors are re-thrown untouched.
async function uploadNativeWithFallback(
  nativeRef: any,
  localUri: string,
  contentType: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  // ── Pre-upload sanity check ──
  try {
    const info: any = await FileSystem.getInfoAsync(localUri);
    console.log('[Storage][diag] pre-upload file check', {
      uri: localUri,
      exists: info?.exists,
      size: info?.size,
      contentType,
    });
    if (!info?.exists) {
      throw new Error(`Local file does not exist: ${localUri}`);
    }
    if (typeof info?.size === 'number' && info.size === 0) {
      throw new Error(`Local file is empty: ${localUri}`);
    }
  } catch (err) {
    // If the sanity check itself throws a real "file missing/empty" error,
    // propagate it — the caller will show a nice message.
    if (err instanceof Error && /does not exist|is empty/.test(err.message)) {
      throw err;
    }
    console.warn('[Storage][diag] pre-upload check failed (continuing):', err);
  }

  // ── Attempt #1: native putFile (streams from disk, low memory) ──
  try {
    const task = nativeRef.putFile(localUri, { contentType });
    if (onProgress) {
      task.on('state_changed', (snap: any) => {
        if (snap.totalBytes > 0) {
          onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100));
        }
      });
    }
    await task;
    return;
  } catch (e: any) {
    const code = e?.code;
    console.log('[Storage][diag] putFile FAILED, will try base64 fallback', {
      code,
      message: e?.message,
      nativeError: e?.nativeErrorMessage,
      localUri,
      contentType,
    });

    const isFileReadProblem =
      code === 'storage/unknown' ||
      code === 'storage/file-not-found' ||
      code === 'storage/invalid-argument' ||
      code === 'storage/invalid-format' ||
      (typeof e?.message === 'string' &&
        (e.message.includes('file-not-found') ||
         e.message.includes('unknown') ||
         e.message.includes('does not exist')));

    if (!isFileReadProblem) {
      // Genuine error (auth, quota, network, etc.) — let the caller see it.
      throw e;
    }
  }

  // ── Attempt #2: base64 putString fallback ──
  const info: any = await FileSystem.getInfoAsync(localUri);
  const size = typeof info?.size === 'number' ? info.size : 0;
  if (size > MAX_BASE64_FALLBACK_BYTES) {
    throw new Error(
      `putFile failed and file is too large (${Math.round(size / 1024 / 1024)}MB) ` +
      `for base64 fallback (max ${Math.round(MAX_BASE64_FALLBACK_BYTES / 1024 / 1024)}MB)`,
    );
  }

  const base64 = await FileSystem.readAsStringAsync(localUri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!base64 || base64.length === 0) {
    throw new Error(`Base64 read returned empty for: ${localUri}`);
  }

  console.log('[Storage][diag] base64 fallback uploading', {
    localUri, size, base64Length: base64.length, contentType,
  });

  const task = nativeRef.putString(base64, 'base64', { contentType });
  if (onProgress) {
    task.on('state_changed', (snap: any) => {
      if (snap.totalBytes > 0) {
        onProgress(Math.round((snap.bytesTransferred / snap.totalBytes) * 100));
      }
    });
  }
  await task;
  console.log('[Storage][diag] base64 fallback succeeded');
}

// ── Upload any file and return download URL ───────────────────────────────────
export async function uploadFile(
  localUri:    string,
  type:        UploadType,
  params:      { userId?: string; chatId?: string; fileName: string },
  onProgress?: (pct: number) => void,
): Promise<string> {
  const path = buildPath(type, params);

  // Always sanitize before doing anything with the URI. A trailing
  // "#<base64-metadata>" fragment on iOS would otherwise:
  //   • corrupt the storage object name (e.g. IMG.mov#YnBsaXN0...)
  //   • produce a wrong mime type (mov#fragment → application/octet-stream)
  //   • cause putFile to fail with storage/unknown
  const cleanUri = sanitizeLocalUri(localUri);
  const contentType = getMimeType(cleanUri);

  console.log('[Storage] Uploading file:', cleanUri, '→', path, '(contentType:', contentType, ')');

  if (Platform.OS !== 'web') {
    // ── Native: @react-native-firebase/storage ──────────────────────────────
    const nativeRef = (storage as ReturnType<typeof import('@react-native-firebase/storage').default>).ref(path);
    await uploadNativeWithFallback(nativeRef, cleanUri, contentType, onProgress);
    const url = await nativeRef.getDownloadURL();
    console.log('[Storage] Upload complete:', url);
    return url;
  } else {
    // ── Web: firebase/storage JS SDK ────────────────────────────────────────
    const { ref, uploadBytesResumable, getDownloadURL } = await import('firebase/storage');

    const blob: Blob = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.onload  = () => resolve(xhr.response as Blob);
      xhr.onerror = () => reject(new Error('Failed to read local file as blob'));
      xhr.responseType = 'blob';
      xhr.open('GET', cleanUri);
      xhr.send();
    });

    const storageRef = ref(storage as any, path);
    return new Promise((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, blob, {
        contentType,
      });
      task.on(
        'state_changed',
        (snapshot) => {
          if (onProgress && snapshot.totalBytes > 0) {
            onProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
          }
        },
        reject,
        async () => {
          try {
            resolve(await getDownloadURL(task.snapshot.ref));
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }
}

// ── Delete a file from Storage ────────────────────────────────────────────────
export async function deleteFile(downloadUrl: string): Promise<void> {
  if (Platform.OS !== 'web') {
    const nativeSt = storage as ReturnType<typeof import('@react-native-firebase/storage').default>;
    await nativeSt.refFromURL(downloadUrl).delete();
  } else {
    const { ref, deleteObject } = await import('firebase/storage');
    await deleteObject(ref(storage as any, downloadUrl));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
export function generateFileName(extension: string): string {
  // Sanitize the extension so a bad URI fragment can't leak into the file
  // name (e.g. "mov#YnBsaXN0..." → "mov").
  const cleanExt = (extension || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'bin';
  const timestamp = Date.now();
  const random    = Math.random().toString(36).slice(2, 8);
  return `${timestamp}_${random}.${cleanExt}`;
}

export function getFileExtension(uri: string): string {
  if (!uri) return 'jpg';
  // Strip iOS `#fragment` and any `?query` before extracting the extension,
  // so `IMG_0007.MOV#YnBsaXN0...` correctly yields `mov`, not `mov#ynbsaxn0...`.
  const clean = uri.split('#')[0].split('?')[0];
  const match = clean.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : 'jpg';
}

export function getMimeType(uri: string): string {
  const ext = getFileExtension(uri);
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
    pdf: 'application/pdf', txt: 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}