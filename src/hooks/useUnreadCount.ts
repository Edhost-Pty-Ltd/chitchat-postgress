// ─── useUnreadCount Hook ──────────────────────────────────────────────────────
// Real-time unread message counts via the backend REST + socket path.
// Fetches totals from GET /chats on mount and refreshes on any message or read
// socket event, matching the shape previously sourced from Firestore.

import { useState, useEffect, useRef } from 'react';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export function useUnreadCount(userId: string | null): {
  totalUnread: number;
  unreadByChat: Map<string, number>;
  loading: boolean;
} {
  const [totalUnread,  setTotalUnread]  = useState(0);
  const [unreadByChat, setUnreadByChat] = useState<Map<string, number>>(new Map());
  const [loading,      setLoading]      = useState(true);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;

    if (!userId) {
      setTotalUnread(0);
      setUnreadByChat(new Map());
      setLoading(false);
      return;
    }

    async function load() {
      const res = await endpoints.listChats();
      if (!activeRef.current) return;

      if (!res.ok) {
        setLoading(false);
        return;
      }

      const map = new Map<string, number>();
      let total = res.data.totalUnread;
      for (const chat of res.data.chats) {
        const count = chat.unreadCount ?? 0;
        if (count > 0) map.set(chat.chatId, count);
      }
      setUnreadByChat(map);
      setTotalUnread(total);
      setLoading(false);
    }

    void socketClient.connect().then(load).catch(() => { if (activeRef.current) setLoading(false); });

    // Refresh on any delivery/read/new-message event.
    // `client:read` is a synthetic local event fired by markAsRead in useMessages
    // when the user opens a chat — the server doesn't echo read receipts back to
    // the reader, so without this the badge would stay stale until the next
    // message:new triggers a re-fetch.
    const unsubs = [
      socketClient.subscribe('message:new',  () => void load()),
      socketClient.subscribe('message:read', () => void load()),
      socketClient.subscribe('message:delivered', () => void load()),
      socketClient.subscribe('client:read',  () => void load()),
    ];

    return () => {
      activeRef.current = false;
      unsubs.forEach((u) => u());
    };
  }, [userId]);

  return { totalUnread, unreadByChat, loading };
}
