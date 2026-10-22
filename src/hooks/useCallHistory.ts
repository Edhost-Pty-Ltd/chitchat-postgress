// ─── Hook: Call History ──────────────────────────────────────────────────────
import { useState, useEffect } from 'react';
import type { CallHistoryItem } from '../types/call';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export function useCallHistory(userId: string | null) {
  const [callHistory, setCallHistory] = useState<CallHistoryItem[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setCallHistory([]); setLoading(false); return; }

    setLoading(true); setError(null);
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
    const unsub = socketClient.subscribe('call:missed', () => void load());
    return () => { active = false; unsub(); };
  }, [userId]);

  return { callHistory, loading, error };
}
