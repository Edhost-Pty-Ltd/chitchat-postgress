// ─── useLastSeen Hook ─────────────────────────────────────────────────────────
// Returns last seen for a user, respecting block privacy.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

function toDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

export function useLastSeen(
  userId:   string | null,
  viewerId: string | null,
): { lastSeen: Date | null; loading: boolean } {
  const [lastSeen, setLastSeen] = useState<Date | null>(null);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    if (!userId || !viewerId || userId === viewerId) {
      setLastSeen(null); setLoading(false); return;
    }

    setLoading(true);
    const fsDb = db as ReturnType<typeof firestore>;
    let unsubFn: (() => void) | undefined;

    (async () => {
      try {
        const blockedSnap = await fsDb
          .collection('users').doc(userId).collection('blockedUsers').doc(viewerId)
          .get();

        if (blockedSnap.exists) {
          setLastSeen(toDate(blockedSnap.data()!.lastSeenAtBlock));
          setLoading(false);
          return;
        }

        unsubFn = fsDb.collection('users').doc(userId).onSnapshot(
          (snap) => {
            if (snap.exists) setLastSeen(toDate(snap.data()!.lastSeen));
            else setLastSeen(null);
            setLoading(false);
          },
          (err) => {
            console.error('[useLastSeen] Error:', err);
            setLastSeen(null); setLoading(false);
          },
        );
      } catch (err) {
        console.error('[useLastSeen] Error checking block status:', err);
        setLastSeen(null); setLoading(false);
      }
    })();

    return () => { unsubFn?.(); };
  }, [userId, viewerId]);

  return { lastSeen, loading };
}
