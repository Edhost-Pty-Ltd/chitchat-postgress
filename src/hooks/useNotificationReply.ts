// ─── Notification Quick-Reply ─────────────────────────────────────────────────
// Registers a notification category with an inline text-input "Reply" action
// so the user can respond to a chat message straight from the notification
// shade (lock screen / banner) without opening the app, exactly like WhatsApp.
//
// Flow:
//   1. registerChatReplyCategory() is called once on app start.
//   2. The push payload (sent by the onMessageCreated Cloud Function) carries
//      categoryId: 'chat_message' plus data { chatId, senderId }.
//   3. The OS shows a "Reply" button with a text field.
//   4. When the user submits, expo-notifications wakes the app (in the
//      background) and fires addNotificationResponseReceivedListener with
//      response.actionIdentifier === 'reply' and response.userText === typed text.
//   5. handleNotificationReply() writes that text to Firestore directly.

import firestore from '@react-native-firebase/firestore';
import { getAuth } from '@react-native-firebase/auth';
import { db } from '../config/firebase';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';

export const CHAT_CATEGORY_ID = 'chat_message';
export const REPLY_ACTION_ID  = 'reply';
export const MARK_READ_ACTION_ID = 'mark_read';

let Notifications: any = null;
try {
  Notifications = require('expo-notifications');
} catch {
  // expo-notifications unavailable (e.g. web) — quick reply simply won't register
}

// ── Register the category (idempotent) ────────────────────────────────────────
export async function registerChatReplyCategory(): Promise<void> {
  if (!Notifications?.setNotificationCategoryAsync) return;
  try {
    await Notifications.setNotificationCategoryAsync(CHAT_CATEGORY_ID, [
      {
        identifier: REPLY_ACTION_ID,
        buttonTitle: 'Reply',
        textInput: {
          submitButtonTitle: 'Send',
          placeholder: 'Message',
        },
        options: {
          // Keep the app in the background — don't bring it to the foreground.
          opensAppToForeground: false,
        },
      },
      {
        identifier: MARK_READ_ACTION_ID,
        buttonTitle: 'Mark as read',
        options: {
          opensAppToForeground: false,
        },
      },
    ]);
    console.log('[NotificationReply] Chat reply category registered');
  } catch (err) {
    console.warn('[NotificationReply] Failed to register category:', err);
  }
}

// ── Write a reply straight to the backend or Firestore ───────────────────────
// Self-contained so it works even when the app was woken only to process the
// notification action (no React context available).
async function writeReply(chatId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const currentUser = getAuth().currentUser;
  if (!currentUser) {
    console.warn('[NotificationReply] No authenticated user — cannot send reply');
    return;
  }

  // ── Backend path ──────────────────────────────────────────────────────────
  if (useBackend('messaging')) {
    const res = await endpoints.sendMessage(chatId, { type: 'text', text: trimmed });
    if (!res.ok) {
      console.error('[NotificationReply] Backend sendMessage failed:', res.error.message);
      throw new Error(res.error.message);
    }
    console.log('[NotificationReply] Reply sent via backend to chat', chatId);
    return;
  }

  // ── Firestore fallback ────────────────────────────────────────────────────
  const senderId = currentUser.uid;
  const fsDb = db as ReturnType<typeof firestore>;

  const chatRef  = fsDb.collection('chats').doc(chatId);
  const chatSnap = await chatRef.get();
  if (!chatSnap.exists) return;

  const members: string[] = chatSnap.data()!.members ?? [];
  const otherMembers      = members.filter((id) => id !== senderId);
  const expiresAt         = new Date(Date.now() + 72 * 60 * 60 * 1000);
  const batch             = fsDb.batch();

  const msgRef = chatRef.collection('messages').doc();
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
    sentFrom:    'notification',
  });

  const unreadUpdates = Object.fromEntries(
    otherMembers.map((id) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)]),
  );
  batch.update(chatRef, {
    'lastMessage.text':      trimmed,
    'lastMessage.senderId':  senderId,
    'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
    ...unreadUpdates,
  });

  await batch.commit();
  console.log('[NotificationReply] Reply sent via Firestore to chat', chatId);
}

// ── Mark a chat as read from the notification ─────────────────────────────────
async function markChatRead(chatId: string): Promise<void> {
  const currentUser = getAuth().currentUser;
  if (!currentUser) return;

  // ── Backend path ──────────────────────────────────────────────────────────
  if (useBackend('messaging')) {
    // The backend tracks read state via message receipts on the socket; there
    // is no standalone "mark read" REST endpoint. Emit a read receipt via the
    // REST delete-unread path if one lands, or simply do nothing — the chat
    // list will refresh on the next message:read socket event. For now just
    // log so we can trace it.
    console.log('[NotificationReply] Chat mark-read skipped on backend path (handled by socket receipts)', chatId);
    return;
  }

  // ── Firestore fallback ────────────────────────────────────────────────────
  const fsDb = db as ReturnType<typeof firestore>;
  await fsDb.collection('chats').doc(chatId).update({
    [`unreadCounts.${currentUser.uid}`]: 0,
  });
  console.log('[NotificationReply] Chat marked read via Firestore', chatId);
}

// ── Entry point called from the response listener ─────────────────────────────
// Returns true if this response was a quick-reply/mark-read action we handled,
// so the normal "open the chat" navigation can be skipped.
export async function handleNotificationReply(response: any): Promise<boolean> {
  try {
    const actionId = response?.actionIdentifier;
    const data     = response?.notification?.request?.content?.data ?? {};
    const chatId   = data?.chatId;

    if (!chatId) return false;

    if (actionId === REPLY_ACTION_ID) {
      const userText = response?.userText ?? '';
      await writeReply(chatId, userText);
      return true;
    }

    if (actionId === MARK_READ_ACTION_ID) {
      await markChatRead(chatId);
      return true;
    }

    return false;
  } catch (err) {
    console.error('[NotificationReply] Failed to handle reply:', err);
    return false;
  }
}
