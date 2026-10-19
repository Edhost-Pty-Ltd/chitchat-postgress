// ─── useChatActions Hook ──────────────────────────────────────────────────────
// Chat and message actions via backend REST + media service.

import { generateFileName, getFileExtension } from '../utils/fileUtils';
import { endpoints } from '../api/endpoints';

// ── Create or get existing 1-on-1 chat ───────────────────────────────────────
export async function getOrCreateDirectChat(
  _currentUserId: string,
  otherUserId: string,
): Promise<string> {
  const res = await endpoints.createChat({ type: 'direct', members: [otherUserId] });
  if (!res.ok) throw new Error(`createChat failed: ${res.error.message}`);
  return res.data.chatId;
}

// ── Create a new group chat ───────────────────────────────────────────────────
export async function createGroupChat(
  _currentUserId: string,
  memberIds: string[],
  groupName: string,
): Promise<{ chatId: string; blockedByPrivacy: string[] }> {
  const res = await endpoints.createChat({ type: 'group', members: memberIds, groupName });
  if (!res.ok) throw new Error(`createGroupChat failed: ${res.error.message}`);
  return { chatId: res.data.chatId, blockedByPrivacy: [] };
}

// ── Send a text message ───────────────────────────────────────────────────────
export async function sendMessage(
  chatId: string,
  senderId: string,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const res = await endpoints.sendMessage(chatId, {
    type: 'text',
    text: trimmed,
    clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  });
  return res.ok;
}

// ── Mark chat as read ─────────────────────────────────────────────────────────
export async function markChatAsRead(_chatId: string, _userId: string): Promise<void> {
  // Reading messages sends the read ack over the socket, clearing unread counts server-side.
}

