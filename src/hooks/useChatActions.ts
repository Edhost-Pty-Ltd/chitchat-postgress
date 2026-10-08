// ─── useChatActions Hook ──────────────────────────────────────────────────────
// Creates new chats (1-on-1 and group) and handles sending messages.

import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { uploadFile, generateFileName, getFileExtension } from '../config/storage';
import { fetchUserPrivacySettings } from './usePrivacySettings';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';

const fsDb = () => db as ReturnType<typeof firestore>;

// ── Create or get existing 1-on-1 chat ───────────────────────────────────────
export async function getOrCreateDirectChat(
  currentUserId: string,
  otherUserId: string,
): Promise<string> {
  if (useBackend('messaging')) {
    const res = await endpoints.createChat({ type: 'direct', members: [otherUserId] });
    if (!res.ok) throw new Error(`createChat failed: ${res.error.message}`);
    return res.data.chatId;
  }

  const sortedIds = [currentUserId, otherUserId].sort();
  console.log('[getOrCreateDirectChat] Looking for chat between:', sortedIds);

  const snap = await fsDb()
    .collection('chats')
    .where('type', '==', 'direct')
    .where('members', '==', sortedIds)
    .get();

  if (snap.docs.length > 0) {
    console.log('[getOrCreateDirectChat] Found existing chat:', snap.docs[0].id);
    return snap.docs[0].id;
  }

  console.log('[getOrCreateDirectChat] Creating new chat');
  const newChat = await fsDb().collection('chats').add({
    type:        'direct',
    members:     sortedIds,
    groupName:   null,
    groupPhoto:  null,
    createdBy:   currentUserId,
    createdAt:   firestore.FieldValue.serverTimestamp(),
    lastMessage: null,
    unreadCounts: {
      [currentUserId]: 0,
      [otherUserId]:   0,
    },
  });

  console.log('[getOrCreateDirectChat] Created new chat:', newChat.id);
  return newChat.id;
}

// ── Create a new group chat ───────────────────────────────────────────────────
export async function createGroupChat(
  currentUserId: string,
  memberIds: string[],
  groupName: string,
): Promise<{ chatId: string; blockedByPrivacy: string[] }> {
  if (useBackend('messaging')) {
    // Server enforces group-privacy and membership; return no privacy-blocked
    // list here (the server simply includes permitted members).
    const res = await endpoints.createChat({
      type: 'group',
      members: memberIds,
      groupName,
    });
    if (!res.ok) throw new Error(`createGroupChat failed: ${res.error.message}`);
    return { chatId: res.data.chatId, blockedByPrivacy: [] };
  }

  const requested = Array.from(new Set([currentUserId, ...memberIds]));
  const blockedByPrivacy: string[] = [];
  const allowed: string[] = [currentUserId];

  await Promise.all(
    requested
      .filter((id) => id !== currentUserId)
      .map(async (id) => {
        const privacy = await fetchUserPrivacySettings(id);
        if (privacy.groups === 'Nobody') blockedByPrivacy.push(id);
        else allowed.push(id);
      }),
  );

  const unreadCounts = Object.fromEntries(allowed.map((id) => [id, 0]));

  const newChat = await fsDb().collection('chats').add({
    type:         'group',
    members:      allowed,
    groupName,
    groupPhoto:   null,
    createdBy:    currentUserId,
    createdAt:    firestore.FieldValue.serverTimestamp(),
    lastMessage:  null,
    unreadCounts,
  });

  return { chatId: newChat.id, blockedByPrivacy };
}

