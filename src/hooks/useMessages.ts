// ─── useMessages Hook ─────────────────────────────────────────────────────────
// Real-time messages for a single chat via backend REST + Socket.IO.

import { useState, useEffect } from 'react';
import { loadLocalMessages, mergeLocalMessages } from './useLocalMessages';
import { CatalogItem } from '../types';
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
  edited?:   boolean;
  editedAt?: Date | null;
}

function toDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

function backendToFireMessage(m: BackendMessage): FireMessage {
  const mediaKey = m.mediaObjectKey;
  return {
    messageId:    m.id,
    senderId:     m.senderId,
    text:         m.text,
    imageUrl:     m.type === 'image' ? mediaKey : null,
    voiceUrl:     m.type === 'voice' ? mediaKey : null,
    videoUrl:     m.type === 'video' ? mediaKey : null,
    fileUrl:      m.type === 'file'  ? mediaKey : null,
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
    edited:       m.edited,
    editedAt:     m.editedAt ? new Date(m.editedAt) : null,
  };
}

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
  for (const m of messages) {
    // Only replace if we got a real https URL back — leave null rather than
    // keeping an unresolvable object key that would silently fail to render.
    const resolve = (v: string | null) => {
      if (!v) return null;
      if (/^https?:/.test(v)) return v;          // already a URL, keep it
      return resolved[v] ?? null;                 // resolved → use it; missing → null
    };
    m.imageUrl     = resolve(m.imageUrl);
    m.voiceUrl     = resolve(m.voiceUrl);
    m.videoUrl     = resolve(m.videoUrl);
    m.fileUrl      = resolve(m.fileUrl);
    m.thumbnailUrl = resolve(m.thumbnailUrl);
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

  useEffect(() => {
    if (!chatId) return;
    setLoading(true);
    let active = true;

    const applyAndAck = (list: FireMessage[]) => {
      if (!active) return;
      setMessages(list);
      setLoading(false);
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
      if (!active) return;
      if (!res.ok) { setError(String(res.error.code)); setLoading(false); return; }
      const mapped = res.data.messages.map(backendToFireMessage).reverse();
      await resolveMessageMedia(mapped).catch(() => {});
      mergeLocalMessages(chatId, mapped).catch(() => {});
      applyAndAck(mapped);
    };

    void socketClient.connect().then(() => {
      socketClient.joinChat(chatId);
      return load();
    }).catch(() => load());

    // On message:new, splice the incoming message directly into state for
    // instant display, then do a background reconcile to sync receipts/order.
    const handleMessageNew = (p: any) => {
      if (p?.message?.chatId !== chatId) return;
      const incoming: FireMessage = backendToFireMessage(p.message as BackendMessage);
      // Resolve any media keys to signed URLs before inserting into state,
      // so images/voice/video display immediately without waiting for load().
      resolveMessageMedia([incoming]).catch(() => {}).finally(() => {
        setMessages((prev) => {
          const withoutOptimistic = prev.filter(
            (m) => m.messageId !== incoming.messageId && m.messageId !== p.message.clientId,
          );
          return [...withoutOptimistic, incoming];
        });
      });
      void load(); // background reconcile for read receipts / ordering
    };

    const unsubs = [
      socketClient.subscribe('message:new',     handleMessageNew),
      socketClient.subscribe('message:read',    (p: any) => { if (p?.chatId === chatId) void load(); }),
      socketClient.subscribe('message:deleted', (p: any) => { if (p?.chatId === chatId) void load(); }),
      socketClient.subscribe('message:edited',  (p: any) => { if (p?.chatId === chatId) void load(); }),
      socketClient.subscribe('client:reconnect', () => void load()),
    ];

    return () => {
      active = false;
      socketClient.leaveChat(chatId);
      unsubs.forEach((u) => u());
    };
  }, [chatId, currentUserId]);

  async function sendMessage(text: string): Promise<boolean> {
    if (!chatId || !currentUserId || !text.trim()) return false;

    // ── Optimistic update ─────────────────────────────────────────────────
    // Show the message immediately; the server echo will replace it with the
    // real message (deduped by clientId) once the socket event arrives.
    const clientId = `${currentUserId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: FireMessage = {
      messageId:    clientId,
      senderId:     currentUserId,
      text:         text.trim(),
      imageUrl:     null,
      voiceUrl:     null,
      videoUrl:     null,
      fileUrl:      null,
      type:         'text',
      timestamp:    new Date(),
      expiresAt:    null,
      readBy:       [],
      deliveredTo:  [],
      duration:     null,
      fileName:     null,
      fileSize:     null,
      mimeType:     null,
      thumbnailUrl: null,
      edited:       false,
      editedAt:     null,
      replyTo:      null,
    };
    setMessages((prev) => [...prev, optimistic]);

    const res = await endpoints.sendMessage(chatId, {
      type: 'text',
      text: text.trim(),
      clientId,
    });

    if (!res.ok) {
      // Roll back the optimistic entry on failure.
      setMessages((prev) => prev.filter((m) => m.messageId !== clientId));
      setError(res.error.message);
      return false;
    }
    // Server will broadcast message:new → handleMessageNew replaces optimistic entry.
    return true;
  }

  /**
   * Add an optimistic media bubble immediately (e.g. using the local file URI
   * as imageUrl) so the sender sees their image before the upload completes.
   * Returns the temporary clientId so the caller can remove it on failure.
   */
  function addOptimisticMedia(
    type: 'image' | 'video' | 'voice',
    localUri: string,
    extra?: Partial<FireMessage>,
  ): string {
    if (!currentUserId) return '';
    const clientId = `${currentUserId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: FireMessage = {
      messageId:    clientId,
      senderId:     currentUserId,
      text:         null,
      imageUrl:     type === 'image' ? localUri : null,
      voiceUrl:     type === 'voice' ? localUri : null,
      videoUrl:     type === 'video' ? localUri : null,
      fileUrl:      null,
      type,
      timestamp:    new Date(),
      expiresAt:    null,
      readBy:       [],
      deliveredTo:  [],
      duration:     extra?.duration ?? null,
      fileName:     null,
      fileSize:     null,
      mimeType:     null,
      thumbnailUrl: extra?.thumbnailUrl ?? null,
      edited:       false,
      editedAt:     null,
      replyTo:      null,
      ...extra,
    };
    setMessages((prev) => [...prev, optimistic]);
    return clientId;
  }

  function removeOptimistic(clientId: string): void {
    setMessages((prev) => prev.filter((m) => m.messageId !== clientId));
  }

  return { messages, loading, error, sendMessage, addOptimisticMedia, removeOptimistic };
}
