// ─── useChats Hook ────────────────────────────────────────────────────────────
// Real-time listener for the current user's chat list.
// Each chat shows the last message, timestamp, and unread count.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';

export interface ChatPreview {
  chatId:       string;
  type:         'direct' | 'group';
  members:      string[];
  groupName:    string | null;
  lastMessage:  string;
  lastSenderId: string;
  timestamp:    Date | null;
  unreadCount:  number;
}

export function useChats(userId: string | null) {
  const [chats,   setChats]   = useState<ChatPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!userId) {
      setChats([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    console.log('[useChats] Subscribing for userId:', userId);

    const unsub = (db as ReturnType<typeof firestore>)
      .collection('chats')
      .where('members', 'array-contains', userId)
      .onSnapshot(
        (snap) => {
          console.log('[useChats] Snapshot received, docs:', snap.docs.length);
          const result: ChatPreview[] = snap.docs.map((doc) => {
            const d = doc.data();
            const lm = d.lastMessage;
            return {
              chatId:       doc.id,
              type:         d.type ?? 'direct',
              members:      d.members ?? [],
              groupName:    d.groupName ?? null,
              lastMessage:  lm?.text ?? '',
              lastSenderId: lm?.senderId ?? '',
              timestamp:    lm?.timestamp
                ? (lm.timestamp as firestore.Timestamp).toDate()
                : null,
              unreadCount: getUnreadCount(d.unreadCounts, userId),
            };
          });
          setChats(result);
          setLoading(false);
        },
        (err) => {
          console.error('[useChats] Error:', err.code, err.message);
          setError(err.message);
          setLoading(false);
        },
      );

    return () => unsub();
  }, [userId]);

  return { chats, loading, error };
}

function getUnreadCount(
  unreadCounts: Record<string, number> | undefined,
  userId: string,
): number {
  if (!unreadCounts) return 0;
  return unreadCounts[userId] ?? 0;
}