// ── Send a text message ───────────────────────────────────────────────────────
export async function sendMessage(
  chatId: string,
  senderId: string,
  text: string,
): Promise<boolean> {
  try {
    const trimmed = text.trim();
    if (!trimmed) return false;

    if (useBackend('messaging')) {
      const res = await endpoints.sendMessage(chatId, {
        type: 'text',
        text: trimmed,
        clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      return res.ok;
    }

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return false;

    const members: string[]    = chatSnap.data()!.members ?? [];
    const otherMembers         = members.filter((id) => id !== senderId);
    const expiresAt            = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch                = fsDb().batch();

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId:   msgRef.id,
      senderId,
      text:        trimmed,
      imageUrl:    null,
      voiceUrl:    null,
      type:        'text',
      timestamp:   firestore.FieldValue.serverTimestamp(),
      expiresAt,
      readBy:      [senderId],
      deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      trimmed,
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return true;
  } catch (err) {
    console.error('sendMessage error:', err);
    return false;
  }
}

// ── Mark chat as read ─────────────────────────────────────────────────────────
export async function markChatAsRead(chatId: string, userId: string): Promise<void> {
  try {
    if (useBackend('messaging')) {
      // Reading messages (via useMessages) sends the read ack over the socket,
      // which clears the unread count server-side. Nothing to do here.
      return;
    }
    await fsDb().collection('chats').doc(chatId).update({
      [`unreadCounts.${userId}`]: 0,
    });
  } catch (_) {}
}

// ── Send a voice message ──────────────────────────────────────────────────────
export async function sendVoiceMessage(
  chatId: string,
  senderId: string,
  voiceUrl: string,
  durationMs: number,
): Promise<{ success: boolean; messageId: string }> {
  try {
    if (useBackend('messaging')) {
      // `voiceUrl` is a local URI (the recorder output); upload it, then send.
      let mediaObjectKey = voiceUrl;
      if (useBackend('media') && /^file:|^content:|^\//.test(voiceUrl)) {
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
    }

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId:   msgRef.id,
      senderId,
      text:        null,
      imageUrl:    null,
      voiceUrl,
      type:        'voice',
      duration:    durationMs,
      timestamp:   firestore.FieldValue.serverTimestamp(),
      expiresAt,
      readBy:      [senderId],
      deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      '[Voice Note]',
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
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
    if (useBackend('messaging')) {
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
    }

    const fileName = generateFileName(getFileExtension(imageUri));
    const imageUrl = await uploadFile(imageUri, 'chatMedia', { chatId, fileName }, onProgress);

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId,
      text: null, type: 'image', imageUrl,
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      '📷 Photo',
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
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
  onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    if (useBackend('messaging')) {
      const { mediaService, fileSize } = await import('../services/mediaService');
      const objectKey = await mediaService.upload(videoUri, 'chat-media', {
        chatId,
        sizeBytes: await fileSize(videoUri),
      });
      let thumbKey: string | null = null;
      if (thumbnailUri) {
        thumbKey = await mediaService.upload(thumbnailUri, 'chat-media', {
          chatId,
          sizeBytes: await fileSize(thumbnailUri),
        });
      }
      const res = await endpoints.sendMessage(chatId, {
        type: 'video',
        mediaObjectKey: objectKey,
        thumbnailObjectKey: thumbKey,
        clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      return { success: res.ok, messageId: res.ok ? res.data.message.id : '' };
    }

    const videoUrl = await uploadFile(videoUri, 'chatMedia', {
      chatId, fileName: generateFileName(getFileExtension(videoUri)),
    }, onProgress);

    let thumbnailUrl: string | undefined;
    if (thumbnailUri) {
      thumbnailUrl = await uploadFile(thumbnailUri, 'chatMedia', {
        chatId, fileName: generateFileName('jpg'),
      });
    }

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId,
      text: null, type: 'video', videoUrl, thumbnailUrl,
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      '🎥 Video',
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
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
  onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    if (useBackend('messaging')) {
      const { mediaService } = await import('../services/mediaService');
      const objectKey = await mediaService.upload(fileUri, 'chat-media', {
        chatId,
        sizeBytes: fileSize,
        contentType: mimeType || 'application/octet-stream',
      });
      const res = await endpoints.sendMessage(chatId, {
        type: 'file',
        mediaObjectKey: objectKey,
        fileName,
        fileSize,
        mimeType,
        clientId: `${senderId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      return { success: res.ok, messageId: res.ok ? res.data.message.id : '' };
    }

    // Pass the caller-supplied mimeType as an override so Android content URIs
    // (which have no file extension) get the correct Content-Type rather than
    // falling back to application/octet-stream which Firebase Storage may reject.
    const fileUrl = await uploadFile(
      fileUri,
      'chatMedia',
      { chatId, fileName },
      onProgress,
      mimeType || 'application/octet-stream',
    );

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId,
      text: null, type: 'file', fileUrl, fileName, fileSize, mimeType,
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      `📎 ${fileName}`,
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
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
    const chatsSnap = await fsDb()
      .collection('chats')
      .where('members', 'array-contains', currentUserId)
      .get();

    console.log(`[sendNumberChangeNotification] Found ${chatsSnap.docs.length} chats`);
    const messageText = `${displayName} changed their phone number from ${oldNumber} to ${newNumber}`;

    for (const chatDoc of chatsSnap.docs) {
      const chatId       = chatDoc.id;
      const members: string[] = chatDoc.data().members ?? [];
      const otherMembers = members.filter((id) => id !== currentUserId);
      const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
      const batch        = fsDb().batch();

      const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
      batch.set(msgRef, {
        messageId: msgRef.id, senderId: currentUserId,
        text: messageText, type: 'system', subtype: 'number-change',
        oldNumber, newNumber,
        timestamp: firestore.FieldValue.serverTimestamp(),
        expiresAt, readBy: [currentUserId],
      });

      const unreadUpdates = Object.fromEntries(
        otherMembers.map((id) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
      );
      batch.update(fsDb().collection('chats').doc(chatId), {
        'lastMessage.text':      messageText,
        'lastMessage.senderId':  currentUserId,
        'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
        ...unreadUpdates,
      });

      await batch.commit();
    }

    return { success: true, count: chatsSnap.docs.length };
  } catch (err) {
    console.error('[sendNumberChangeNotification] Error:', err);
    return { success: false, count: 0 };
  }
}

// ── Send a catalog product-card message ───────────────────────────────────────
// Writes a message of type 'catalog' into the chat thread. The full CatalogItem
// is embedded in the message document so the receiver sees name/price/image
// without needing to fetch the sender's profile.
export async function sendCatalogItemMessage(
  chatId:    string,
  senderId:  string,
  item:      import('../types').CatalogItem,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId:   msgRef.id,
      senderId,
      text:        null,
      type:        'catalog',
      catalogItem: {
        id:          item.id,
        name:        item.name,
        price:       item.price,
        description: item.description ?? null,
        imageUri:    item.imageUri ?? null,
      },
      timestamp:   firestore.FieldValue.serverTimestamp(),
      expiresAt,
      readBy:      [senderId],
      deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      `🛍️ ${item.name}`,
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('[sendCatalogItemMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a broadcast message to multiple recipients ───────────────────────────
// Each recipient receives the message as a normal private DM — they have no
// visibility into who else received it (same as WhatsApp Broadcast).
//
// Strategy:
//   • Chunk recipients into groups of 10 and process each chunk with
//     Promise.allSettled so one blocked/unreachable contact never kills
//     the whole send.
//   • Chunks run sequentially to respect Firestore write-rate limits.
//   • Returns { sent, failed } so the caller can show "Sent to 11/12 contacts".
export async function sendBroadcastMessage(
  senderId:    string,
  recipients:  string[],
  text:        string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ sent: number; failed: number }> {
  if (!text.trim() || recipients.length === 0) return { sent: 0, failed: 0 };

  const { chunkArray } = await import('../utils/phoneUtils');
  const chunks = chunkArray(recipients, 10);
  let sent = 0;
  let failed = 0;

  for (const chunk of chunks) {
    const results = await Promise.allSettled(
      chunk.map(async (recipientUid) => {
        const chatId = await getOrCreateDirectChat(senderId, recipientUid);
        await sendMessage(chatId, senderId, text);
      }),
    );

    for (const result of results) {
      result.status === 'fulfilled' ? sent++ : failed++;
    }

    onProgress?.(sent + failed, recipients.length);
  }

  return { sent, failed };
}
