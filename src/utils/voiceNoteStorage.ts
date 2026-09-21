import { storage } from '../config/firebase';

export interface UploadProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}

export interface UploadResult {
  downloadUrl: string;
  storagePath: string;
}

// ─── Dev mode: skip real Firebase Storage upload ──────────────────────────────
// DISABLED: Voice notes must use real Firebase Storage to work across devices.
// The mock only stores local file URIs which don't exist on other devices.
const USE_DEV_STORAGE_MOCK = false; // Changed from __DEV__ to false

async function uploadVoiceNoteMock(
  uri: string,
  chatId: string,
  messageId: string,
  onProgress: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  const storagePath = `voiceNotes/${chatId}/${messageId}.m4a`;

  // Simulate upload progress
  for (let i = 0; i <= 100; i += 25) {
    await new Promise((r) => setTimeout(r, 50));
    onProgress({ bytesTransferred: i * 100, totalBytes: 10000, percentage: i });
  }

  // Use the local file URI as the "download URL" — works for same-device playback
  return { downloadUrl: uri, storagePath };
}

// ─── Real Firebase Storage upload ─────────────────────────────────────────────

async function uploadVoiceNoteReal(
  uri: string,
  chatId: string,
  messageId: string,
  onProgress: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  const storagePath = `voiceNotes/${chatId}/${messageId}.m4a`;
  
  try {
    console.log('[VoiceStorage] Reading file from:', uri);
    
    // Import file system and storage helpers
    const { readAsStringAsync, EncodingType } = await import('expo-file-system/legacy');
    const { getAuth } = await import('@react-native-firebase/auth');
    
    // Read file as base64
    const base64Data = await readAsStringAsync(uri, {
      encoding: EncodingType.Base64,
    });
    
    console.log('[VoiceStorage] File read successfully, getting auth token...');
    
    // Get Firebase auth token
    const auth = getAuth();
    const currentUser = auth.currentUser;
    if (!currentUser) {
      throw new Error('User not authenticated');
    }
    
    const token = await currentUser.getIdToken();
    console.log('[VoiceStorage] Got auth token, uploading via XMLHttpRequest...');
    
    // Convert base64 to Uint8Array (no blob!)
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    // Check file size
    if (bytes.length > 10 * 1024 * 1024) {
      throw new Error('RECORDING_TOO_LARGE');
    }
    
    // Upload via XMLHttpRequest (works in React Native, no blobs!)
    return new Promise<UploadResult>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      
      const timeout = setTimeout(() => {
        xhr.abort();
        reject(new Error('UPLOAD_TIMEOUT'));
      }, 30000);
      
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const percentage = Math.round((e.loaded / e.total) * 100);
          onProgress({
            bytesTransferred: e.loaded,
            totalBytes: e.total,
            percentage,
          });
        }
      });
      
      xhr.addEventListener('load', () => {
        clearTimeout(timeout);
        if (xhr.status === 200) {
          // Get download URL
          const bucketName = 'chitchatbusiness-880ce.firebasestorage.app';
          const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media`;
          console.log('[VoiceStorage] Upload complete, URL:', downloadUrl);
          resolve({ downloadUrl, storagePath });
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });
      
      xhr.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Upload network error'));
      });
      
      xhr.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('Upload aborted'));
      });
      
      // Upload to Firebase Storage REST API
      const bucketName = 'chitchatbusiness-880ce.firebasestorage.app';
      const uploadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o?name=${encodeURIComponent(storagePath)}`;
      
      xhr.open('POST', uploadUrl);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', 'audio/mp4');
      xhr.send(bytes);
    });
  } catch (error: any) {
    console.error('[VoiceStorage] Upload error:', error);
    throw error;
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const uploadVoiceNote = USE_DEV_STORAGE_MOCK
  ? uploadVoiceNoteMock
  : uploadVoiceNoteReal;
