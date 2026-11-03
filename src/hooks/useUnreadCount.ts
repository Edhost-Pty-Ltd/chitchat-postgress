// ─── useUnreadCount Hook ──────────────────────────────────────────────────────
// App-wide unread totals for the bottom-nav badge, via the backend REST + socket
// path. The total is seeded from GET /chats once, then kept live INCREMENTALLY:
// an inbound message from someone else bumps the total immediately, while read
// receipts trigger a debounced resync (bursts collapse into one refetch) so the
// badge stays accurate without a full /chats fetch on every single event.

import { useState, useEffect, useRef, useCallback } from 'react';
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
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;
  const resyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const res = await endpoints.listChats();
    if (!activeRef.current) return;
    if (!res.ok) { setLoading(false); return; }
    const map = new Map<string, number>();
    for (const chat of res.data.chats) {
      const count = chat.unreadCount ?? 0;
      if (count > 0) map.set(chat.chatId, count);
    }
    setUnreadByChat(map);
    setTotalUnread(res.data.totalUnread);
    setLoading(false);
  }, []);

  // Collapse bursts of read/delivery events into a single refetch.
  const scheduleResync = useCallback(() => {
    if (resyncTimer.current) return;
    resyncTimer.current = setTimeout(() => {
      resyncTimer.current = null;
      void load();
    }, 400);
  }, [load]);

  useEffect(() => {
    activeRef.current = true;

    if (!userId) {
      setTotalUnread(0);
      setUnreadByChat(new Map());
      setLoading(false);
      return;
    }

    // Inbound message from another user → bump immediately (no network).
    const onNew = (payload: unknown) => {
      const message = (payload as { message?: { id?: string; chatId?: string; senderId?: string } })?.message;
      if (!message?.chatId || message.senderId === userIdRef.current) return;
      const { chatId } = message;
      // Acknowledge delivery for any inbound message, even when the recipient
      // isn't viewing that chat. This advances the sender's tick to the grey
      // double-tick ("delivered"). Reads are emitted separately from the open
      // chat screen (useMessages) and turn the tick blue.
      if (message.id) {
        socketClient.emit('message:delivered', { chatId, messageId: message.id });
      }
      setUnreadByChat((prev) => {
        const next = new Map(prev);
        next.set(chatId, (next.get(chatId) ?? 0) + 1);
        return next;
      });
      setTotalUnread((t) => t + 1);
    };

    void socketClient.connect().then(load).catch(() => { if (activeRef.current) setLoading(false); });

    // Refresh on any delivery/read/new-message event.
    const unsubs = [
      socketClient.subscribe('message:new', onNew),
      // Reads/deliveries change counts on the reader's side; resync debounced.
      socketClient.subscribe('message:read', scheduleResync),
      socketClient.subscribe('message:delivered', scheduleResync),
      socketClient.subscribe('client:reconnect', () => void load()),
    ];

    return () => {
      activeRef.current = false;
      if (resyncTimer.current) { clearTimeout(resyncTimer.current); resyncTimer.current = null; }
      unsubs.forEach((u) => u());
    };
  }, [userId, load, scheduleResync]);

  return { totalUnread, unreadByChat, loading };
}
