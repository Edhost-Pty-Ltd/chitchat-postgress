// ─── voiceNoteStorage Unit Tests ─────────────────────────────────────────────
// The voice note uploader uses Firebase Storage REST API via XHR + IdToken
// (no Firebase Storage SDK). Tests verify size validation and timeout handling.

import { uploadVoiceNote } from '../voiceNoteStorage';

// ─── Mock @react-native-firebase/auth ─────────────────────────────────────────

jest.mock('@react-native-firebase/auth', () => ({
  getAuth: () => ({
    currentUser: {
      getIdToken: jest.fn().mockResolvedValue('mock-id-token'),
    },
  }),
}));

// ─── Mock expo-file-system/legacy ────────────────────────────────────────────

jest.mock('expo-file-system/legacy', () => ({
  readAsStringAsync: jest.fn().mockResolvedValue('base64data'),
  EncodingType: { Base64: 'base64' },
}));

// ─── Mock global XHR ──────────────────────────────────────────────────────────

const mockOpen  = jest.fn();
const mockSend  = jest.fn();
const mockSetRequestHeader = jest.fn();
const mockAbort = jest.fn();

const listeners: Record<string, Function> = {};
const uploadListeners: Record<string, Function> = {};

class MockXHR {
  status = 200;
  upload = { addEventListener: (e: string, fn: Function) => { uploadListeners[e] = fn; } };
  open = mockOpen;
  send = mockSend;
  setRequestHeader = mockSetRequestHeader;
  abort = mockAbort;
  addEventListener(event: string, fn: Function) { listeners[event] = fn; }
}

(global as any).XMLHttpRequest = MockXHR;

// ─── Mock global atob ────────────────────────────────────────────────────────

(global as any).atob = (str: string) => Buffer.from(str, 'base64').toString('binary');

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  Object.keys(uploadListeners).forEach((k) => delete uploadListeners[k]);
  mockSend.mockImplementation(() => {
    // Simulate successful upload by firing the load event
    setTimeout(() => { if (listeners['load']) listeners['load'](); }, 0);
  });
});

describe('uploadVoiceNote', () => {
  describe('file size validation', () => {
    it('rejects files over 10 MB with RECORDING_TOO_LARGE error', async () => {
      const { readAsStringAsync } = await import('expo-file-system/legacy');
      // base64 of 10MB+ file — mock the decoded size by returning a very long string
      (readAsStringAsync as jest.Mock).mockResolvedValueOnce('A'.repeat(14 * 1024 * 1024));

      await expect(
        uploadVoiceNote('file://recording.m4a', 'chat1', 'msg1', jest.fn()),
      ).rejects.toThrow('RECORDING_TOO_LARGE');
    });
  });

  describe('timeout handling', () => {
    it('rejects with UPLOAD_TIMEOUT after 30 seconds', async () => {
      jest.useFakeTimers();
      mockSend.mockImplementation(() => {
        // Never fire the load event — simulates a stalled upload
      });

      const promise = uploadVoiceNote('file://recording.m4a', 'chat1', 'msg1', jest.fn());
      jest.advanceTimersByTime(30000);
      await expect(promise).rejects.toThrow('UPLOAD_TIMEOUT');
      expect(mockAbort).toHaveBeenCalled();
    });
  });

  describe('progress callback', () => {
    it('invokes onProgress when upload progresses', async () => {
      const onProgress = jest.fn();
      mockSend.mockImplementation(() => {
        // Fire progress then load
        if (uploadListeners['progress']) {
          uploadListeners['progress']({ lengthComputable: true, loaded: 2500, total: 5000 });
        }
        setTimeout(() => { if (listeners['load']) listeners['load'](); }, 0);
      });

      await uploadVoiceNote('file://recording.m4a', 'chat1', 'msg1', onProgress);

      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ percentage: 50 }));
    });
  });

  describe('successful upload', () => {
    it('resolves with a downloadUrl and storagePath', async () => {
      const result = await uploadVoiceNote('file://recording.m4a', 'chat1', 'msg1', jest.fn());
      expect(result.storagePath).toBe('voiceNotes/chat1/msg1.m4a');
      expect(result.downloadUrl).toContain('voiceNotes/chat1/msg1.m4a');
    });
  });
});
