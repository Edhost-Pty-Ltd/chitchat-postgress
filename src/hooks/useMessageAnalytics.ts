// ─── useMessageAnalytics Hook ─────────────────────────────────────────────────
//
// Message delivery statistics for a business owner, served by the backend.
//
// Strategy:
//   • The server computes { sent, delivered, read } on demand from the
//     authoritative messages + message_receipts tables (GET /me/message-stats),
//     excluding blocked receipts. No client-side fan-out and no cached counter
//     document to keep in sync.
//   • The hook loads once on mount and exposes refreshStats() for pull-to-
//     refresh.

import { useState, useEffect, useCallback } from 'react';
import { endpoints } from '../api/endpoints';
import { MessageStats } from '../types';

export function useMessageAnalytics(ownerUid: string | null) {
  const [stats, setStats] = useState<MessageStats>({ sent: 0, delivered: 0, read: 0 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!ownerUid) {
      setStats({ sent: 0, delivered: 0, read: 0 });
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await endpoints.getMessageStats();
      if (res.ok) {
        setStats({
          sent: res.data.sent ?? 0,
          delivered: res.data.delivered ?? 0,
          read: res.data.read ?? 0,
          lastUpdatedAt: new Date(),
        });
      }
    } catch (err) {
      console.warn('[useMessageAnalytics] load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [ownerUid]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Trigger a fresh fetch (e.g. pull-to-refresh). Returns the latest stats. */
  const refreshStats = useCallback(async (): Promise<MessageStats> => {
    if (!ownerUid) return { sent: 0, delivered: 0, read: 0 };
    const res = await endpoints.getMessageStats();
    if (res.ok) {
      const next: MessageStats = {
        sent: res.data.sent ?? 0,
        delivered: res.data.delivered ?? 0,
        read: res.data.read ?? 0,
        lastUpdatedAt: new Date(),
      };
      setStats(next);
      return next;
    }
    return stats;
  }, [ownerUid, stats]);

  return { stats, loading, refreshStats };
}

// ─── Delivery rate helpers ────────────────────────────────────────────────────
export function deliveryRate(stats: MessageStats): number {
  if (!stats.sent) return 0;
  return Math.round((stats.delivered / stats.sent) * 100);
}

export function readRate(stats: MessageStats): number {
  if (!stats.sent) return 0;
  return Math.round((stats.read / stats.sent) * 100);
}
