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
