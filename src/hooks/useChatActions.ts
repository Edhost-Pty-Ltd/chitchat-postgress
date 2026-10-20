// ─── useChatActions Hook ──────────────────────────────────────────────────────
// Creates new chats (1-on-1 and group) and handles sending messages via the
// backend REST API (endpoints) and object-store media uploads (mediaService).
// Media is stored as OBJECT KEYS, never URLs — the UI resolves keys to download
// URLs at render time through mediaService.getDownloadUrl.

import { endpoints } from '../api/endpoints';
import type { OrderPayload, ContactPayload } from '../api/endpoints';
import { mediaService, fileSize } from '../services/mediaService';
import { getFileExtension } from '../utils/fileUtils';
import { fetchUserPrivacySettings } from './usePrivacySettings';

// ── Create or get existing 1-on-1 chat ───────────────────────────────────────
// The backend createChat is idempotent for direct chats: it returns the
// existing chat between the two members if one already exists, otherwise
// creates it.
export async function getOrCreateDirectChat(
  currentUserId: string,
  otherUserId: string,
): Promise<string> {
  console.log('[getOrCreateDirectChat] createChat direct with:', otherUserId);
  const res = await endpoints.createChat({ type: 'direct', members: [otherUserId] });
  if (!res.ok) {
    throw new Error(`getOrCreateDirectChat failed: ${res.error.message}`);
  }
  console.log('[getOrCreateDirectChat] chatId:', res.data.chatId);
  return res.data.chatId;
}

// ── Create a new group chat ───────────────────────────────────────────────────
// Privacy filtering (groups === 'Nobody') is preserved client-side so the UI
// can still report which members were blocked by their own privacy settings.
export async function createGroupChat(
  currentUserId: string,
  memberIds: string[],
  groupName: string,
): Promise<{ chatId: string; blockedByPrivacy: string[] }> {
  const requested = Array.from(new Set(memberIds.filter((id) => id !== currentUserId)));
  const blockedByPrivacy: string[] = [];
  const allowed: string[] = [];

  await Promise.all(
    requested.map(async (id) => {
      const privacy = await fetchUserPrivacySettings(id);
      if (privacy.groups === 'Nobody') blockedByPrivacy.push(id);
      else allowed.push(id);
    }),
  );

  const res = await endpoints.createChat({
    type: 'group',
    members: allowed,
    groupName,
  });
  if (!res.ok) {
    throw new Error(`createGroupChat failed: ${res.error.message}`);
  }

  return { chatId: res.data.chatId, blockedByPrivacy };
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

    const res = await endpoints.sendMessage(chatId, { type: 'text', text: trimmed });
    return res.ok;
  } catch (err) {
    console.error('sendMessage error:', err);
    return false;
  }
}

// ── Mark chat as read ─────────────────────────────────────────────────────────
// Unread counters are maintained server-side; the read path runs through the
// socket 'message:read' channel (see useMessages.markAsRead). This no-op
// remains for callers that imported it; reads are now driven by the realtime
// layer rather than a direct unread-counter write.
export async function markChatAsRead(_chatId: string, _userId: string): Promise<void> {
  /* unread counters are server-maintained; see useMessages read path */
}

