// ─── Cloud Functions ─────────────────────────────────────────────────────────
// Server-side maintenance and cleanup for the business chat app.

import * as functionsV1 from 'firebase-functions/v1';
import { initializeApp, getApps } from 'firebase-admin/app';

// Initialize the Admin SDK once
if (getApps().length === 0) {
  initializeApp();
}


// ─── Scheduled Cleanup Functions ───────────────────────────────────────────
// Reliable server-side maintenance jobs (1st gen, on a Cloud Scheduler cron).
// The client performs best-effort cleanup too, but these guarantee that
// expired/stale data is removed even when no client is running.

import { getFirestore, Timestamp as AdminTimestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';

const FIRESTORE_BATCH_LIMIT = 500;

/** Delete a list of document refs in chunks that respect the 500-write batch limit. */
async function deleteRefsInBatches(
  refs: FirebaseFirestore.DocumentReference[],
): Promise<number> {
  const dbAdmin = getFirestore();
  let deleted = 0;
  for (let i = 0; i < refs.length; i += FIRESTORE_BATCH_LIMIT) {
    const slice = refs.slice(i, i + FIRESTORE_BATCH_LIMIT);
    const batch = dbAdmin.batch();
    slice.forEach((ref) => batch.delete(ref));
    await batch.commit();
    deleted += slice.length;
  }
  return deleted;
}

/** Extract the Storage object path from a Firebase download URL (…/o/<path>?…). */
function storagePathFromUrl(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/o\/([^?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Best-effort deletion of one or more Storage objects by their download URLs. */
async function deleteStorageByUrls(urls: Array<string | null | undefined>): Promise<void> {
  const bucket = getStorage().bucket();
  await Promise.all(
    urls.map(async (url) => {
      const path = storagePathFromUrl(url);
      if (!path) return;
      try {
        await bucket.file(path).delete();
      } catch (err: any) {
        // 404 (already gone) and similar are non-fatal
        if (err?.code !== 404) {
          console.warn('[cleanup] Failed to delete storage object:', path, err?.message);
        }
      }
    }),
  );
}

// ─── 1. Expired statuses (24h) ──────────────────────────────────────────────
// Removes status docs past their expiresAt and the associated Storage media.
export const cleanupExpiredStatuses = functionsV1.pubsub
  .schedule('every 60 minutes')
  .onRun(async () => {
    const dbAdmin = getFirestore();
    const now = AdminTimestamp.now();

    const snap = await dbAdmin
      .collection('statuses')
      .where('expiresAt', '<=', now)
      .limit(1000)
      .get();

    if (snap.empty) {
      console.log('[cleanupExpiredStatuses] Nothing to clean.');
      return null;
    }

    // Delete media first (best-effort), then the docs.
    await deleteStorageByUrls(snap.docs.map((d) => d.data().mediaUrl));
    const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));

    console.log(`[cleanupExpiredStatuses] Deleted ${deleted} expired status(es).`);
    return null;
  });

// ─── 2. Expired messages (72h TTL) ──────────────────────────────────────────
// Deletes messages past their expiresAt across every chat, plus their media.
// Uses a collectionGroup query so it spans all chats/{chatId}/messages.
export const cleanupExpiredMessages = functionsV1.pubsub
  .schedule('every 24 hours')
  .onRun(async () => {
    const dbAdmin = getFirestore();
    const now = AdminTimestamp.now();

    const snap = await dbAdmin
      .collectionGroup('messages')
      .where('expiresAt', '<=', now)
      .limit(2000)
      .get();

    if (snap.empty) {
      console.log('[cleanupExpiredMessages] Nothing to clean.');
      return null;
    }

    // Remove any attached Storage media for these messages.
    const mediaUrls: Array<string | null | undefined> = [];
    snap.docs.forEach((d) => {
      const m = d.data();
      mediaUrls.push(m.imageUrl, m.voiceUrl, m.videoUrl, m.fileUrl, m.thumbnailUrl);
    });
    await deleteStorageByUrls(mediaUrls);

    const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));
    console.log(`[cleanupExpiredMessages] Deleted ${deleted} expired message(s).`);
    return null;
  });

// ─── 3. Stale / ghost calls ─────────────────────────────────────────────────
// Removes 1-on-1 call signaling docs that are old and no longer needed.
export const cleanupStaleCalls = functionsV1.pubsub
  .schedule('every 30 minutes')
  .onRun(async () => {
    const dbAdmin = getFirestore();
    const now = Date.now();
    const cutoff3h = AdminTimestamp.fromMillis(now - 3 * 60 * 60 * 1000);

    const toDelete: FirebaseFirestore.DocumentReference[] = [];

    // 1-on-1 calls untouched for 3h (terminal, abandoned, or long-ended).
    const staleCalls = await dbAdmin
      .collection('calls')
      .where('updatedAt', '<=', cutoff3h)
      .limit(1000)
      .get();
    staleCalls.forEach((d) => toDelete.push(d.ref));

    if (toDelete.length === 0) {
      console.log('[cleanupStaleCalls] Nothing to clean.');
      return null;
    }

    const deleted = await deleteRefsInBatches(toDelete);
    console.log(`[cleanupStaleCalls] Deleted ${deleted} stale call doc(s).`);
    return null;
  });

