// ─── Hook: Call History ──────────────────────────────────────────────────────
import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import type { CallHistoryItem } from '../types/call';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

export function useCallHistory(userId: string | null) {
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string | null>(null);

  const backend = useBackend('calls');

  useEffect(() => {
    if (!userId) { setCallHistory([]); setLoading(false); return; }

    console.log('[useCallHistory] Setting up listener for user:', userId);
    setLoading(true); setError(null);

    if (backend) {
      let active = true;
      const load = async () => {
        const res = await endpoints.callHistory({ limit: 100 });
        if (!active) return;
        if (res.ok) {
          setCallHistory(
            res.data.items.map((i) => ({
              callId: i.callId,
              otherParty: i.otherParty,
              type: i.type,
              direction: i.direction,
              status: i.status as CallHistoryItem['status'],
              duration: i.durationSec,
              timestamp: new Date(i.timestamp),
            })),
          );
        } else {
          setError(String(res.error.code));
        }
        setLoading(false);
      };
      void socketClient.connect().then(load).catch(() => load());
      // Refresh on a missed-call badge event (Req 8.13).
      const unsub = socketClient.subscribe('call:missed', () => void load());
      return () => { active = false; unsub(); };
    }

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
  }, [userId, backend]);

  return { callHistory, loading, error };
}
