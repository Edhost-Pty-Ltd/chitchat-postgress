// ─── useMissedCalls Hook ──────────────────────────────────────────────────────
// Real-time listener for missed calls count.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

export function useMissedCalls(userId: string | null): {
  missedCount: number;
  loading: boolean;
} {
  const [missedCount, setMissedCount] = useState(0);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    if (!userId) { setMissedCount(0); setLoading(false); return; }
    setLoading(true);

    const fsDb = db as ReturnType<typeof firestore>;

    const unsub = fsDb
      .collection('users').doc(userId).collection('callHistory')
      .where('direction', '==', 'incoming')
      .where('status', '==', 'missed')
      .onSnapshot(
        (snapshot) => { setMissedCount(snapshot.docs.length); setLoading(false); },
        (error)    => { console.error('[useMissedCalls] Error:', error); setLoading(false); },
      );

    return () => unsub();
  }, [userId]);

  return { missedCount, loading };
}
