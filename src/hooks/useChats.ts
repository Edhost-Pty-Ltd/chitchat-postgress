// ─── useChats Hook ────────────────────────────────────────────────────────────
// Real-time chat list via backend REST + Socket.IO events.
//
// Perf: the initial list comes from GET /chats. Live updates are applied
// INCREMENTALLY from socket events rather than re-fetching the whole list on
// every message — a single inbound message updates only the affected chat row
// in place (preview, timestamp, unread) and re-sorts. A full refetch is kept
// only for low-frequency structural changes (chat:updated) and reconnects.

import { useState, useEffect, useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

/** Short text preview for a message pushed over the socket. */
function previewText(m: { type?: string; text?: string | null }): string {
  if (m.text) return m.text;
  switch (m.type) {
    case 'image':    return '📷 Photo';
    case 'video':    return '🎥 Video';
    case 'voice':    return '🎤 Voice message';
    case 'file':     return '📎 File';
    case 'location': return '📍 Location';
    case 'contact':  return '👤 Contact';
    case 'poll':     return '📊 Poll';
    case 'order':    return '🛒 Order';
    case 'catalog':  return '🛍️ Product';
    default:         return '';
  }
}

function mapChat(c: {
  chatId: string; type: 'direct' | 'group'; members: string[];
  groupName: string | null; lastMessage?: string | null;
  lastSenderId?: string | null; lastMessageAt?: string | null; unreadCount: number;
}): ChatPreview {
  return {
    chatId:       c.chatId,
    type:         c.type,
    members:      c.members,
    groupName:    c.groupName,
    lastMessage:  c.lastMessage ?? '',
    lastSenderId: c.lastSenderId ?? '',
    timestamp:    c.lastMessageAt ? new Date(c.lastMessageAt) : null,
    unreadCount:  c.unreadCount,
  };
}

/** Sort newest-activity-first, chats with no activity last. */
function sortByRecent(list: ChatPreview[]): ChatPreview[] {
  return [...list].sort((a, b) => {
    const at = a.timestamp ? a.timestamp.getTime() : 0;
    const bt = b.timestamp ? b.timestamp.getTime() : 0;
    return bt - at;
  });
}

// ── Local chat-list cache ─────────────────────────────────────────────────────
const CHATS_CACHE_KEY = (userId: string) => `local_chats_${userId}`;

async function saveChatsCache(userId: string, chats: ChatPreview[]): Promise<void> {
  try {
    const serialised = chats.map((c) => ({
      ...c,
      timestamp: c.timestamp ? c.timestamp.toISOString() : null,
    }));
    await AsyncStorage.setItem(CHATS_CACHE_KEY(userId), JSON.stringify(serialised));
  } catch {
    // Best-effort — never crash because of a cache write.
  }
}

async function loadChatsCache(userId: string): Promise<ChatPreview[]> {
  try {
    const raw = await AsyncStorage.getItem(CHATS_CACHE_KEY(userId));
    if (!raw) return [];
    const parsed: any[] = JSON.parse(raw);
    return parsed.map((c) => ({
      ...c,
      timestamp: c.timestamp ? new Date(c.timestamp) : null,
    }));
  } catch {
    return [];
  }
}

export function useChats(userId: string | null) {
  const [chats,   setChats]   = useState<ChatPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  // The chat the user is currently viewing — new messages there don't bump
  // its unread badge (they're being read live). Kept in a ref so socket
  // handlers see the latest value without re-subscribing.
  const activeChatRef = useRef<string | null>(null);
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;

  // Stable full-list fetch, used for the initial load, reconnects, and the
  // rare case where an event references a chat we don't have yet.
  const fetchAll = useCallback(async (): Promise<ChatPreview[] | null> => {
    const res = await endpoints.listChats();
    if (!res.ok) {
      setError(String(res.error.code));
      return null;
    }
    return res.data.chats.map(mapChat);
  }, []);

  useEffect(() => {
    if (!userId) { setChats([]); setLoading(false); return; }
    setLoading(true);
    let active = true;

    const loadAll = async () => {
      const mapped = await fetchAll();
      if (!active) { if (active) setLoading(false); return; }
      if (mapped) {
        const sorted = sortByRecent(mapped);
        setChats(sorted);
        void saveChatsCache(userId, sorted);
      }
      setLoading(false);
    };

    // Seed from local cache immediately so the list is visible while the
    // network request is in flight (or if the device is offline).
    loadChatsCache(userId).then((cached) => {
      if (!active || cached.length === 0) return;
      setChats(sortByRecent(cached));
      setLoading(false);
    });

    // Incremental: a new message updates only its chat row.
    const onNew = (payload: unknown) => {
      const message = (payload as { message?: {
        chatId?: string; senderId?: string; type?: string; text?: string | null; createdAt?: string;
      } })?.message;
      if (!message?.chatId) return;
      const { chatId, senderId, createdAt } = message;
      const fromMe = senderId === userIdRef.current;
      const isActive = chatId === activeChatRef.current;

      setChats((prev) => {
        const idx = prev.findIndex((c) => c.chatId === chatId);
        if (idx === -1) {
          // Unknown chat (e.g. first message of a brand-new conversation) —
          // fall back to a one-off full refetch to pick up members/metadata.
          void fetchAll().then((mapped) => { if (mapped) setChats(sortByRecent(mapped)); });
          return prev;
        }
        const next = [...prev];
        const existing = next[idx];
        next[idx] = {
          ...existing,
          lastMessage:  previewText(message),
          lastSenderId: senderId ?? existing.lastSenderId,
          timestamp:    createdAt ? new Date(createdAt) : new Date(),
          // Only bump unread for messages from others that aren't being read live.
          unreadCount:  fromMe || isActive ? existing.unreadCount : existing.unreadCount + 1,
        };
        return sortByRecent(next);
      });
    };

    void socketClient.connect().then(loadAll).catch(() => loadAll());
    const unsubs = [
      socketClient.subscribe('message:new', onNew),

      socketClient.subscribe('message:read', () => void loadAll()),
      // Structural changes (group rename, membership, leave) are infrequent and
      // change members/metadata — a refetch is the simplest correct response.
      socketClient.subscribe('chat:updated', () => void loadAll()),
      // After a dropped connection, resync fully so nothing missed is lost.
      socketClient.subscribe('client:reconnect', () => void loadAll()),
    ];
    return () => { active = false; unsubs.forEach((u) => u()); };
  }, [userId, fetchAll]);

  /** Mark a chat's unread as read locally (call when the user opens it). */
  const markChatRead = useCallback((chatId: string) => {
    setChats((prev) => {
      const idx = prev.findIndex((c) => c.chatId === chatId);
      if (idx === -1 || prev[idx].unreadCount === 0) return prev;
      const next = [...prev];
      next[idx] = { ...next[idx], unreadCount: 0 };
      return next;
    });
  }, []);

  /** Tell the hook which chat is open so its messages don't bump unread. */
  const setActiveChat = useCallback((chatId: string | null) => {
    activeChatRef.current = chatId;
    if (chatId) markChatRead(chatId);
  }, [markChatRead]);

  const reload = useCallback(() => {
    if (!userIdRef.current) return;
    void fetchAll().then((mapped) => {
      if (mapped) {
        const sorted = sortByRecent(mapped);
        setChats(sorted);
        void saveChatsCache(userIdRef.current!, sorted);
      }
    });
  }, [fetchAll]);

  return { chats, loading, error, reload, markChatRead, setActiveChat };
}
