// ─── Cloud Functions (2nd gen) ───────────────────────────────────────────────
// Server-side maintenance, cleanup, and companion-device linking.

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp as AdminTimestamp, FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { getAuth } from 'firebase-admin/auth';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import * as logger from 'firebase-functions/logger';

if (getApps().length === 0) {
  initializeApp();
}

// Global defaults for every function in this codebase.
setGlobalOptions({
  region: 'us-central1',
  maxInstances: 10,
  // cpu / concurrency are valid on gen 2 — leave defaults unless you need more.
});

const FIRESTORE_BATCH_LIMIT = 500;

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

function storagePathFromUrl(url?: string | null): string | null {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/o\/([^?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function deleteStorageByUrls(urls: Array<string | null | undefined>): Promise<void> {
  const bucket = getStorage().bucket();
  await Promise.all(
    urls.map(async (url) => {
      const path = storagePathFromUrl(url);
      if (!path) return;
      try {
        await bucket.file(path).delete();
      } catch (err: any) {
        if (err?.code !== 404) {
          logger.warn('[cleanup] Failed to delete storage object:', path, err?.message);
        }
      }
    }),
  );
}

// ─── 1. Expired statuses ────────────────────────────────────────────────────
export const cleanupExpiredStatuses = onSchedule('every 60 minutes', async () => {
  const dbAdmin = getFirestore();
  const now = AdminTimestamp.now();

  const snap = await dbAdmin
    .collection('statuses')
    .where('expiresAt', '<=', now)
    .limit(1000)
    .get();

  if (snap.empty) {
    logger.info('[cleanupExpiredStatuses] Nothing to clean.');
    return;
  }

  await deleteStorageByUrls(snap.docs.map((d) => d.data().mediaUrl));
  const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));
  logger.info(`[cleanupExpiredStatuses] Deleted ${deleted} expired status(es).`);
});

// ─── 2. Expired messages ────────────────────────────────────────────────────
export const cleanupExpiredMessages = onSchedule('every 24 hours', async () => {
  const dbAdmin = getFirestore();
  const now = AdminTimestamp.now();

  const snap = await dbAdmin
    .collectionGroup('messages')
    .where('expiresAt', '<=', now)
    .limit(2000)
    .get();

  if (snap.empty) {
    logger.info('[cleanupExpiredMessages] Nothing to clean.');
    return;
  }

  const mediaUrls: Array<string | null | undefined> = [];
  snap.docs.forEach((d) => {
    const m = d.data();
    mediaUrls.push(m.imageUrl, m.voiceUrl, m.videoUrl, m.fileUrl, m.thumbnailUrl);
  });
  await deleteStorageByUrls(mediaUrls);

  const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));
  logger.info(`[cleanupExpiredMessages] Deleted ${deleted} expired message(s).`);
});

// ─── 3. Stale calls ─────────────────────────────────────────────────────────
export const cleanupStaleCalls = onSchedule('every 30 minutes', async () => {
  const dbAdmin = getFirestore();
  const cutoff3h = AdminTimestamp.fromMillis(Date.now() - 3 * 60 * 60 * 1000);

  const toDelete: FirebaseFirestore.DocumentReference[] = [];
  const staleCalls = await dbAdmin
    .collection('calls')
    .where('updatedAt', '<=', cutoff3h)
    .limit(1000)
    .get();
  staleCalls.forEach((d) => toDelete.push(d.ref));

  if (toDelete.length === 0) {
    logger.info('[cleanupStaleCalls] Nothing to clean.');
    return;
  }

  const deleted = await deleteRefsInBatches(toDelete);
  logger.info(`[cleanupStaleCalls] Deleted ${deleted} stale call doc(s).`);
});

// ─── 4. Expired device link tokens ─────────────────────────────────────────
export const cleanupExpiredLinkTokens = onSchedule('every 60 minutes', async () => {
  const dbAdmin = getFirestore();
  const cutoff = AdminTimestamp.fromMillis(Date.now() - 60 * 60 * 1000);

  const snap = await dbAdmin
    .collection('deviceLinkTokens')
    .where('expiresAt', '<=', cutoff)
    .limit(500)
    .get();

  if (snap.empty) {
    logger.info('[cleanupExpiredLinkTokens] Nothing to clean.');
    return;
  }

  const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));
  logger.info(`[cleanupExpiredLinkTokens] Deleted ${deleted} expired link token(s).`);
});

// ─── Companion-device linking ──────────────────────────────────────────────
const MAX_LINK_AGE_MS = 15 * 60 * 1000;

