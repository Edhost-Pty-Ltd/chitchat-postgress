// ─── useTypingIndicator ───────────────────────────────────────────────────────
// Writes current-user typing presence and listens for others via socket.

import { useEffect, useRef, useCallback, useState } from 'react';
import { socketClient } from '../realtime/socket';

const STOP_TYPING_DELAY_MS = 5_000;

export interface TypingUser { userId: string; }

export function useTypingIndicator(chatId: string | null, userId: string | null) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const stopTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers  = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Listen for remote typing events
  useEffect(() => {
    if (!chatId || !userId) return;
    const timers = clearTimers.current;

    const unsub = socketClient.subscribe('typing', (payload) => {
      const p = payload as { chatId?: string; userId?: string; isTyping?: boolean };
      if (p?.chatId !== chatId || !p.userId || p.userId === userId) return;

      const existing = timers.get(p.userId);
      if (existing) { clearTimeout(existing); timers.delete(p.userId); }

      if (p.isTyping) {
        setTypingUsers((prev) =>
          prev.some((u) => u.userId === p.userId) ? prev : [...prev, { userId: p.userId! }],
        );
        const t = setTimeout(() => {
          setTypingUsers((prev) => prev.filter((u) => u.userId !== p.userId));
          timers.delete(p.userId!);
        }, STOP_TYPING_DELAY_MS);
        timers.set(p.userId, t);
      } else {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== p.userId));
      }
    });

    return () => {
      unsub();
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      setTypingUsers([]);
    };
  }, [chatId, userId]);

  const setTyping = useCallback(
    async (isTyping: boolean) => {
      if (!chatId || !userId) return;
      if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }

      if (isTyping) {
        socketClient.emit('typing:start', { chatId });
        stopTimer.current = setTimeout(() => {
          socketClient.emit('typing:stop', { chatId });
        }, STOP_TYPING_DELAY_MS);
      } else {
        socketClient.emit('typing:stop', { chatId });
      }
    },
    [chatId, userId],
  );

  // Clear own presence on unmount
  useEffect(() => {
    return () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      if (chatId && userId) socketClient.emit('typing:stop', { chatId });
    };
  }, [chatId, userId]);

  return { typingUsers, setTyping };
}
