// ─── Voice Note Storage ───────────────────────────────────────────────────────
// Uploads voice notes to MinIO via the backend presigned-URL pipeline.
// This replaces the old Firebase Storage REST path, which embedded expiring
// auth tokens in the download URL and bypassed the S3 authorization layer.

export interface UploadProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
}

export interface UploadResult {
  downloadUrl: string;  // S3 object key — resolved to a signed URL at display time
  storagePath: string;  // same value, kept for API compatibility
}

export async function uploadVoiceNote(
  uri: string,
  chatId: string,
  _messageId: string,
  onProgress: (progress: UploadProgress) => void,
): Promise<UploadResult> {
  const { mediaService, fileSize } = await import('../services/mediaService');

  onProgress({ bytesTransferred: 0, totalBytes: 1, percentage: 0 });

  const objectKey = await mediaService.upload(uri, 'chat-voice', {
    chatId,
    sizeBytes: await fileSize(uri),
    contentType: 'audio/mp4',
    ext: 'm4a',
  });

  onProgress({ bytesTransferred: 1, totalBytes: 1, percentage: 100 });

  // Return the object key as both fields. The caller (ChatScreen) passes
  // downloadUrl to sendVoiceMessage, which stores it as mediaObjectKey.
  // resolveMessageMedia will sign it on display since it's not an https:// URL.
  return { downloadUrl: objectKey, storagePath: objectKey };
}
