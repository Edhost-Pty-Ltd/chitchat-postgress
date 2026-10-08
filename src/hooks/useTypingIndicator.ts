// ─── useTypingIndicator ───────────────────────────────────────────────────────
// Writes the current user's typing presence and listens for others typing.

import { useEffect, useRef, useCallback, useState } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { useBackend } from '../config/featureFlags';
import { socketClient } from '../realtime/socket';

const STOP_TYPING_DELAY_MS = 5_000;
const STALE_THRESHOLD_MS   = 6_000;

export interface TypingUser { userId: string; }

export function useTypingIndicator(chatId: string | null, userId: string | null) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const fsDb = () => db as ReturnType<typeof firestore>;
  const backend = useBackend('presence');

  // Listen for remote typing
  useEffect(() => {
    if (!chatId || !userId) return;

    if (backend) {
      const timers = clearTimers.current;
      const unsub = socketClient.subscribe('typing', (payload) => {
        const p = payload as { chatId?: string; userId?: string; isTyping?: boolean };
        if (p?.chatId !== chatId || !p.userId || p.userId === userId) return;

        // Clear any pending auto-expire for this user.
        const existing = timers.get(p.userId);
        if (existing) { clearTimeout(existing); timers.delete(p.userId); }

        if (p.isTyping) {
          setTypingUsers((prev) =>
            prev.some((u) => u.userId === p.userId) ? prev : [...prev, { userId: p.userId! }],
          );
          // Auto-clear after 5s of silence (Req 7.8).
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
    }

    const unsub = fsDb().collection('chats').doc(chatId).onSnapshot((snap) => {
      if (!snap.exists) return;
      const typing: Record<string, any> = snap.data()!.typing ?? {};
      const now = Date.now();

      const active: TypingUser[] = Object.entries(typing)
        .filter(([uid, ts]) => {
          if (uid === userId) return false;
          if (!ts?.toMillis) return false;
          return now - ts.toMillis() < STALE_THRESHOLD_MS;
        })
        .map(([uid]) => ({ userId: uid }));

      setTypingUsers(active);
    });

    return () => unsub();
  }, [chatId, userId, backend]);

  const setTyping = useCallback(
    async (isTyping: boolean) => {
      if (!chatId || !userId) return;
      if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }

      if (backend) {
        if (isTyping) {
          socketClient.emit('typing:start', { chatId });
          // Mirror the legacy auto-stop so a stale typer clears after 5s.
          stopTimer.current = setTimeout(() => {
            socketClient.emit('typing:stop', { chatId });
          }, STOP_TYPING_DELAY_MS);
        } else {
          socketClient.emit('typing:stop', { chatId });
        }
        return;
      }

      const chatRef = fsDb().collection('chats').doc(chatId);

      if (isTyping) {
        try {
          await chatRef.update({ [`typing.${userId}`]: firestore.FieldValue.serverTimestamp() });
        } catch { /* ignore */ }

        stopTimer.current = setTimeout(async () => {
          try {
            await chatRef.update({ [`typing.${userId}`]: firestore.FieldValue.delete() });
          } catch { /* ignore */ }
        }, STOP_TYPING_DELAY_MS);
      } else {
        try {
          await chatRef.update({ [`typing.${userId}`]: firestore.FieldValue.delete() });
        } catch { /* ignore */ }
      }
    },
    [chatId, userId],
  );

  // Clear own presence on unmount
  useEffect(() => {
    return () => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      if (chatId && userId) {
        if (backend) {
          socketClient.emit('typing:stop', { chatId });
        } else {
          fsDb().collection('chats').doc(chatId)
            .update({ [`typing.${userId}`]: firestore.FieldValue.delete() })
            .catch(() => {});
        }
      }
    };
  }, [chatId, userId, backend]);

  return { typingUsers, setTyping };
}
