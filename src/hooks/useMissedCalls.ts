// ─── useMissedCalls Hook ──────────────────────────────────────────────────────
import { useState, useEffect } from 'react';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export function useMissedCalls(userId: string | null): {
  missedCount: number;
  loading: boolean;
} {
  const [missedCount, setMissedCount] = useState(0);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    if (!userId) { setMissedCount(0); setLoading(false); return; }
    setLoading(true);
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
  }, [userId]);

  return { missedCount, loading };
}
