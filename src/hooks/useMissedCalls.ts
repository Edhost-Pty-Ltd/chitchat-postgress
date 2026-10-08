// ─── useMissedCalls Hook ──────────────────────────────────────────────────────
// Real-time listener for missed calls count.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export function useMissedCalls(userId: string | null): {
  missedCount: number;
  loading: boolean;
} {
  const [missedCount, setMissedCount] = useState(0);
  const [loading,     setLoading]     = useState(true);
  const backend = useBackend('calls');

  useEffect(() => {
    if (!userId) { setMissedCount(0); setLoading(false); return; }
    setLoading(true);

    if (backend) {
      let active = true;
      const load = async () => {
        const res = await endpoints.callHistory({ limit: 100 });
        if (!active) return;
        if (res.ok) {
          setMissedCount(
            res.data.items.filter((i) => i.direction === 'incoming' && i.status === 'missed').length,
          );
        }
        setLoading(false);
      };
      void socketClient.connect().then(load).catch(() => load());
      const unsub = socketClient.subscribe('call:missed', () => void load());
      return () => { active = false; unsub(); };
    }

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
  }, [userId, backend]);

  return { missedCount, loading };
}