export const mintCompanionToken = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to link a device.');
  }
  const ownerUid = request.auth.uid;

  if (request.auth.token?.companion === true) {
    throw new HttpsError('permission-denied', 'Companion devices cannot link other devices.');
  }

  const requestId = (request.data?.requestId ?? '') as string;
  if (typeof requestId !== 'string' || requestId.length !== 64 || !/^[0-9a-f]+$/i.test(requestId)) {
    throw new HttpsError('invalid-argument', 'Invalid requestId.');
  }

  const dbAdmin = getFirestore();
  const tokenRef = dbAdmin.collection('deviceLinkTokens').doc(requestId);
  const tokenSnap = await tokenRef.get();
  if (!tokenSnap.exists) {
    throw new HttpsError('not-found', 'Link request not found.');
  }
  const t = tokenSnap.data()!;

  if (t.requesterUid === ownerUid) {
    throw new HttpsError('invalid-argument', 'You cannot link a device to itself.');
  }

  const expiresAt = t.expiresAt?.toDate ? t.expiresAt.toDate() : new Date(t.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || Date.now() > expiresAt.getTime() + MAX_LINK_AGE_MS) {
    throw new HttpsError('failed-precondition', 'This link request has expired.');
  }

  if (t.companionCustomToken) {
    throw new HttpsError('already-exists', 'A companion token has already been minted for this request.');
  }

  if (t.ownerUid && t.ownerUid !== ownerUid) {
    throw new HttpsError('permission-denied', 'This request has already been claimed by another account.');
  }

  const customToken = await getAuth().createCustomToken(ownerUid, { companion: true });

  logger.info('mintCompanionToken', { ownerUid, requestId, deviceName: t.deviceName ?? null });

  return { customToken };
});

// ─── Push Notifications for new messages ───────────────────────────────────
// Triggers whenever a chat document is written (i.e. lastMessage is updated).
// Fans out an Expo push notification to every member except the sender.
//
// Token storage:   users/{memberId}/pushTokens/{deviceId} → { token, platform }
// Push delivery:   Expo Push API  (https://exp.host/--/api/v2/push/send)
//                  Works for both iOS and Android Expo-managed apps.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as https from 'https';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default';
  badge?: number;
  channelId?: string;
}

