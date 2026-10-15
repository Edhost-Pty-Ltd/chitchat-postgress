// ─── useChatActions Hook ──────────────────────────────────────────────────────
// Creates new chats (1-on-1 and group) and handles sending messages.

import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { uploadFile, generateFileName, getFileExtension } from '../config/storage';
import { fetchUserPrivacySettings } from './usePrivacySettings';

const fsDb = () => db as ReturnType<typeof firestore>;

// ── Create or get existing 1-on-1 chat ───────────────────────────────────────
export async function getOrCreateDirectChat(
  currentUserId: string,
  otherUserId: string,
): Promise<string> {
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
  caption?: string | null,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const fileName = generateFileName(getFileExtension(imageUri));
    const imageUrl = await uploadFile(imageUri, 'chatMedia', { chatId, fileName }, onProgress);

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const trimmedCaption = caption?.trim() || null;

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId,
      text: trimmedCaption, type: 'image', imageUrl,
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      trimmedCaption ? `📷 ${trimmedCaption}` : '📷 Photo',
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
  caption?: string | null,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const videoUrl = await uploadFile(videoUri, 'chatMedia', {
      chatId, fileName: generateFileName(getFileExtension(videoUri)),
    }, onProgress);

    let thumbnailUrl: string | null = null;
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

    const trimmedCaption = caption?.trim() || null;

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId,
      text: trimmedCaption, type: 'video', videoUrl, thumbnailUrl,
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      trimmedCaption ? `🎥 ${trimmedCaption}` : '🎥 Video',
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
    const fileUrl = await uploadFile(fileUri, 'chatMedia', { chatId, fileName }, onProgress);

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

// ── Send an order (cart checkout) message ─────────────────────────────────────
// Stores the full line items (with product image URLs) so the recipient sees a
// premium order card, not a plain-text summary.
export interface OrderLineItem {
  id: string;
  name: string;
  price: string;
  imageUri: string | null;
  quantity: number;
}
export async function sendOrderMessage(
  chatId: string,
  senderId: string,
  items: OrderLineItem[],
  total: string | null,
  currency: string,
): Promise<{ success: boolean; messageId: string }> {
  try {
    if (items.length === 0) return { success: false, messageId: '' };

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const totalQty = items.reduce((sum, it) => sum + it.quantity, 0);

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId,
      text: null, type: 'order',
      order: {
        items: items.map((it) => ({
          id: it.id, name: it.name, price: it.price,
          imageUri: it.imageUri ?? null, quantity: it.quantity,
        })),
        total: total ?? null,
        currency: currency ?? '',
      },
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      `🛒 Order · ${totalQty} item${totalQty === 1 ? '' : 's'}`,
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('[sendOrderMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a shared contact card ────────────────────────────────────────────────
// The stored `name` is whatever the SENDER saved for this contact, so it shows
// the same way to whoever receives it.
export interface SharedContact {
  name: string;
  phone: string;
  userId: string | null;
  registered: boolean;
  photoURL: string | null;
}
export async function sendContactMessage(
  chatId: string,
  senderId: string,
  contact: SharedContact,
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
      messageId: msgRef.id, senderId,
      text: null, type: 'contact',
      contact: {
        name: contact.name,
        phone: contact.phone,
        userId: contact.userId ?? null,
        registered: !!contact.registered,
        photoURL: contact.photoURL ?? null,
      },
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      `👤 ${contact.name}`,
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('[sendContactMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// Share MULTIPLE contacts in a single message. The bubble shows a compact
// "N contacts" card with a "View all" sheet. The first contact is also mirrored
// into the top-level `contact` fields so older previews/fallbacks still work.
export async function sendContactsMessage(
  chatId: string,
  senderId: string,
  contacts: SharedContact[],
): Promise<{ success: boolean; messageId: string }> {
  try {
    if (contacts.length === 0) return { success: false, messageId: '' };
    if (contacts.length === 1) return sendContactMessage(chatId, senderId, contacts[0]);

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const normalized = contacts.map((c) => ({
      name: c.name,
      phone: c.phone,
      userId: c.userId ?? null,
      registered: !!c.registered,
      photoURL: c.photoURL ?? null,
    }));
    const first = normalized[0];

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId,
      text: null, type: 'contact',
      contact: { ...first, contacts: normalized },
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      `👤 ${first.name} and ${normalized.length - 1} other${normalized.length - 1 === 1 ? '' : 's'}`,
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('[sendContactsMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a poll ───────────────────────────────────────────────────────────────
export interface PollDraft {
  question: string;
  options: string[];       // non-empty option texts
  multiple: boolean;       // allow multiple selections
}
export async function sendPollMessage(
  chatId: string,
  senderId: string,
  draft: PollDraft,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const question = draft.question.trim();
    const options  = draft.options.map((o) => o.trim()).filter(Boolean);
    if (!question || options.length < 2) return { success: false, messageId: '' };

    const chatRef  = fsDb().collection('chats').doc(chatId);
    const chatSnap = await chatRef.get();
    if (!chatSnap.exists) return { success: false, messageId: '' };

    const members      = chatSnap.data()!.members ?? [];
    const otherMembers = members.filter((id: string) => id !== senderId);
    const expiresAt    = new Date(Date.now() + 72 * 60 * 60 * 1000);
    const batch        = fsDb().batch();

    const optionObjs = options.map((text, i) => ({ id: `opt${i}`, text }));
    const votes: Record<string, string[]> = {};
    optionObjs.forEach((o) => { votes[o.id] = []; });

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId,
      text: null, type: 'poll',
      poll: { question, options: optionObjs, votes, multiple: !!draft.multiple },
      timestamp: firestore.FieldValue.serverTimestamp(),
      expiresAt, readBy: [senderId], deliveredTo: [],
    });

    const unreadUpdates = Object.fromEntries(
      otherMembers.map((id: string) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
    );
    batch.update(chatRef, {
      'lastMessage.text':      `📊 ${question}`,
      'lastMessage.senderId':  senderId,
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      ...unreadUpdates,
    });

    await batch.commit();
    return { success: true, messageId: msgRef.id };
  } catch (err) {
    console.error('[sendPollMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Cast / change a vote on a poll ────────────────────────────────────────────
// Reads the current poll, toggles the voter on the chosen option, and (for
// single-choice polls) removes them from all other options, then writes back.
export async function votePollOption(
  chatId: string,
  messageId: string,
  voterUid: string,
  optionId: string,
): Promise<boolean> {
  try {
    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc(messageId);

    // Run the read-modify-write inside a transaction so concurrent votes from
    // different users merge atomically against the latest server state. Without
    // this, two people voting around the same time each write the whole
    // `poll.votes` map and the second write clobbers the first — which is why a
    // receiver's vote used to cancel the sender's vote.
    await fsDb().runTransaction(async (tx) => {
      const snap = await tx.get(msgRef);
      if (!snap.exists) return;
      const poll = snap.data()!.poll;
      if (!poll) return;

      const votes: Record<string, string[]> = {};
      for (const id of Object.keys(poll.votes ?? {})) {
        votes[id] = Array.isArray(poll.votes[id]) ? [...poll.votes[id]] : [];
      }
      // Ensure every option key exists so the written map is complete.
      for (const o of poll.options ?? []) {
        if (!votes[o.id]) votes[o.id] = [];
      }

      const already = votes[optionId]?.includes(voterUid);

      if (!poll.multiple) {
        // Single-choice: clear this voter from every option first, then set the
        // new one. Tapping a different option switches the vote in one write.
        for (const id of Object.keys(votes)) {
          votes[id] = votes[id].filter((u) => u !== voterUid);
        }
        // In single-choice mode, tapping the already-selected option retracts it;
        // tapping any other option selects it (we already cleared the old one).
        if (!already) votes[optionId] = [...(votes[optionId] ?? []), voterUid];
      } else {
        // Multiple-choice: plain toggle on just this option.
        if (already) {
          votes[optionId] = (votes[optionId] ?? []).filter((u) => u !== voterUid);
        } else {
          votes[optionId] = [...(votes[optionId] ?? []), voterUid];
        }
      }

      tx.update(msgRef, { 'poll.votes': votes });
    });
    return true;
  } catch (err) {
    console.error('[votePollOption] error:', err);
    return false;
  }
}
