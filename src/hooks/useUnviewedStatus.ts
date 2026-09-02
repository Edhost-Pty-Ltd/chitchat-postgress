// ─── useUnviewedStatus Hook ──────────────────────────────────────────────────
// Detects if there are unviewed status updates from contacts.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

export function useUnviewedStatus(userId: string | null): {
  hasUnviewedStatus: boolean;
  unviewedCount: number;
  loading: boolean;
} {
  const [hasUnviewedStatus, setHasUnviewedStatus] = useState(false);
  const [unviewedCount,     setUnviewedCount]     = useState(0);
  const [loading,           setLoading]           = useState(true);

  useEffect(() => {
    if (!userId) {
      setHasUnviewedStatus(false); setUnviewedCount(0); setLoading(false); return;
    }

    setLoading(true);
    const fsDb = db as ReturnType<typeof firestore>;

    const unsub = fsDb
      .collection('statuses')
      .where('expiresAt', '>', new Date())
      .onSnapshot(
        (snapshot) => {
          let count = 0;
          snapshot.docs.forEach((doc) => {
            const data = doc.data();
            if (data.userId === userId) return;
            const viewedBy      = data.viewedBy      || [];
            const excludedUsers = data.excludedUsers || [];
            if (!viewedBy.includes(userId) && !excludedUsers.includes(userId)) count++;
          });
          setUnviewedCount(count);
          setHasUnviewedStatus(count > 0);
          setLoading(false);
        },
        (error) => {
          console.error('[useUnviewedStatus] Error:', error);
          setLoading(false);
        },
      );

    return () => unsub();
  }, [userId]);

  return { hasUnviewedStatus, unviewedCount, loading };
}
