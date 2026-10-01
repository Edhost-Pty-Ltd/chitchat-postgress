"use strict";
// ─── Cloud Functions (2nd gen) ───────────────────────────────────────────────
// Server-side maintenance, cleanup, and companion-device linking.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.recordProfileView = exports.sendMessageNotification = exports.mintCompanionToken = exports.cleanupExpiredLinkTokens = exports.cleanupStaleCalls = exports.cleanupExpiredMessages = exports.cleanupExpiredStatuses = void 0;
const app_1 = require("firebase-admin/app");
const firestore_1 = require("firebase-admin/firestore");
const storage_1 = require("firebase-admin/storage");
const auth_1 = require("firebase-admin/auth");
const scheduler_1 = require("firebase-functions/v2/scheduler");
const https_1 = require("firebase-functions/v2/https");
const v2_1 = require("firebase-functions/v2");
const logger = __importStar(require("firebase-functions/logger"));
if ((0, app_1.getApps)().length === 0) {
    (0, app_1.initializeApp)();
}
// Global defaults for every function in this codebase.
(0, v2_1.setGlobalOptions)({
    region: 'us-central1',
    maxInstances: 10,
    // cpu / concurrency are valid on gen 2 — leave defaults unless you need more.
});
const FIRESTORE_BATCH_LIMIT = 500;
async function deleteRefsInBatches(refs) {
    const dbAdmin = (0, firestore_1.getFirestore)();
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
function storagePathFromUrl(url) {
    if (!url || typeof url !== 'string')
        return null;
    const match = url.match(/\/o\/([^?]+)/);
    return match ? decodeURIComponent(match[1]) : null;
}
async function deleteStorageByUrls(urls) {
    const bucket = (0, storage_1.getStorage)().bucket();
    await Promise.all(urls.map(async (url) => {
        const path = storagePathFromUrl(url);
        if (!path)
            return;
        try {
            await bucket.file(path).delete();
        }
        catch (err) {
            if (err?.code !== 404) {
                logger.warn('[cleanup] Failed to delete storage object:', path, err?.message);
            }
        }
    }));
}
// ─── 1. Expired statuses ────────────────────────────────────────────────────
exports.cleanupExpiredStatuses = (0, scheduler_1.onSchedule)('every 60 minutes', async () => {
    const dbAdmin = (0, firestore_1.getFirestore)();
    const now = firestore_1.Timestamp.now();
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
exports.cleanupExpiredMessages = (0, scheduler_1.onSchedule)('every 24 hours', async () => {
    const dbAdmin = (0, firestore_1.getFirestore)();
    const now = firestore_1.Timestamp.now();
    const snap = await dbAdmin
        .collectionGroup('messages')
        .where('expiresAt', '<=', now)
        .limit(2000)
        .get();
    if (snap.empty) {
        logger.info('[cleanupExpiredMessages] Nothing to clean.');
        return;
    }
    const mediaUrls = [];
    snap.docs.forEach((d) => {
        const m = d.data();
        mediaUrls.push(m.imageUrl, m.voiceUrl, m.videoUrl, m.fileUrl, m.thumbnailUrl);
    });
    await deleteStorageByUrls(mediaUrls);
    const deleted = await deleteRefsInBatches(snap.docs.map((d) => d.ref));
    logger.info(`[cleanupExpiredMessages] Deleted ${deleted} expired message(s).`);
});
// ─── 3. Stale calls ─────────────────────────────────────────────────────────
exports.cleanupStaleCalls = (0, scheduler_1.onSchedule)('every 30 minutes', async () => {
    const dbAdmin = (0, firestore_1.getFirestore)();
    const cutoff3h = firestore_1.Timestamp.fromMillis(Date.now() - 3 * 60 * 60 * 1000);
    const toDelete = [];
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
exports.cleanupExpiredLinkTokens = (0, scheduler_1.onSchedule)('every 60 minutes', async () => {
    const dbAdmin = (0, firestore_1.getFirestore)();
    const cutoff = firestore_1.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
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
exports.mintCompanionToken = (0, https_1.onCall)(async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'You must be signed in to link a device.');
    }
    const ownerUid = request.auth.uid;
    if (request.auth.token?.companion === true) {
        throw new https_1.HttpsError('permission-denied', 'Companion devices cannot link other devices.');
    }
    const requestId = (request.data?.requestId ?? '');
    if (typeof requestId !== 'string' || requestId.length !== 64 || !/^[0-9a-f]+$/i.test(requestId)) {
        throw new https_1.HttpsError('invalid-argument', 'Invalid requestId.');
    }
    const dbAdmin = (0, firestore_1.getFirestore)();
    const tokenRef = dbAdmin.collection('deviceLinkTokens').doc(requestId);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) {
        throw new https_1.HttpsError('not-found', 'Link request not found.');
    }
    const t = tokenSnap.data();
    if (t.requesterUid === ownerUid) {
        throw new https_1.HttpsError('invalid-argument', 'You cannot link a device to itself.');
    }
    const expiresAt = t.expiresAt?.toDate ? t.expiresAt.toDate() : new Date(t.expiresAt);
    if (Number.isNaN(expiresAt.getTime()) || Date.now() > expiresAt.getTime() + MAX_LINK_AGE_MS) {
        throw new https_1.HttpsError('failed-precondition', 'This link request has expired.');
    }
    if (t.companionCustomToken) {
        throw new https_1.HttpsError('already-exists', 'A companion token has already been minted for this request.');
    }
    if (t.ownerUid && t.ownerUid !== ownerUid) {
        throw new https_1.HttpsError('permission-denied', 'This request has already been claimed by another account.');
    }
    const customToken = await (0, auth_1.getAuth)().createCustomToken(ownerUid, { companion: true });
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
const firestore_2 = require("firebase-functions/v2/firestore");
const https = __importStar(require("https"));
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** POST a batch of Expo push messages (max 100 per call). */
async function sendExpoPushBatch(messages) {
    if (messages.length === 0)
        return;
    const payload = JSON.stringify(messages);
    await new Promise((resolve, reject) => {
        const url = new URL(EXPO_PUSH_URL);
        const req = https.request({
            hostname: url.hostname,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Accept-Encoding': 'gzip, deflate',
            },
        }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk.toString(); });
            res.on('end', () => {
                if (res.statusCode && res.statusCode >= 400) {
                    logger.warn('[sendMessageNotification] Expo push error:', res.statusCode, body);
                }
                resolve();
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}
exports.sendMessageNotification = (0, firestore_2.onDocumentWritten)('chats/{chatId}', async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    if (!after?.exists)
        return; // chat deleted — nothing to do
    const chatData = after.data();
    const lastMsg = chatData.lastMessage;
    if (!lastMsg?.senderId || !lastMsg?.timestamp)
        return;
    // Only fire when lastMessage.timestamp actually changed (a new message was sent)
    const prevLastMsg = before?.exists ? before.data().lastMessage : undefined;
    const prevTs = prevLastMsg?.timestamp?.toMillis?.() ?? 0;
    const newTs = lastMsg.timestamp.toMillis?.() ?? 0;
    if (newTs <= prevTs)
        return; // timestamp didn't advance — skip
    const senderId = lastMsg.senderId;
    const members = (chatData.members ?? []);
    const isGroup = chatData.type === 'group';
    const groupName = (chatData.groupName ?? 'Group');
    const msgText = lastMsg.text || (lastMsg.type === 'image' ? '📷 Photo' : lastMsg.type === 'voice' ? '🎤 Voice message' : '📎 File');
    const dbAdmin = (0, firestore_1.getFirestore)();
    // Resolve sender display name for group chats
    let senderName = 'Someone';
    if (isGroup) {
        try {
            const senderDoc = await dbAdmin.collection('users').doc(senderId).get();
            if (senderDoc.exists) {
                const d = senderDoc.data();
                const dn = (d.displayName ?? '').trim();
                const ph = (d.phone ?? '').trim();
                const PHONE_LIKE = /^\+?[\d\s\-()]{5,}$/;
                senderName = (dn && !PHONE_LIKE.test(dn) && dn !== ph) ? dn : (ph || dn || 'Someone');
            }
        }
        catch (err) {
            logger.warn('[sendMessageNotification] Could not resolve sender name:', err);
        }
    }
    // Collect all push tokens for non-sender members
    const pushMessages = [];
    await Promise.all(members
        .filter((uid) => uid !== senderId)
        .map(async (uid) => {
        try {
            const tokensSnap = await dbAdmin
                .collection('users').doc(uid)
                .collection('pushTokens')
                .get();
            for (const tokenDoc of tokensSnap.docs) {
                const token = tokenDoc.data().token;
                if (!token || !token.startsWith('ExponentPushToken['))
                    continue;
                pushMessages.push({
                    to: token,
                    sound: 'default',
                    title: isGroup ? groupName : senderName,
                    body: isGroup ? `${senderName}: ${msgText}` : msgText,
                    channelId: 'default',
                    data: {
                        chatId: event.params.chatId,
                        senderId,
                        type: 'message',
                    },
                });
            }
        }
        catch (err) {
            logger.warn(`[sendMessageNotification] Failed to get tokens for uid ${uid}:`, err);
        }
    }));
    if (pushMessages.length === 0)
        return;
    // Expo limits 100 messages per batch
    const BATCH_SIZE = 100;
    for (let i = 0; i < pushMessages.length; i += BATCH_SIZE) {
        await sendExpoPushBatch(pushMessages.slice(i, i + BATCH_SIZE));
    }
    logger.info(`[sendMessageNotification] Sent ${pushMessages.length} push(es) for chat ${event.params.chatId}`);
});
// ─── Profile View Tracker ────────────────────────────────────────────────────
exports.recordProfileView = (0, https_1.onCall)(async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError('unauthenticated', 'Must be signed in to record a profile view.');
    }
    const viewerUid = request.auth.uid;
    const viewedUid = (request.data?.viewedUid ?? '');
    if (!viewedUid) {
        throw new https_1.HttpsError('invalid-argument', 'viewedUid is required.');
    }
    if (viewerUid === viewedUid) {
        // Silently ignore self-views
        return { ok: true };
    }
    const dbAdmin = (0, firestore_1.getFirestore)();
    const userRef = dbAdmin.collection('users').doc(viewedUid);
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const snap = await userRef.get();
    const storedDayKey = snap.exists ? (snap.data()?.profileViewsDayKey ?? '') : '';
    const todayIncrement = storedDayKey === todayKey
        ? firestore_1.FieldValue.increment(1)
        : 1;
    await userRef.set({
        profileViews: firestore_1.FieldValue.increment(1),
        profileViewsToday: todayIncrement,
        profileViewsDayKey: todayKey,
        profileViewsUpdatedAt: firestore_1.FieldValue.serverTimestamp(),
    }, { merge: true });
    logger.info('[recordProfileView] Recorded view', { viewerUid, viewedUid });
    return { ok: true };
});
//# sourceMappingURL=index.js.map