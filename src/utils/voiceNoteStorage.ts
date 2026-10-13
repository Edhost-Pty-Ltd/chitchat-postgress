// ─── Voice Note Storage ───────────────────────────────────────────────────────
// Uploads voice notes to Firebase Storage via the REST API using
// expo-file-system/legacy uploadAsync (PUT with BINARY_CONTENT).
// This avoids atob() which is not available in Hermes on Android.

export interface UploadProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}

export interface UploadResult {
  downloadUrl: string;
  storagePath: string;
}

async function uploadVoiceNoteReal(
  uri: string,
  chatId: string,
  messageId: string,
  onProgress: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  const storagePath = `voiceNotes/${chatId}/${messageId}.m4a`;

  // Get Firebase auth token (no SDK, just the token from the Auth instance)
  const { getAuth } = await import('@react-native-firebase/auth');
  const auth = getAuth();
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error('User not authenticated');
  const token = await currentUser.getIdToken();

  // Use expo-file-system/legacy uploadAsync — sends the file bytes directly via
  // a native HTTP PUT, no base64 conversion needed (no atob on Hermes risk).
  const { uploadAsync, FileSystemUploadType } = await import('expo-file-system/legacy');

  const bucketName = 'chitchatbusiness-880ce.firebasestorage.app';
  const uploadUrl  = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o?name=${encodeURIComponent(storagePath)}`;

  // expo-file-system does not expose upload progress for this upload type.
  // Fire a synthetic start event so the UI shows activity.
  onProgress({ bytesTransferred: 0, totalBytes: 1, percentage: 0 });

  const result = await uploadAsync(uploadUrl, uri, {
    httpMethod:  'POST',
    uploadType:  FileSystemUploadType.BINARY_CONTENT,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'audio/mp4',
    },
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Upload failed with status ${result.status}`);
  }

  onProgress({ bytesTransferred: 1, totalBytes: 1, percentage: 100 });

  const downloadUrl = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
  return { downloadUrl, storagePath };
}

export const uploadVoiceNote = uploadVoiceNoteReal;
