// ─── Notification Quick-Reply ─────────────────────────────────────────────────
// Inline reply from notification shade — sends via backend REST.

import { getAuth } from '@react-native-firebase/auth';
import { endpoints } from '../api/endpoints';

export const CHAT_CATEGORY_ID    = 'chat_message';
export const REPLY_ACTION_ID     = 'reply';
export const MARK_READ_ACTION_ID = 'mark_read';

let Notifications: any = null;
try {
  Notifications = require('expo-notifications');
} catch {
  // expo-notifications unavailable on web
}

export async function registerChatReplyCategory(): Promise<void> {
  if (!Notifications?.setNotificationCategoryAsync) return;
  try {
    await Notifications.setNotificationCategoryAsync(CHAT_CATEGORY_ID, [
      {
        identifier: REPLY_ACTION_ID,
        buttonTitle: 'Reply',
        textInput: { submitButtonTitle: 'Send', placeholder: 'Message' },
        options: { opensAppToForeground: false },
      },
      {
        identifier: MARK_READ_ACTION_ID,
        buttonTitle: 'Mark as read',
        options: { opensAppToForeground: false },
      },
    ]);
  } catch (err) {
    console.warn('[NotificationReply] Failed to register category:', err);
  }
}

async function writeReply(chatId: string, text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;

  const currentUser = getAuth().currentUser;
  if (!currentUser) {
    console.warn('[NotificationReply] No authenticated user — cannot send reply');
    return;
  }

  const res = await endpoints.sendMessage(chatId, { type: 'text', text: trimmed });
  if (!res.ok) throw new Error(res.error.message);
  console.log('[NotificationReply] Reply sent via backend to chat', chatId);
}

async function markChatRead(chatId: string): Promise<void> {
  // Unread counts are managed server-side via socket receipts.
  console.log('[NotificationReply] Chat mark-read skipped (handled by socket receipts)', chatId);
}

export async function handleNotificationReply(response: any): Promise<boolean> {
  try {
    const actionId = response?.actionIdentifier;
    const chatId   = response?.notification?.request?.content?.data?.chatId;
    if (!chatId) return false;

    if (actionId === REPLY_ACTION_ID) {
      await writeReply(chatId, response?.userText ?? '');
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
