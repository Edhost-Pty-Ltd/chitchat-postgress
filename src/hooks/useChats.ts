// ─── useChats Hook ────────────────────────────────────────────────────────────
// Real-time listener for the current user's chat list.
// Each chat shows the last message, timestamp, and unread count.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

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

  const backend = useBackend('messaging');

  useEffect(() => {
    if (!userId) {
      setChats([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    if (backend) {
      let active = true;
      const load = async () => {
        const res = await endpoints.listChats();
        if (!active) return;
        if (res.ok) {
          setChats(
            res.data.chats.map((c) => ({
              chatId: c.chatId,
              type: c.type,
              members: c.members,
              groupName: c.groupName,
              lastMessage: c.lastMessage ?? '',
              lastSenderId: c.lastSenderId ?? '',
              timestamp: c.lastMessageAt ? new Date(c.lastMessageAt) : null,
              unreadCount: c.unreadCount,
            })),
          );
        } else {
          setError(String(res.error.code));
        }
        setLoading(false);
      };

      void socketClient.connect().then(load).catch(() => load());
      // Refresh the list on any delivery/read/new-message/chat-update event.
      const unsubs = [
        socketClient.subscribe('message:new', () => void load()),
        socketClient.subscribe('message:read', () => void load()),
        socketClient.subscribe('chat:updated', () => void load()),
      ];
      return () => {
        active = false;
        unsubs.forEach((u) => u());
      };
    }

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
  }, [userId, backend]);

  return { chats, loading, error };
}

function getUnreadCount(
  unreadCounts: Record<string, number> | undefined,
  userId: string,
): number {
  if (!unreadCounts) return 0;
  return unreadCounts[userId] ?? 0;
}