// ─── 4. Push notifications for new chat messages ────────────────────────────
// Fires whenever a message is created in any chat. Sends an Expo push to every
// other member of the chat, carrying the data + categoryId the client needs to
// show the inline "Reply" field in the notification shade.
//
// The Expo push payload uses:
//   • categoryId: 'chat_message'      → triggers the Reply / Mark-as-read actions
//   • data: { chatId, senderId }      → consumed by handleNotificationReply()
//   • _displayInForeground: false     → OS shows it; the app's own in-app toast
//                                        handles the foregrounded case
//
// Expo Push API: https://exp.host/--/api/v2/push/send

const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** Resolve the display name to show as the notification title. */
async function resolveSenderName(
  dbAdmin: FirebaseFirestore.Firestore,
  senderId: string,
): Promise<string> {
  try {
    const snap = await dbAdmin.collection('users').doc(senderId).get();
    const data = snap.data();
    return data?.displayName || data?.phone || 'New message';
  } catch {
    return 'New message';
  }
}

/** Build the notification body from a message document. */
function messageBody(msg: FirebaseFirestore.DocumentData): string {
  if (msg.text) return msg.text as string;
  switch (msg.type) {
    case 'image':   return '📷 Photo';
    case 'video':   return '🎥 Video';
    case 'voice':   return '🎤 Voice message';
    case 'file':    return `📎 ${msg.fileName || 'File'}`;
    case 'catalog': return '🛍️ Product';
    default:        return 'New message';
  }
}

export const onMessageCreated = functionsV1.firestore
  .document('chats/{chatId}/messages/{messageId}')
  .onCreate(async (snap, context) => {
    const msg    = snap.data();
    const chatId = context.params.chatId as string;
    if (!msg) return null;

    const senderId: string = msg.senderId;
    if (!senderId) return null;

    // Messages flagged as blocked are hidden from the recipient — don't notify.
    if (msg.blockedMessage) return null;

    const dbAdmin = getFirestore();

    // Load the chat to find the other members + group metadata.
    const chatSnap = await dbAdmin.collection('chats').doc(chatId).get();
    if (!chatSnap.exists) return null;
    const chatData   = chatSnap.data()!;
    const members: string[] = chatData.members ?? [];
    const recipients = members.filter((id) => id !== senderId);
    if (recipients.length === 0) return null;

    const senderName = await resolveSenderName(dbAdmin, senderId);
    const isGroup    = chatData.type === 'group';
    const title      = isGroup && chatData.groupName ? chatData.groupName : senderName;
    const bodyText   = messageBody(msg);
    const body       = isGroup ? `${senderName}: ${bodyText}` : bodyText;

    // Collect each recipient's push token, skipping anyone who blocked the sender.
    const messages: any[] = [];
    await Promise.all(
      recipients.map(async (recipientId) => {
        try {
          // Skip if the recipient has blocked the sender.
          const blockDoc = await dbAdmin
            .collection('users').doc(recipientId)
            .collection('blockedUsers').doc(senderId)
            .get();
          if (blockDoc.exists) return;

          const userSnap = await dbAdmin.collection('users').doc(recipientId).get();
          const token    = userSnap.data()?.pushToken;
          if (!token || typeof token !== 'string') return;

          messages.push({
            to: token,
            sound: 'default',
            title,
            body,
            categoryId: 'chat_message',   // enables inline Reply in the shade
            data: {
              chatId,
              senderId,
              type: 'message',
            },
            // Android: group messages from the same chat into one thread
            ...(isGroup ? {} : {}),
          });
        } catch (err) {
          console.warn('[onMessageCreated] token lookup failed for', recipientId, err);
        }
      }),
    );

    if (messages.length === 0) {
      console.log('[onMessageCreated] No push tokens to notify.');
      return null;
    }

    // Expo accepts up to 100 messages per request — chunk to be safe.
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      try {
        const res = await fetch(EXPO_PUSH_ENDPOINT, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(chunk),
        });
        const json = await res.json();
        console.log('[onMessageCreated] Expo push response:', JSON.stringify(json));
      } catch (err) {
        console.error('[onMessageCreated] Failed to send push chunk:', err);
      }
    }

    console.log(`[onMessageCreated] Sent ${messages.length} push notification(s) for chat ${chatId}.`);
    return null;
  });
