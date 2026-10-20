// ─── useChatActions Unit Tests ────────────────────────────────────────────────
// Tests: sendVoiceMessage routes through the backend API client.
// Requirements: 4.1, 4.2, 4.3

// ─── Mock API endpoints ────────────────────────────────────────────────────────

const mockSendMessage = jest.fn();

jest.mock('../../api/endpoints', () => ({
  endpoints: {
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    createChat: jest.fn().mockResolvedValue({ ok: true, data: { chatId: 'chat-123', type: 'direct' } }),
    listChats: jest.fn().mockResolvedValue({ ok: true, data: { chats: [], totalUnread: 0 } }),
  },
}));

// ─── Mock mediaService ────────────────────────────────────────────────────────

jest.mock('../../services/mediaService', () => ({
  mediaService: {
    upload: jest.fn().mockResolvedValue('chats/chat-123/voice/uuid.m4a'),
  },
  fileSize: jest.fn().mockResolvedValue(5000),
}));

// ─── Import after mocks ──────────────────────────────────────────────────────

import { sendVoiceMessage, sendMessage, getOrCreateDirectChat } from '../useChatActions';

// ─── Test Suite ───────────────────────────────────────────────────────────────

describe('sendVoiceMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMessage.mockResolvedValue({
      ok: true,
      data: { message: { id: 'generated-msg-id', chatId: 'chat-123', senderId: 'sender-1', type: 'voice', text: null, mediaObjectKey: 'chats/chat-123/voice/uuid.m4a', durationMs: 5000, clientId: null, thumbnailObjectKey: null, fileName: null, fileSize: null, mimeType: null, location: null, catalogItem: null, replyTo: null, subtype: null, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString(), deletedForEveryone: false, deliveredTo: [], readBy: [], edited: false, editedAt: null } },
    });
  });

  // ── Req 4.1: Message is sent via the backend API ──
  describe('message via backend (Req 4.1)', () => {
    it('calls endpoints.sendMessage with type voice and durationMs', async () => {
      const result = await sendVoiceMessage('chat-123', 'sender-1', 'file:///tmp/audio.m4a', 5000);

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('generated-msg-id');
      expect(mockSendMessage).toHaveBeenCalledWith(
        'chat-123',
        expect.objectContaining({
          type: 'voice',
          durationMs: 5000,
        }),
      );
    });

    it('sets type to "voice" and includes durationMs', async () => {
      await sendVoiceMessage('chat-123', 'sender-1', 'file:///tmp/audio.m4a', 12345);
      const [, input] = mockSendMessage.mock.calls[0];
      expect(input.type).toBe('voice');
      expect(input.durationMs).toBe(12345);
    });
  });

  // ── Req 4.2: lastMessage preview handled server-side ──
  describe('lastMessage preview (Req 4.2)', () => {
    it('returns success when API call succeeds', async () => {
      const result = await sendVoiceMessage('chat-123', 'sender-1', 'file:///tmp/audio.m4a', 3000);
      expect(result.success).toBe(true);
    });
  });

  // ── Req 4.3: Unread count incremented server-side ──
  describe('unread count (Req 4.3)', () => {
    it('returns failure when API call fails', async () => {
      mockSendMessage.mockResolvedValue({ ok: false, error: { message: 'Network error', kind: 'network', code: 'NETWORK' } });
      const result = await sendVoiceMessage('chat-123', 'sender-1', 'file:///tmp/audio.m4a', 3000);
      expect(result.success).toBe(false);
    });
  });

  // ── Edge case: API error ──
  describe('error handling', () => {
    it('returns failure on API error', async () => {
      mockSendMessage.mockRejectedValue(new Error('Connection refused'));
      const result = await sendVoiceMessage('chat-123', 'sender-1', 'file:///tmp/audio.m4a', 3000);
      expect(result.success).toBe(false);
      expect(result.messageId).toBe('');
    });
  });
});

describe('sendMessage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMessage.mockResolvedValue({ ok: true, data: { message: { id: 'msg-1' } } });
  });

  it('sends a text message via the backend API', async () => {
    const result = await sendMessage('chat-123', 'sender-1', 'Hello');
    expect(result).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith('chat-123', expect.objectContaining({ type: 'text', text: 'Hello' }));
  });

  it('returns false for empty text', async () => {
    const result = await sendMessage('chat-123', 'sender-1', '  ');
    expect(result).toBe(false);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

describe('getOrCreateDirectChat', () => {
  it('calls createChat and returns the chatId', async () => {
    const chatId = await getOrCreateDirectChat('user-1', 'user-2');
    expect(chatId).toBe('chat-123');
  });
});