// ── Send a voice message ──────────────────────────────────────────────────────
export async function sendVoiceMessage(
  chatId: string,
  senderId: string,
  voiceUrl: string,
  durationMs: number,
): Promise<{ success: boolean; messageId: string }> {
  try {
    let mediaObjectKey = voiceUrl;
    if (/^file:|^content:|^\//.test(voiceUrl)) {
      const { mediaService, fileSize } = await import('../services/mediaService');
      mediaObjectKey = await mediaService.upload(voiceUrl, 'chat-voice', {
        chatId,
        sizeBytes: await fileSize(voiceUrl),
      });
    }
    const res = await endpoints.sendMessage(chatId, {
      type: 'voice',
      mediaObjectKey,
      durationMs,
      clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { success: res.ok, messageId: res.ok ? res.data.message.id : '' };
  } catch (err) {
    console.error('sendVoiceMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send an image message ─────────────────────────────────────────────────────
export async function sendImageMessage(
  chatId: string,
  senderId: string,
  imageUri: string,
  onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const { mediaService, fileSize } = await import('../services/mediaService');
    const objectKey = await mediaService.upload(imageUri, 'chat-media', {
      chatId,
      sizeBytes: await fileSize(imageUri),
    });
    const res = await endpoints.sendMessage(chatId, {
      type: 'image',
      mediaObjectKey: objectKey,
      clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { success: res.ok, messageId: res.ok ? res.data.message.id : '' };
  } catch (err) {
    console.error('sendImageMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a video message ──────────────────────────────────────────────────────
export async function sendVideoMessage(
  chatId: string,
  senderId: string,
  videoUri: string,
  thumbnailUri?: string,
  _onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const { mediaService, fileSize } = await import('../services/mediaService');

    // iOS photo library URIs (ph:// or assets-library://) cannot be read
    // directly by expo-file-system. Export to a local cache file first.
    let localUri = videoUri;
    if (videoUri.startsWith('ph://') || videoUri.startsWith('assets-library://')) {
      const { FileSystem } = await import('expo-file-system');
      const dest = `${FileSystem.cacheDirectory}video_${Date.now()}.mp4`;
      await FileSystem.copyAsync({ from: videoUri, to: dest });
      localUri = dest;
    }

    // Derive content type from the local URI extension; default to mp4.
    const ext = localUri.split('.').pop()?.toLowerCase() ?? 'mp4';
    const contentType =
      ext === 'mov' ? 'video/quicktime' :
      ext === 'avi' ? 'video/x-msvideo' :
      'video/mp4';

    const objectKey = await mediaService.upload(localUri, 'chat-media', {
      chatId,
      sizeBytes: await fileSize(localUri),
      contentType,
      ext,
    });

    let thumbKey: string | null = null;
    if (thumbnailUri) {
      thumbKey = await mediaService.upload(thumbnailUri, 'chat-media', {
        chatId,
        sizeBytes: await fileSize(thumbnailUri),
        contentType: 'image/jpeg',
        ext: 'jpg',
      });
    }

    const res = await endpoints.sendMessage(chatId, {
      type: 'video',
      mediaObjectKey: objectKey,
      thumbnailObjectKey: thumbKey,
      clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { success: res.ok, messageId: res.ok ? res.data.message.id : '' };
  } catch (err) {
    console.error('sendVideoMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a file message ───────────────────────────────────────────────────────
export async function sendFileMessage(
  chatId: string,
  senderId: string,
  fileUri: string,
  fileName: string,
  fileSize: number,
  mimeType: string,
  _onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const { mediaService } = await import('../services/mediaService');
    const objectKey = await mediaService.upload(fileUri, 'chat-media', {
      chatId,
      sizeBytes: fileSize,
      contentType: mimeType || 'application/octet-stream',
    });
    const res = await endpoints.sendMessage(chatId, {
      type: 'file',
      mediaObjectKey: objectKey,
      fileName, fileSize, mimeType,
      clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { success: res.ok, messageId: res.ok ? res.data.message.id : '' };
  } catch (err) {
    console.error('sendFileMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send number change notification to all chats ──────────────────────────────
export async function sendNumberChangeNotification(
  currentUserId: string,
  oldNumber: string,
  newNumber: string,
  displayName: string,
): Promise<{ success: boolean; count: number }> {
  try {
    const chatsRes = await endpoints.listChats();
    if (!chatsRes.ok) return { success: false, count: 0 };

    const messageText = `${displayName} changed their phone number from ${oldNumber} to ${newNumber}`;
    let count = 0;

    for (const chat of chatsRes.data.chats) {
      const res = await endpoints.sendMessage(chat.chatId, {
        type: 'system',
        text: messageText,
        subtype: 'number-change',
      }).catch(() => null);
      if (res?.ok) count++;
    }
    return { success: true, count };
  } catch (err) {
    console.error('[sendNumberChangeNotification] Error:', err);
    return { success: false, count: 0 };
  }
}

// ── Send a catalog product-card message ───────────────────────────────────────
export async function sendCatalogItemMessage(
  chatId:   string,
  senderId: string,
  item:     import('../types').CatalogItem,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const res = await endpoints.sendMessage(chatId, {
      type: 'catalog',
      catalogItem: {
        id: item.id, name: item.name, price: item.price,
        description: item.description ?? null, imageUri: item.imageUri ?? null,
      },
      clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    return { success: res.ok, messageId: res.ok ? res.data.message.id : '' };
  } catch (err) {
    console.error('[sendCatalogItemMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a broadcast message ──────────────────────────────────────────────────
export async function sendBroadcastMessage(
  senderId:    string,
  recipients:  string[],
  text:        string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ sent: number; failed: number }> {
  if (!text.trim() || recipients.length === 0) return { sent: 0, failed: 0 };

  const { chunkArray } = await import('../utils/phoneUtils');
  const chunks = chunkArray(recipients, 10);
  let sent = 0, failed = 0;

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (recipientUid) => {
        const chatId = await getOrCreateDirectChat(senderId, recipientUid);
        await sendMessage(chatId, senderId, text);
      }),
    );
    for (const r of results) r.status === 'fulfilled' ? sent++ : failed++;
    onProgress?.(sent + failed, recipients.length);
  }
  return { sent, failed };
}
