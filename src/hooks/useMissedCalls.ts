// ─── useMissedCalls Hook ──────────────────────────────────────────────────────
import { useState, useEffect } from 'react';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

// Lightweight local pub/sub so opening the Calls screen (which marks calls
// seen on the server) can tell every mounted badge to re-fetch immediately,
// instead of waiting for the next screen mount or socket event.
const seenListeners = new Set<() => void>();

/** Tell all mounted useMissedCalls instances to reload (call after markCallsSeen). */
export function notifyCallsSeen(): void {
  seenListeners.forEach((l) => l());
}

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
        // Badge = incoming calls I missed and haven't seen yet. Outgoing
        // 'no_answer' rows (my own unanswered calls) never count.
        setMissedCount(
          res.data.items.filter(
            (i) => i.direction === 'incoming' && i.status === 'missed' && !i.seen,
          ).length,
        );
      }
      setLoading(false);
    };

    void socketClient.connect().then(load).catch(() => load());
    const unsub = socketClient.subscribe('call:missed', () => void load());
    const reload = () => void load();
    seenListeners.add(reload);
    return () => { active = false; unsub(); seenListeners.delete(reload); };
  }, [userId]);

  return { missedCount, loading };
}
