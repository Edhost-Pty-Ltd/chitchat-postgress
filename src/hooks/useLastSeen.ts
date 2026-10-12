// ─── useLastSeen Hook ─────────────────────────────────────────────────────────
import { useState, useEffect } from 'react';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

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
    let active = true;

    void endpoints.getPresence(userId).then((res) => {
      if (!active) return;
      setLastSeen(res.ok && !res.data.online && res.data.lastSeen ? new Date(res.data.lastSeen) : null);
      setLoading(false);
    });

    const unsub = socketClient.subscribe('presence', (payload) => {
      const p = payload as { userId?: string; online?: boolean; lastSeen?: string | null };
      if (p?.userId !== userId) return;
      setLastSeen(p.online ? null : p.lastSeen ? new Date(p.lastSeen) : null);
    });

    return () => { active = false; unsub(); };
  }, [userId, viewerId]);

  return { lastSeen, loading };
}
