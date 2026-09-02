// ─── useUnreadCount Hook ──────────────────────────────────────────────────────
// Real-time listener for total unread message count across all chats.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

export function useUnreadCount(userId: string | null): {
  totalUnread: number;
  unreadByChat: Map<string, number>;
  loading: boolean;
} {
  const [totalUnread,  setTotalUnread]  = useState(0);
  const [unreadByChat, setUnreadByChat] = useState<Map<string, number>>(new Map());
  const [loading,      setLoading]      = useState(true);

  useEffect(() => {
    if (!userId) {
      setTotalUnread(0);
      setUnreadByChat(new Map());
      setLoading(false);
      return;
    }

    setLoading(true);
    const fsDb = db as ReturnType<typeof firestore>;

    const unsub = fsDb
      .collection('chats')
      .where('members', 'array-contains', userId)
      .onSnapshot(
        (snapshot) => {
          let total = 0;
          const chatMap = new Map<string, number>();

          snapshot.docs.forEach((doc) => {
            const unreadCounts = doc.data().unreadCounts || {};
            const count = unreadCounts[userId] || 0;
            if (count > 0) { chatMap.set(doc.id, count); total += count; }
          });

          setUnreadByChat(chatMap);
          setTotalUnread(total);
          setLoading(false);
        },
        (error) => {
          console.error('[useUnreadCount] Error:', error);
          setLoading(false);
        },
      );

    return () => unsub();
  }, [userId]);

  return { totalUnread, unreadByChat, loading };
}
