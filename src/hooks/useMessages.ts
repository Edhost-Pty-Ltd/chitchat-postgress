// ─── useMessages Hook ─────────────────────────────────────────────────────────
// Real-time listener for messages inside a single chat.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { fetchUserPrivacySettings } from './usePrivacySettings';
import { loadLocalMessages, mergeLocalMessages } from './useLocalMessages';
import { CatalogItem } from '../types';
import { useBackend } from '../config/featureFlags';
import { endpoints, type BackendMessage } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export interface FireMessage {
  messageId:    string;
  senderId:     string;
  text:         string | null;
  imageUrl:     string | null;
  voiceUrl:     string | null;
  videoUrl:     string | null;
  fileUrl:      string | null;
  type:         'text' | 'image' | 'voice' | 'video' | 'file' | 'location' | 'system' | 'catalog';
  timestamp:    Date | null;
  expiresAt:    Date | null;
  readBy:       string[];
  deliveredTo?: string[];
  duration:     number | null;
  fileName:     string | null;
  fileSize:     number | null;
  mimeType:     string | null;
  thumbnailUrl: string | null;
  blockedMessage?: boolean;
  // Catalog product card
  catalogItem?: CatalogItem | null;
  location?: {
    latitude: number; longitude: number; accuracy?: number;
    altitude?: number | null; altitudeAccuracy?: number | null;
    heading?: number | null; speed?: number | null; timestamp: number;
  } | null;
  isLiveLocation?: boolean;
  liveLocationExpiry?: Date | null;
  replyTo?: {
    messageId: string; senderId: string; text: string | null;
    type: 'text' | 'image' | 'voice' | 'video' | 'file' | 'location' | 'system' | 'catalog';
  } | null;
}

function toDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

/**
 * Map a backend message to the FireMessage shape the UI already consumes.
 * Media fields carry object keys on the backend path; Slice 6 resolves them to
 * presigned URLs via mediaService at render time.
 */
function backendToFireMessage(m: BackendMessage): FireMessage {
  const mediaKey = m.mediaObjectKey;
  return {
    messageId:    m.id,
    senderId:     m.senderId,
    text:         m.text,
    imageUrl:     m.type === 'image' ? mediaKey : null,
    voiceUrl:     m.type === 'voice' ? mediaKey : null,
    videoUrl:     m.type === 'video' ? mediaKey : null,
    fileUrl:      m.type === 'file' ? mediaKey : null,
    type:         m.type,
    timestamp:    toDate(m.createdAt),
    expiresAt:    toDate(m.expiresAt),
    readBy:       m.readBy,
    deliveredTo:  m.deliveredTo,
    duration:     m.durationMs,
    fileName:     m.fileName,
    fileSize:     m.fileSize,
    mimeType:     m.mimeType,
    thumbnailUrl: m.thumbnailObjectKey,
    blockedMessage: false,
    catalogItem:  (m.catalogItem as CatalogItem) ?? null,
    location:     (m.location as FireMessage['location']) ?? null,
    isLiveLocation: false,
    liveLocationExpiry: null,
    replyTo:      (m.replyTo as FireMessage['replyTo']) ?? null,
  };
}

/**
 * Replace media object keys on messages with short-lived presigned download
 * URLs so the UI can render/play them (Req 10.6). Mutates in place.
 */
async function resolveMessageMedia(messages: FireMessage[]): Promise<void> {
  const keys = new Set<string>();
  for (const m of messages) {
    for (const url of [m.imageUrl, m.voiceUrl, m.videoUrl, m.fileUrl, m.thumbnailUrl]) {
      if (url && !/^https?:/.test(url)) keys.add(url);
    }
  }
  if (keys.size === 0) return;
  const { mediaService } = await import('../services/mediaService');
  const resolved = await mediaService.getDownloadUrls(Array.from(keys));
  const map = (v: string | null) => (v && resolved[v] ? resolved[v] : v);
  for (const m of messages) {
    m.imageUrl = map(m.imageUrl);
    m.voiceUrl = map(m.voiceUrl);
    m.videoUrl = map(m.videoUrl);
    m.fileUrl = map(m.fileUrl);
    m.thumbnailUrl = map(m.thumbnailUrl ?? null);
  }
}

