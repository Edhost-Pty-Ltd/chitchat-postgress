// ─── Hook: Call History ──────────────────────────────────────────────────────
import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import type { CallHistoryItem } from '../types/call';

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

export function useCallHistory(userId: string | null) {
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setCallHistory([]); setLoading(false); return; }

    console.log('[useCallHistory] Setting up listener for user:', userId);
    setLoading(true); setError(null);

    const fsDb = db as ReturnType<typeof firestore>;

    const unsub = fsDb
      .collection('users').doc(userId).collection('callHistory')
      .orderBy('timestamp', 'desc')
      .onSnapshot(
        (snapshot) => {
          const history: CallHistoryItem[] = snapshot.docs.map((doc) => {
            const data = doc.data();
            return {
              callId:     data.callId,
              otherParty: data.otherParty,
              type:       data.type,
              direction:  data.direction,
              status:     data.status,
              duration:   data.duration ?? null,
              timestamp:  toDate(data.timestamp),
            };
          });
          console.log('[useCallHistory] Loaded', history.length, 'calls');
          setCallHistory(history);
          setLoading(false);
        },
        (err) => {
          console.error('[useCallHistory] Error:', err);
          setError(err.message);
          setLoading(false);
        },
      );

    return () => { console.log('[useCallHistory] Cleaning up listener'); unsub(); };
  }, [userId]);

  return { callHistory, loading, error };
}
