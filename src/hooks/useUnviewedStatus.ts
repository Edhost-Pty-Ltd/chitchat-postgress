// ─── useUnviewedStatus Hook ───────────────────────────────────────────────────
// Counts unviewed contact statuses via the backend REST + socket events.

import { useState, useEffect } from 'react';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export function useUnviewedStatus(userId: string | null): {
  hasUnviewedStatus: boolean;
  unviewedCount:     number;
  loading:           boolean;
} {
  const [hasUnviewedStatus, setHasUnviewedStatus] = useState(false);
  const [unviewedCount,     setUnviewedCount]     = useState(0);
  const [loading,           setLoading]           = useState(true);

  useEffect(() => {
    if (!userId) { setHasUnviewedStatus(false); setUnviewedCount(0); setLoading(false); return; }

    let active = true;

    const load = async () => {
      const res = await endpoints.listStatuses();
      if (!active) return;
      if (res.ok) {
        const count = res.data.contactStatuses.filter((g) => g.hasUnviewed).length;
        setUnviewedCount(count);
        setHasUnviewedStatus(count > 0);
      }
      setLoading(false);
    };

    void socketClient.connect().then(load).catch(() => { if (active) setLoading(false); });
    const unsubs = [
      socketClient.subscribe('status:update', () => void load()),
      socketClient.subscribe('status:viewed', () => void load()),
    ];

    return () => { active = false; unsubs.forEach((u) => u()); };
  }, [userId]);

  return { hasUnviewedStatus, unviewedCount, loading };
}
