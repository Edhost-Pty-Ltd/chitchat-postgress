// ─── useChats Hook ────────────────────────────────────────────────────────────
// Real-time chat list via backend REST + Socket.IO events.

import { useState, useEffect } from 'react';
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

  useEffect(() => {
    if (!userId) { setChats([]); setLoading(false); return; }
    setLoading(true);
    let active = true;

    const load = async () => {
      const res = await endpoints.listChats();
      if (!active) return;
      if (res.ok) {
        setChats(
          res.data.chats.map((c) => ({
            chatId:       c.chatId,
            type:         c.type,
            members:      c.members,
            groupName:    c.groupName,
            lastMessage:  c.lastMessage ?? '',
            lastSenderId: c.lastSenderId ?? '',
            timestamp:    c.lastMessageAt ? new Date(c.lastMessageAt) : null,
            unreadCount:  c.unreadCount,
          })),
        );
      } else {
        setError(String(res.error.code));
      }
      setLoading(false);
    };

    void socketClient.connect().then(load).catch(() => load());
    const unsubs = [
      socketClient.subscribe('message:new',  () => void load()),
      socketClient.subscribe('message:read', () => void load()),
      socketClient.subscribe('chat:updated', () => void load()),
    ];
    return () => { active = false; unsubs.forEach((u) => u()); };
  }, [userId]);

  const reload = () => {
    if (!userId) return;
    void endpoints.listChats().then((res) => {
      if (res.ok) {
        setChats(
          res.data.chats.map((c) => ({
            chatId:       c.chatId,
            type:         c.type,
            members:      c.members,
            groupName:    c.groupName,
            lastMessage:  c.lastMessage ?? '',
            lastSenderId: c.lastSenderId ?? '',
            timestamp:    c.lastMessageAt ? new Date(c.lastMessageAt) : null,
            unreadCount:  c.unreadCount,
          })),
        );
      }
    });
  };

  return { chats, loading, error, reload };
}
