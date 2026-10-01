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
exports.mintCompanionToken = exports.cleanupExpiredLinkTokens = exports.cleanupStaleCalls = exports.cleanupExpiredMessages = exports.cleanupExpiredStatuses = void 0;
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

exports.mintCompanionToken = functionsV1.https.onCall(async (data, context) => {
  try {
    functionsV1.logger.info('mintCompanionToken called', {
      hasAuth: !!context.auth,
      uid: context.auth ? context.auth.uid : null,
      companionClaim: context.auth ? (context.auth.token && context.auth.token.companion) : null,
      dataKeys: Object.keys(data || {}),
    });

    if (!context.auth) {
      throw new functionsV1.https.HttpsError(
        'unauthenticated',
        'You must be signed in to link a device.',
      );
    }
    const ownerUid = context.auth.uid;

    if (context.auth.token && context.auth.token.companion === true) {
      throw new functionsV1.https.HttpsError(
        'permission-denied',
        'Companion devices cannot link other devices.',
      );
    }

    const requestId = (data && data.requestId) || '';
    if (
      typeof requestId !== 'string' ||
      requestId.length !== 64 ||
      !/^[0-9a-f]+$/i.test(requestId)
    ) {
      throw new functionsV1.https.HttpsError('invalid-argument', 'Invalid requestId.');
    }

    // Ensure Admin app is initialized before use
    if (getApps().length === 0) {
      initializeApp();
    }

    const dbAdmin = getFirestore();
    const tokenRef  = dbAdmin.collection('deviceLinkTokens').doc(requestId);
    const tokenSnap = await tokenRef.get();
    if (!tokenSnap.exists) {
      throw new functionsV1.https.HttpsError('not-found', 'Link request not found.');
    }
    const t = tokenSnap.data();

    if (t.requesterUid === ownerUid) {
      throw new functionsV1.https.HttpsError(
        'invalid-argument',
        'You cannot link a device to itself.',
      );
    }

    const expiresAt = t.expiresAt && t.expiresAt.toDate
      ? t.expiresAt.toDate()
      : new Date(t.expiresAt);
    if (
      Number.isNaN(expiresAt.getTime()) ||
      Date.now() > expiresAt.getTime() + MAX_LINK_AGE_MS
    ) {
      throw new functionsV1.https.HttpsError(
        'failed-precondition',
        'This link request has expired.',
      );
    }

    if (t.companionCustomToken) {
      throw new functionsV1.https.HttpsError(
        'already-exists',
        'A companion token has already been minted for this request.',
      );
    }

    if (t.ownerUid && t.ownerUid !== ownerUid) {
      throw new functionsV1.https.HttpsError(
        'permission-denied',
        'This request has already been claimed by another account.',
      );
    }

    const customToken = await getAuth().createCustomToken(ownerUid, {
      companion: true,
    });

    functionsV1.logger.info('mintCompanionToken success', {
      ownerUid,
      requestId,
    });

    return { customToken };
  } catch (err) {
    // If it's already an HttpsError, rethrow it cleanly
    if (err instanceof functionsV1.https.HttpsError) {
      throw err;
    }
    // Otherwise log everything and turn it into an INTERNAL with detail
    functionsV1.logger.error('mintCompanionToken FAILED', {
      message: err && err.message,
      stack: err && err.stack,
      code: err && err.code,
    });
    throw new functionsV1.https.HttpsError(
      'internal',
      (err && err.message) || 'Internal error.',
    );
  }
});