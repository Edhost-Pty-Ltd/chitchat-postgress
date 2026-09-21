// ─── useTypingIndicator ───────────────────────────────────────────────────────
// Writes the current user's typing presence and listens for others typing.

import { useEffect, useRef, useCallback, useState } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

const STOP_TYPING_DELAY_MS = 5_000;
const STALE_THRESHOLD_MS   = 6_000;

export interface TypingUser { userId: string; }

export function useTypingIndicator(chatId: string | null, userId: string | null) {
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fsDb = () => db as ReturnType<typeof firestore>;

  // Listen for remote typing
  useEffect(() => {
    if (!chatId || !userId) return;

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
  }, [chatId, userId]);

  const setTyping = useCallback(
    async (isTyping: boolean) => {
      if (!chatId || !userId) return;
      if (stopTimer.current) { clearTimeout(stopTimer.current); stopTimer.current = null; }

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
        fsDb().collection('chats').doc(chatId)
          .update({ [`typing.${userId}`]: firestore.FieldValue.delete() })
          .catch(() => {});
      }
    };
  }, [chatId, userId]);

  return { typingUsers, setTyping };
}
