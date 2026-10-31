// ─── File Utilities ───────────────────────────────────────────────────────────
// Pure helpers for file names, extensions, and MIME types.
// Extracted from the legacy Firebase Storage module — no Firebase dependency.

export function generateFileName(extension: string): string {
  const timestamp = Date.now();
  const random    = Math.random().toString(36).slice(2, 8);
  return `${timestamp}_${random}.${extension}`;
}

export function getFileExtension(uri: string): string {
  // Strip a URL's query/fragment first. Presigned URLs contain many dots and
  // long query parameters; treating that suffix as an extension makes the
  // server reject upload metadata (ext is capped at 10 characters).
  const path = uri.split(/[?#]/, 1)[0];
  const match = /\.([a-z0-9]{1,10})$/i.exec(path);
  return match?.[1].toLowerCase() ?? 'jpg';
}

export function getMimeType(uri: string): string {
  const ext = getFileExtension(uri);
  const mimeTypes: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp',
    mp4: 'video/mp4',  mov: 'video/quicktime', avi: 'video/x-msvideo',
    m4a: 'audio/mp4',  mp3: 'audio/mpeg',      wav: 'audio/wav',
    pdf: 'application/pdf', txt: 'text/plain',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
