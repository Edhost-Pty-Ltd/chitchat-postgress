// ─── Firebase Storage Utilities ───────────────────────────────────────────────
// Uses @react-native-firebase/storage on native (iOS/Android) and the
// firebase/storage JS SDK on web — both accessed via the unified `storage`
// export from ./firebase so callers never import from either SDK directly.

import { Platform } from 'react-native';
import { storage } from './firebase';

export type UploadType = 'avatar' | 'chatMedia' | 'voice' | 'groupIcon' | 'status';

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

// ── Upload any file and return download URL ───────────────────────────────────
export async function uploadFile(
  localUri:    string,
  type:        UploadType,
  params:      { userId?: string; chatId?: string; fileName: string },
  onProgress?: (pct: number) => void,
): Promise<string> {
  const path = buildPath(type, params);
  console.log('[Storage] Uploading file:', localUri, '→', path);

  if (Platform.OS !== 'web') {
    // ── Native: @react-native-firebase/storage ──────────────────────────────
    // putFile() streams directly from a local URI — no blob/XHR needed.
    const nativeRef = (storage as ReturnType<typeof import('@react-native-firebase/storage').default>).ref(path);
    const task = nativeRef.putFile(localUri, { contentType: getMimeType(localUri) });

    if (onProgress) {
      task.on('state_changed', (snapshot: any) => {
        if (snapshot.totalBytes > 0) {
          onProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
        }
      });
    }

    await task;
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
      xhr.open('GET', localUri);
      xhr.send();
    });

    const storageRef = ref(storage as any, path);
    return new Promise((resolve, reject) => {
      const task = uploadBytesResumable(storageRef, blob, {
        contentType: getMimeType(localUri),
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
  const timestamp = Date.now();
  const random    = Math.random().toString(36).slice(2, 8);
  return `${timestamp}_${random}.${extension}`;
}

export function getFileExtension(uri: string): string {
  return uri.split('.').pop()?.toLowerCase() || 'jpg';
}

export function getMimeType(uri: string): string {
  const ext = getFileExtension(uri);
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav',
    pdf: 'application/pdf', txt: 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
