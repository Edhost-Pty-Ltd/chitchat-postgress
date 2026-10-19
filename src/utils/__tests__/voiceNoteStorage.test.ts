// ─── voiceNoteStorage Unit Tests ─────────────────────────────────────────────
// The voice note uploader routes through the backend presigned-URL pipeline
// (mediaService → MinIO/S3). Firebase Storage is no longer involved. Tests
// verify the uploader delegates to mediaService and returns the object key.

import { uploadVoiceNote } from '../voiceNoteStorage';

// ─── Mock mediaService (backend presigned-URL upload) ─────────────────────────

const mockUpload = jest.fn();
const mockFileSize = jest.fn();

jest.mock('../../services/mediaService', () => ({
  mediaService: {
    upload: (...args: any[]) => mockUpload(...args),
  },
  fileSize: (...args: any[]) => mockFileSize(...args),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockFileSize.mockResolvedValue(5000);
  mockUpload.mockResolvedValue('chats/chat1/voice/uuid.m4a');
});

describe('uploadVoiceNote', () => {
  describe('backend upload (mediaService)', () => {
    it('uploads via mediaService with the chat-voice category and chat context', async () => {
      await uploadVoiceNote('file://recording.m4a', 'chat1', 'msg1', jest.fn());

      expect(mockUpload).toHaveBeenCalledWith(
        'file://recording.m4a',
        'chat-voice',
        expect.objectContaining({ chatId: 'chat1', contentType: 'audio/mp4', ext: 'm4a' }),
      );
    });

    it('resolves with the object key as both downloadUrl and storagePath', async () => {
      const result = await uploadVoiceNote('file://recording.m4a', 'chat1', 'msg1', jest.fn());
      expect(result.downloadUrl).toBe('chats/chat1/voice/uuid.m4a');
      expect(result.storagePath).toBe('chats/chat1/voice/uuid.m4a');
    });
  });

  describe('progress callback', () => {
    it('reports 0% then 100% progress around the upload', async () => {
      const onProgress = jest.fn();
      await uploadVoiceNote('file://recording.m4a', 'chat1', 'msg1', onProgress);

      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ percentage: 0 }));
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ percentage: 100 }));
    });
  });

  describe('error handling', () => {
    it('propagates a failure from mediaService', async () => {
      mockUpload.mockRejectedValueOnce(new Error('UPLOAD_FAILED'));
      await expect(
        uploadVoiceNote('file://recording.m4a', 'chat1', 'msg1', jest.fn()),
      ).rejects.toThrow('UPLOAD_FAILED');
    });
  });
});
