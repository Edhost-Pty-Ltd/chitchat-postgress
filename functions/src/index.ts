// ─── Cloud Functions (2nd gen) ───────────────────────────────────────────────
// Server-side maintenance, cleanup, and companion-device linking.

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp as AdminTimestamp } from 'firebase-admin/firestore';
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