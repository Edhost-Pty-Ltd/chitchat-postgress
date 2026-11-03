// ─── useUnviewedStatus Hook ───────────────────────────────────────────────────
// Counts unviewed contact statuses for the bottom-nav badge via the backend.
//
// Perf: the count is seeded from GET /statuses, then refreshed only when a peer
// posts/updates a status (status:update). The status:viewed event is NOT
// subscribed here — it fires on the status OWNER's device when someone views
// their status, which never changes this user's count of unviewed CONTACT
// statuses. Bursts of status:update collapse into a single debounced refetch.

import { useState, useEffect, useRef, useCallback } from 'react';
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
  const activeRef = useRef(true);
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await endpoints.listStatuses();
    if (!activeRef.current) return;
    if (res.ok) {
      const count = res.data.contactStatuses.filter((g) => g.hasUnviewed).length;
      setUnviewedCount(count);
      setHasUnviewedStatus(count > 0);
    }
    setLoading(false);
  }, []);

  const scheduleResync = useCallback(() => {
    if (resyncTimer.current) return;
    resyncTimer.current = setTimeout(() => {
      resyncTimer.current = null;
      void load();
    }, 500);
  }, [load]);

  useEffect(() => {
    activeRef.current = true;
    if (!userId) { setHasUnviewedStatus(false); setUnviewedCount(0); setLoading(false); return; }

    void socketClient.connect().then(load).catch(() => { if (activeRef.current) setLoading(false); });
    const unsubs = [
      socketClient.subscribe('status:update', scheduleResync),
      socketClient.subscribe('client:reconnect', () => void load()),
    ];

    return () => {
      activeRef.current = false;
      if (resyncTimer.current) { clearTimeout(resyncTimer.current); resyncTimer.current = null; }
      unsubs.forEach((u) => u());
    };
  }, [userId, load, scheduleResync]);

  return { hasUnviewedStatus, unviewedCount, loading };
}
