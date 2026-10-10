// ─── Service: Status Cleanup ──────────────────────────────────────────────────
// Background service that automatically deletes expired statuses (older than 24 hours)
// from Firestore and Firebase Storage.

import firestore from '@react-native-firebase/firestore';
import { db, storage } from '../config/firebase';
import { useBackend } from '../config/featureFlags';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Run every hour
const BATCH_SIZE = 50;

async function cleanupExpiredStatuses(): Promise<number> {
  try {
    const now = new Date();
    const fsDb = db as ReturnType<typeof firestore>;
    const snapshot = await fsDb
      .collection('statuses')
      .where('expiresAt', '<=', now)
      .get();

    if (snapshot.empty) {
      console.log('[StatusCleanup] No expired statuses found');
      return 0;
    }

    console.log(`[StatusCleanup] Found ${snapshot.size} expired statuses to delete`);

    let deletedCount = 0;
    const deletePromises: Promise<void>[] = [];

    for (const docSnap of snapshot.docs) {
      const mediaUrl = docSnap.data().mediaUrl;

      // Delete media from Storage if it exists
      if (mediaUrl && typeof mediaUrl === 'string') {
        const deleteMediaPromise = (async () => {
          try {
            const nativeSt = storage as ReturnType<typeof import('@react-native-firebase/storage').default>;
            await nativeSt.refFromURL(mediaUrl).delete();
            console.log(`[StatusCleanup] Deleted media: ${mediaUrl}`);
          } catch (storageErr: any) {
            if (storageErr.code !== 'storage/object-not-found') {
              console.warn('[StatusCleanup] Storage delete warning:', storageErr);
            }
          }
        })();
        deletePromises.push(deleteMediaPromise);
      }

      // Delete the Firestore document
      const deleteDocPromise = fsDb.collection('statuses').doc(docSnap.id).delete()
        .then(() => {
          console.log(`[StatusCleanup] Deleted status doc: ${docSnap.id}`);
          deletedCount++;
        })
        .catch((err) => {
          console.error(`[StatusCleanup] Failed to delete status ${docSnap.id}:`, err);
        });

      deletePromises.push(deleteDocPromise);

      if (deletePromises.length >= BATCH_SIZE) {
        await Promise.allSettled(deletePromises);
        deletePromises.length = 0;
      }
    }

    if (deletePromises.length > 0) {
      await Promise.allSettled(deletePromises);
    }

    console.log(`[StatusCleanup] Cleanup complete. Deleted ${deletedCount} statuses`);
    return deletedCount;
  } catch (err) {
    console.error('[StatusCleanup] Cleanup error:', err);
    return 0;
  }
}

let cleanupInterval: NodeJS.Timeout | null = null;
let isRunning = false;

export function startStatusCleanupService(): void {
  // On the backend path, the server's scheduled job owns status cleanup, so the
  // client-side best-effort sweep is unnecessary (Req 11.1).
  if (useBackend('status')) { console.log('[StatusCleanup] Backend handles cleanup; client sweep disabled'); return; }
  if (isRunning) { console.log('[StatusCleanup] Service already running'); return; }
  console.log('[StatusCleanup] Starting cleanup service');
  isRunning = true;
  cleanupExpiredStatuses();
  cleanupInterval = setInterval(() => cleanupExpiredStatuses(), CLEANUP_INTERVAL_MS);
}

export function stopStatusCleanupService(): void {
  if (!isRunning) { console.log('[StatusCleanup] Service not running'); return; }
  console.log('[StatusCleanup] Stopping cleanup service');
  if (cleanupInterval) { clearInterval(cleanupInterval); cleanupInterval = null; }
  isRunning = false;
}

export function isCleanupServiceRunning(): boolean { return isRunning; }

export async function triggerManualCleanup(): Promise<number> {
  if (useBackend('status')) {
    console.log('[StatusCleanup] Backend handles cleanup; manual trigger is a no-op on backend path');
    return 0;
  }
  console.log('[StatusCleanup] Manual cleanup triggered');
  return cleanupExpiredStatuses();
}