// ── Send a voice message ──────────────────────────────────────────────────────
// `voiceObjectKey` is the already-uploaded object key (callers upload the
// recording via mediaService before invoking this). For backwards compatibility
// with callers that still pass a local URI, we upload it here when it looks
// like a file URI.
export async function sendVoiceMessage(
  chatId: string,
  senderId: string,
  voiceUriOrKey: string,
  durationMs: number,
): Promise<{ success: boolean; messageId: string }> {
  try {
    let mediaObjectKey = voiceUriOrKey;
    if (/^(file:|content:|https?:|assets-library:|ph:)/i.test(voiceUriOrKey)) {
      const sizeBytes = await fileSize(voiceUriOrKey);
      mediaObjectKey = await mediaService.upload(voiceUriOrKey, 'chat-voice', {
        chatId,
        sizeBytes,
        ext: getFileExtension(voiceUriOrKey),
      });
    }

    const res = await endpoints.sendMessage(chatId, {
      type: 'voice',
      mediaObjectKey,
      durationMs,
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
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
    onProgress?.(0);
    const sizeBytes = await fileSize(imageUri);
    const mediaObjectKey = await mediaService.upload(imageUri, 'chat-media', {
      chatId,
      sizeBytes,
      ext: getFileExtension(imageUri),
    });
    onProgress?.(100);

    const trimmedCaption = caption?.trim() || null;

    const res = await endpoints.sendMessage(chatId, {
      type: 'image',
      text: trimmedCaption,
      mediaObjectKey,
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
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
    onProgress?.(0);
    const videoSize = await fileSize(videoUri);
    const mediaObjectKey = await mediaService.upload(videoUri, 'chat-media', {
      chatId,
      sizeBytes: videoSize,
      ext: getFileExtension(videoUri),
    });

    let thumbnailObjectKey: string | null = null;
    if (thumbnailUri) {
      const thumbSize = await fileSize(thumbnailUri);
      thumbnailObjectKey = await mediaService.upload(thumbnailUri, 'chat-media', {
        chatId,
        sizeBytes: thumbSize,
        ext: 'jpg',
      });
    }
    onProgress?.(100);

    const trimmedCaption = caption?.trim() || null;

    const res = await endpoints.sendMessage(chatId, {
      type: 'video',
      text: trimmedCaption,
      mediaObjectKey,
      thumbnailObjectKey,
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
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
  fileSizeBytes: number,
  mimeType: string,
  onProgress?: (progress: number) => void,
): Promise<{ success: boolean; messageId: string }> {
  try {
    onProgress?.(0);
    const mediaObjectKey = await mediaService.upload(fileUri, 'chat-media', {
      chatId,
      sizeBytes: fileSizeBytes || (await fileSize(fileUri)),
      contentType: mimeType,
      ext: getFileExtension(fileName || fileUri),
    });
    onProgress?.(100);

    const res = await endpoints.sendMessage(chatId, {
      type: 'file',
      mediaObjectKey,
      fileName,
      fileSize: fileSizeBytes,
      mimeType,
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
  } catch (err) {
    console.error('sendFileMessage error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send number change notification to all chats ──────────────────────────────
// Walks the user's chats (listChats) and posts a system message into each.
export async function sendNumberChangeNotification(
  currentUserId: string,
  oldNumber: string,
  newNumber: string,
  displayName: string,
): Promise<{ success: boolean; count: number }> {
  try {
    const chatsRes = await endpoints.listChats();
    if (!chatsRes.ok) return { success: false, count: 0 };

    const chats = chatsRes.data.chats;
    console.log(`[sendNumberChangeNotification] Found ${chats.length} chats`);
    const messageText = `${displayName} changed their phone number from ${oldNumber} to ${newNumber}`;

    let count = 0;
    for (const chat of chats) {
      const res = await endpoints.sendMessage(chat.chatId, {
        type: 'system',
        text: messageText,
        subtype: 'number-change',
      });
      if (res.ok) count++;
    }

    return { success: true, count };
  } catch (err) {
    console.error('[sendNumberChangeNotification] Error:', err);
    return { success: false, count: 0 };
  }
}

// ── Send a catalog product-card message ───────────────────────────────────────
// Writes a message of type 'catalog' with the full CatalogItem embedded so the
// receiver sees name/price/image without fetching the sender's profile. If the
// item image is a local URI it is uploaded first and the catalogItem carries an
// object key; otherwise the existing value is kept (may already be an object
// key stored in the catalog).
export async function sendCatalogItemMessage(
  chatId:    string,
  senderId:  string,
  item:      import('../types').CatalogItem,
): Promise<{ success: boolean; messageId: string }> {
  try {
    let imageObjectKey: string | null = item.imageUri ?? null;
    if (imageObjectKey && /^(file:|content:|https?:|assets-library:|ph:)/i.test(imageObjectKey)) {
      const sizeBytes = await fileSize(imageObjectKey);
      imageObjectKey = await mediaService.upload(imageObjectKey, 'chat-media', {
        chatId,
        sizeBytes,
        ext: getFileExtension(imageObjectKey),
      });
    }

    const res = await endpoints.sendMessage(chatId, {
      type: 'catalog',
      catalogItem: {
        id:          item.id,
        name:        item.name,
        price:       item.price,
        description: item.description ?? null,
        imageUri:    imageObjectKey,
      },
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
  } catch (err) {
    console.error('[sendCatalogItemMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Send a broadcast message to multiple recipients ───────────────────────────
// Each recipient receives the message as a normal private DM. Chunks run with
// Promise.allSettled so one blocked/unreachable contact never kills the whole
// send; chunks are processed sequentially.
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
        const ok = await sendMessage(chatId, senderId, text);
        if (!ok) throw new Error('send failed');
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
// Uploads each line-item image (when it's a local URI) via mediaService first,
// so the stored order carries object keys, then posts a type:'order' message.
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

    const orderItems: OrderPayload['items'] = await Promise.all(
      items.map(async (it) => {
        let imageObjectKey: string | null = it.imageUri ?? null;
        if (imageObjectKey && /^(file:|content:|https?:|assets-library:|ph:)/i.test(imageObjectKey)) {
          const sizeBytes = await fileSize(imageObjectKey);
          imageObjectKey = await mediaService.upload(imageObjectKey, 'chat-media', {
            chatId,
            sizeBytes,
            ext: getFileExtension(imageObjectKey),
          });
        }
        return {
          id: it.id,
          name: it.name,
          price: it.price,
          imageObjectKey,
          quantity: it.quantity,
        };
      }),
    );

    const res = await endpoints.sendMessage(chatId, {
      type: 'order',
      order: {
        items: orderItems,
        total: total ?? null,
        currency: currency ?? '',
      },
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
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

function toContactPayloadEntry(c: SharedContact): NonNullable<ContactPayload['contacts']>[number] {
  return {
    name: c.name,
    phone: c.phone,
    userId: c.userId ?? null,
    registered: !!c.registered,
    // photoURL from the sender may be a remote URL or object key; store as-is as
    // the contact's photo object key so render resolves it best-effort.
    photoObjectKey: c.photoURL ?? null,
  };
}

export async function sendContactMessage(
  chatId: string,
  senderId: string,
  contact: SharedContact,
): Promise<{ success: boolean; messageId: string }> {
  try {
    const payload: ContactPayload = toContactPayloadEntry(contact);

    const res = await endpoints.sendMessage(chatId, {
      type: 'contact',
      contact: payload,
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
  } catch (err) {
    console.error('[sendContactMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// Share MULTIPLE contacts in a single message. The bubble shows a compact
// "N contacts" card. The first contact is mirrored into the top-level `contact`
// fields so previews/fallbacks still work.
export async function sendContactsMessage(
  chatId: string,
  senderId: string,
  contacts: SharedContact[],
): Promise<{ success: boolean; messageId: string }> {
  try {
    if (contacts.length === 0) return { success: false, messageId: '' };
    if (contacts.length === 1) return sendContactMessage(chatId, senderId, contacts[0]);

    const normalized = contacts.map(toContactPayloadEntry);
    const first = normalized[0];

    const payload: ContactPayload = { ...first, contacts: normalized };

    const res = await endpoints.sendMessage(chatId, {
      type: 'contact',
      contact: payload,
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
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

    const optionObjs = options.map((text, i) => ({ id: `opt${i}`, text }));

    const res = await endpoints.sendMessage(chatId, {
      type: 'poll',
      poll: {
        question,
        options: optionObjs,
        multiple: !!draft.multiple,
      },
    });
    if (!res.ok) return { success: false, messageId: '' };
    return { success: true, messageId: res.data.message.id };
  } catch (err) {
    console.error('[sendPollMessage] error:', err);
    return { success: false, messageId: '' };
  }
}

// ── Cast / change a vote on a poll ────────────────────────────────────────────
// The backend performs the atomic read-modify-write (toggle for the voter,
// single-choice exclusivity) server-side, so the client just posts the chosen
// option id.
export async function votePollOption(
  chatId: string,
  messageId: string,
  voterUid: string,
  optionId: string,
): Promise<boolean> {
  try {
    const res = await endpoints.votePoll(chatId, messageId, optionId);
    return res.ok;
  } catch (err) {
    console.error('[votePollOption] error:', err);
    return false;
  }
}