export function useMessages(chatId: string | null, currentUserId: string | null) {
  const [messages, setMessages] = useState<FireMessage[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  // Seed from local cache immediately
  useEffect(() => {
    if (!chatId) return;
    loadLocalMessages(chatId).then((cached) => {
      if (cached.length > 0) { setMessages(cached); setLoading(false); }
    });
  }, [chatId]);

  const backend = useBackend('messaging');
  const mediaBackend = useBackend('media');

  // Real-time listener
  useEffect(() => {
    if (!chatId) return;
    setLoading(true);

    if (backend) {
      let active = true;

      const applyAndAck = (list: FireMessage[]) => {
        if (!active) return;
        setMessages(list);
        setLoading(false);
        // Ack delivery + read for messages from others (Req 5.6, 5.7).
        if (currentUserId) {
          const incoming = list.filter((m) => m.senderId !== currentUserId);
          incoming.forEach((m) =>
            socketClient.emit('message:delivered', { chatId, messageId: m.messageId }),
          );
          const ids = incoming.map((m) => m.messageId);
          if (ids.length > 0) socketClient.emit('message:read', { chatId, messageIds: ids });
        }
      };

      const load = async () => {
        const res = await endpoints.listMessages(chatId, { limit: 50 });
        if (!res.ok) {
          setError(String(res.error.code));
          setLoading(false);
          return;
        }
        // Backend returns newest-first; UI expects ascending.
        const mapped = res.data.messages.map(backendToFireMessage).reverse();
        // Resolve media object keys to short-lived download URLs (Req 10.6).
        if (mediaBackend) {
          await resolveMessageMedia(mapped);
        }
        applyAndAck(mapped);
      };

      void socketClient.connect().then(() => {
        socketClient.joinChat(chatId);
        return load();
      }).catch(() => load());

      const unsubs = [
        socketClient.subscribe('message:new', (payload) => {
          const p = payload as { message?: BackendMessage };
          if (p?.message?.chatId === chatId) void load();
        }),
        socketClient.subscribe('message:read', (payload) => {
          const p = payload as { chatId?: string };
          if (p?.chatId === chatId) void load();
        }),
        socketClient.subscribe('message:deleted', (payload) => {
          const p = payload as { chatId?: string };
          if (p?.chatId === chatId) void load();
        }),
        // On reconnect, refetch to pick up messages missed while offline (Req 5.18).
        socketClient.subscribe('client:reconnect', () => void load()),
      ];

      return () => {
        active = false;
        socketClient.leaveChat(chatId);
        unsubs.forEach((u) => u());
      };
    }

    const fsDb = db as ReturnType<typeof firestore>;
    const unsub = fsDb
      .collection('chats').doc(chatId).collection('messages')
      .orderBy('timestamp', 'asc')
      .onSnapshot(
        (snap) => {
          const firestoreMsgs: FireMessage[] = snap.docs.map((doc) => {
            const d = doc.data();
            return {
              messageId:          doc.id,
              senderId:           d.senderId,
              text:               d.text       ?? null,
              imageUrl:           d.imageUrl   ?? null,
              voiceUrl:           d.voiceUrl   ?? null,
              videoUrl:           d.videoUrl   ?? null,
              fileUrl:            d.fileUrl    ?? null,
              type:               d.type       ?? 'text',
              timestamp:          toDate(d.timestamp),
              expiresAt:          toDate(d.expiresAt),
              readBy:             d.readBy     ?? [],
              deliveredTo:        d.deliveredTo ?? [],
              duration:           d.duration   ?? null,
              fileName:           d.fileName   ?? null,
              fileSize:           d.fileSize   ?? null,
              mimeType:           d.mimeType   ?? null,
              thumbnailUrl:       d.thumbnailUrl ?? null,
              blockedMessage:     d.blockedMessage ?? false,
              catalogItem:        d.catalogItem ?? null,
              location:           d.location   ?? null,
              isLiveLocation:     d.isLiveLocation ?? false,
              liveLocationExpiry: toDate(d.liveLocationExpiry),
              replyTo:            d.replyTo    ?? null,
            };
          });

          mergeLocalMessages(chatId, firestoreMsgs).catch(() => {});
          loadLocalMessages(chatId).then((merged) => {
            setMessages(merged);
            setLoading(false);
          });

          if (currentUserId) {
            fetchUserPrivacySettings(currentUserId).then((privacy) => {
              markAsRead(chatId, currentUserId, privacy.readReceipts);
            });
          }
        },
        (err) => { setError(err.message); setLoading(false); },
      );

    return () => unsub();
  }, [chatId, currentUserId, backend]);

  async function sendMessage(text: string): Promise<boolean> {
    if (!chatId || !currentUserId || !text.trim()) return false;

    if (backend) {
      const res = await endpoints.sendMessage(chatId, {
        type: 'text',
        text: text.trim(),
        clientId: `${currentUserId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
      if (!res.ok) { setError(res.error.message); return false; }
      return true;
    }

    try {
      const trimmed = text.trim();
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('chats').doc(chatId).collection('messages').add({
        senderId:    currentUserId,
        text:        trimmed,
        imageUrl:    null,
        voiceUrl:    null,
        type:        'text',
        timestamp:   firestore.FieldValue.serverTimestamp(),
        readBy:      [currentUserId],
        deliveredTo: [],
      });
      await fsDb.collection('chats').doc(chatId).update({
        'lastMessage.text':      trimmed,
        'lastMessage.senderId':  currentUserId,
        'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      });
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }

  return { messages, loading, error, sendMessage };
}

async function markAsRead(chatId: string, userId: string, readReceipts = true) {
  try {
    const fsDb = db as ReturnType<typeof firestore>;
    await fsDb.collection('chats').doc(chatId).update({
      [`unreadCounts.${userId}`]: 0,
    });

    if (!readReceipts) return;

    const snap = await fsDb
      .collection('chats').doc(chatId).collection('messages')
      .orderBy('timestamp', 'desc')
      .get();

    const batch = fsDb.batch();
    snap.docs.forEach((docSnap) => {
      const data = docSnap.data();
      const deliveredTo = data.deliveredTo || [];
      const readBy      = data.readBy      || [];
      if (data.senderId === userId) return;

      if (!deliveredTo.includes(userId)) {
        batch.update(docSnap.ref, {
          deliveredTo: firestore.FieldValue.arrayUnion(userId),
          readBy:      firestore.FieldValue.arrayUnion(userId),
        });
      } else if (!readBy.includes(userId)) {
        batch.update(docSnap.ref, {
          readBy: firestore.FieldValue.arrayUnion(userId),
        });
      }
    });
    await batch.commit();
  } catch (error) {
    console.warn('[useMessages] Error marking messages:', error);
  }
}