/** POST a batch of Expo push messages (max 100 per call). */
async function sendExpoPushBatch(messages: ExpoPushMessage[]): Promise<void> {
  if (messages.length === 0) return;

  const payload = JSON.stringify(messages);

  await new Promise<void>((resolve, reject) => {
    const url = new URL(EXPO_PUSH_URL);
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            logger.warn('[sendMessageNotification] Expo push error:', res.statusCode, body);
          }
          resolve();
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

export const sendMessageNotification = onDocumentWritten(
  'chats/{chatId}',
  async (event) => {
    const after  = event.data?.after;
    const before = event.data?.before;

    if (!after?.exists) return; // chat deleted — nothing to do

    const chatData   = after.data()!;
    const lastMsg    = chatData.lastMessage as {
      text?: string;
      senderId?: string;
      timestamp?: FirebaseFirestore.Timestamp;
      type?: string;
    } | undefined;

    if (!lastMsg?.senderId || !lastMsg?.timestamp) return;

    // Only fire when lastMessage.timestamp actually changed (a new message was sent)
    const prevLastMsg = before?.exists ? (before.data()!.lastMessage as typeof lastMsg) : undefined;
    const prevTs = prevLastMsg?.timestamp?.toMillis?.() ?? 0;
    const newTs  = lastMsg.timestamp.toMillis?.() ?? 0;
    if (newTs <= prevTs) return;  // timestamp didn't advance — skip

    const senderId   = lastMsg.senderId;
    const members    = (chatData.members ?? []) as string[];
    const isGroup    = chatData.type === 'group';
    const groupName  = (chatData.groupName ?? 'Group') as string;
    const msgText    = lastMsg.text || (lastMsg.type === 'image' ? '📷 Photo' : lastMsg.type === 'voice' ? '🎤 Voice message' : '📎 File');

    const dbAdmin = getFirestore();

    // Resolve sender display name for group chats
    let senderName = 'Someone';
    if (isGroup) {
      try {
        const senderDoc = await dbAdmin.collection('users').doc(senderId).get();
        if (senderDoc.exists) {
          const d = senderDoc.data()!;
          const dn = (d.displayName ?? '').trim();
          const ph = (d.phone ?? '').trim();
          const PHONE_LIKE = /^\+?[\d\s\-()]{5,}$/;
          senderName = (dn && !PHONE_LIKE.test(dn) && dn !== ph) ? dn : (ph || dn || 'Someone');
        }
      } catch (err) {
        logger.warn('[sendMessageNotification] Could not resolve sender name:', err);
      }
    }

    // Collect all push tokens for non-sender members
    const pushMessages: ExpoPushMessage[] = [];

    await Promise.all(
      members
        .filter((uid) => uid !== senderId)
        .map(async (uid) => {
          try {
            const tokensSnap = await dbAdmin
              .collection('users').doc(uid)
              .collection('pushTokens')
              .get();

            for (const tokenDoc of tokensSnap.docs) {
              const token = tokenDoc.data().token as string | undefined;
              if (!token || !token.startsWith('ExponentPushToken[')) continue;

              pushMessages.push({
                to:        token,
                sound:     'default',
                title:     isGroup ? groupName : senderName,
                body:      isGroup ? `${senderName}: ${msgText}` : msgText,
                channelId: 'default',
                data: {
                  chatId:     event.params.chatId,
                  senderId,
                  type:       'message',
                },
              });
            }
          } catch (err) {
            logger.warn(`[sendMessageNotification] Failed to get tokens for uid ${uid}:`, err);
          }
        }),
    );

    if (pushMessages.length === 0) return;

    // Expo limits 100 messages per batch
    const BATCH_SIZE = 100;
    for (let i = 0; i < pushMessages.length; i += BATCH_SIZE) {
      await sendExpoPushBatch(pushMessages.slice(i, i + BATCH_SIZE));
    }

    logger.info(`[sendMessageNotification] Sent ${pushMessages.length} push(es) for chat ${event.params.chatId}`);
  },
);

// ─── Revoke companion device token ─────────────────────────────────────────
// Called by the primary device immediately after deleting a linkedDevices doc.
// Calls admin.auth().revokeRefreshTokens(ownerUid) so that any companion
// holding a custom-token session for that ownerUid is forced to re-authenticate
// on their next ID-token refresh (within 1 hour). This closes the gap where a
// non-cooperative companion could ignore the client-side watchCompanionLink
// listener and keep a live owner session indefinitely.
//
// Security:
//  - Caller must be signed in as the primary (non-companion) owner.
//  - The companion claim on a revoked session causes ID-token refresh to fail,
//    signing the companion out on their next Firestore call.
export const revokeDeviceToken = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in.');
  }

  const ownerUid = request.auth.uid;

  // Companions cannot revoke tokens — only the primary owner can.
  if (request.auth.token?.companion === true) {
    throw new HttpsError('permission-denied', 'Companion devices cannot revoke tokens.');
  }

  // Revoke all refresh tokens issued for this UID. Any session (including
  // companions) will be forced to re-authenticate within the ID-token TTL
  // (~1 hour). Since companions sign in with a custom token whose uid equals
  // the owner uid, this covers them.
  try {
    await getAuth().revokeRefreshTokens(ownerUid);
    logger.info('[revokeDeviceToken] Revoked refresh tokens for uid:', ownerUid);
  } catch (err: any) {
    logger.error('[revokeDeviceToken] Failed to revoke tokens:', err?.message);
    throw new HttpsError('internal', 'Failed to revoke tokens. Please try again.');
  }

  return { ok: true };
});

// ─── Profile View Tracker ────────────────────────────────────────────────────
// Callable that atomically increments profileViews / profileViewsToday on
// users/{viewedUid} using the Admin SDK, which bypasses client-side rules
// entirely. Running server-side closes two gaps:
//   1. A client could call increment() repeatedly — the server enforces one
//      call per invocation and the caller can't forge the result.
//   2. The client-side rule "profileViews == resource + 1" silently fails on
//      the very first view because the field doesn't exist yet; the Admin SDK
//      FieldValue.increment() initialises a missing field to 0 then adds 1.
export const recordProfileView = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Must be signed in to record a profile view.');
  }

  const viewerUid = request.auth.uid;
  const viewedUid = (request.data?.viewedUid ?? '') as string;

  if (!viewedUid || typeof viewedUid !== 'string') {
    throw new HttpsError('invalid-argument', 'viewedUid is required.');
  }
  // Silently ignore self-views — don't inflate the owner's own counter.
  if (viewerUid === viewedUid) return { ok: true };

  const dbAdmin = getFirestore();
  const userRef = dbAdmin.collection('users').doc(viewedUid);

  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const snap = await userRef.get();
  const storedDayKey: string = snap.exists ? (snap.data()?.profileViewsDayKey ?? '') : '';

  // Reset today's counter when the day rolls over; otherwise increment.
  // FieldValue.increment(1) initialises to 1 if the field is absent.
  const todayIncrement = storedDayKey === todayKey
    ? FieldValue.increment(1)
    : 1;

  await userRef.set(
    {
      profileViews:          FieldValue.increment(1),
      profileViewsToday:     todayIncrement,
      profileViewsDayKey:    todayKey,
      profileViewsUpdatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );

  logger.info('[recordProfileView]', { viewerUid, viewedUid });
  return { ok: true };
});
