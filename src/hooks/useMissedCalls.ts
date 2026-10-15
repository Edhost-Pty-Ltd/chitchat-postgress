// ─── useMissedCalls Hook ──────────────────────────────────────────────────────
// Real-time count of unseen missed calls, plus a helper to clear the badge.
// When the user opens the Calls tab, CallsScreen calls markAllSeen() which
// sets seen:true on every unseen missed call — dropping the count to zero.

import { useState, useEffect, useCallback } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

export function useMissedCalls(userId: string | null): {
  missedCount: number;
  loading: boolean;
  markAllSeen: () => Promise<void>;
} {
  const [missedCount, setMissedCount] = useState(0);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    if (!userId) { setMissedCount(0); setLoading(false); return; }
    setLoading(true);

    const fsDb = db as ReturnType<typeof firestore>;

    // Count only unseen missed calls. Existing records without a `seen` field
    // are treated as unseen (seen != true catches both false and missing).
    const unsub = fsDb
      .collection('users').doc(userId).collection('callHistory')
      .where('direction', '==', 'incoming')
      .where('status',    '==', 'missed')
      .where('seen',      '==', false)
      .onSnapshot(
        (snapshot) => { setMissedCount(snapshot.docs.length); setLoading(false); },
        (error)    => { console.error('[useMissedCalls] Error:', error); setLoading(false); },
      );

    return () => unsub();
  }, [userId]);

  // Mark every unseen missed call as seen in a single batched write.
  const markAllSeen = useCallback(async () => {
    if (!userId || missedCount === 0) return;
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      const snap = await fsDb
        .collection('users').doc(userId).collection('callHistory')
        .where('direction', '==', 'incoming')
        .where('status',    '==', 'missed')
        .where('seen',      '==', false)
        .get();

      if (snap.empty) return;

      const batch = fsDb.batch();
      snap.docs.forEach((doc) => batch.update(doc.ref, { seen: true }));
      await batch.commit();
    } catch (err) {
      console.warn('[useMissedCalls] markAllSeen failed:', err);
    }
  }, [userId, missedCount]);

  return { missedCount, loading, markAllSeen };
}
