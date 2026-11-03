// ─── useMessages Hook ─────────────────────────────────────────────────────────
// Real-time messages for a single chat, backed by the REST API (initial load)
// and Socket.IO (live updates). Media is stored as object keys; this hook
// resolves them to short-lived download URLs via mediaService so the UI keeps
// working with plain URL fields on FireMessage.
//
// COMPANION NOTE
//   `ownerUid` is the account whose chats we're reading. On the primary device
//   it equals the Firebase Auth uid; on a companion it's the owner's uid.
//   Reads/sends are attributed to `ownerUid` (the backend derives the sender
//   from the authenticated identity, which is the owner's uid on both).

import { useState, useEffect, useCallback, useRef } from 'react';
import { endpoints } from '../api/endpoints';
import type { BackendMessage, ContactPayload } from '../api/endpoints';
import { socketClient } from '../realtime/socket';
import { mediaService } from '../services/mediaService';
import { fetchUserPrivacySettings } from './usePrivacySettings';
import {
  loadLocalMessages, mergeLocalMessages, clearLocalMessages, removeLocalMessage,
  updateLocalMessage, loadDeletedIds, addDeletedIds, clearDeletedIds,
} from './useLocalMessages';
import { CatalogItem } from '../types';

export interface FireMessage {
  messageId:    string;
  /** Stable client-generated id used to reconcile optimistic sends. */
  clientId?:    string | null;
  senderId:     string;
  text:         string | null;
  imageUrl:     string | null;
  voiceUrl:     string | null;
  videoUrl:     string | null;
  fileUrl:      string | null;
  type:         'text' | 'image' | 'voice' | 'video' | 'file' | 'location' | 'system' | 'catalog' | 'order' | 'contact' | 'poll' | 'meeting';
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
  /** Client-only fields for an image/video that is preparing or uploading. */
  localMediaUri?: string | null;
  uploadStatus?: 'preparing' | 'uploading' | 'sending' | 'failed';
  uploadProgress?: number;
  uploadBytesSent?: number;
  uploadBytesTotal?: number;
  uploadError?: string | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  // Catalog product card
  catalogItem?: CatalogItem | null;
  // Order card (cart checkout) — line items + total
  order?: {
    items: { id: string; name: string; price: string; imageUri: string | null; quantity: number }[];
    total: string | null;
    currency: string;
  } | null;
  // Shared contact card
  contact?: {
    name: string;        // the sender's saved name for this contact
    phone: string;       // E.164
    userId: string | null;   // ChitChat UID when registered, else null
    registered: boolean;     // true if this contact uses ChitChatBusiness
    photoURL: string | null;
    // When multiple contacts were shared at once, the full list lives here.
    // The top-level fields above mirror the first entry for previews/fallbacks.
    contacts?: {
      name: string; phone: string; userId: string | null;
      registered: boolean; photoURL: string | null;
    }[];
  } | null;
  // Poll
  poll?: {
    question: string;
    options: { id: string; text: string }[];
    votes: Record<string, string[]>; // optionId -> array of voter UIDs
    multiple: boolean;
  } | null;
  // Meeting invite card
  meeting?: {
    meetingId: string;
    title: string;
    startsAt: string;
    endsAt: string;
    venue: 'online' | 'in-person';
    joinUrl: string;
    organizerName?: string | null;
    location?: {
      name: string | null;
      address: string | null;
      lat: number | null;
      lng: number | null;
    } | null;
  } | null;
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
  edited?:    boolean;
  editedAt?:  Date | null;
  forwarded?: boolean;
}

function toDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') return raw.toDate();
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// Describe an ApiError | NetworkError without touching ApiError-only fields.
function errText(error: { kind: 'api' | 'network'; message: string; code?: string }): string {
  return error.kind === 'api' ? (error.code ?? error.message) : error.message;
}

// ── Per-user "cleared at" cutoff ──────────────────────────────────────────────
// "Clear chat" is per user and server-side: POST /chats/:id/clear records the
// caller's cutoff, GET messages stops returning anything older to them, and the
// chat summary carries it as `clearedAt`. The server also emits `chat:cleared`
// { chatId, clearedAt } to the caller's devices. Only the local message cache
// (which also keeps messages past the server's TTL) needs pruning to match.

function parseMs(iso: string | null | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Sent at/before the cutoff. Undated (pending) messages are the newest: kept. */
function isClearedBy(m: FireMessage, cutoffMs: number): boolean {
  return cutoffMs > 0 && !!m.timestamp && m.timestamp.getTime() <= cutoffMs;
}

/** This user's cutoff for the chat, from the chat summary (0 if none/unknown). */
async function fetchClearedAt(chatId: string): Promise<number> {
  const res = await endpoints.listChats();
  if (!res.ok) return 0;
  return parseMs(res.data.chats.find((c) => c.chatId === chatId)?.clearedAt);
}

/** Drop cached messages the user has cleared (e.g. on another device). */
async function pruneLocalBefore(chatId: string, cutoffMs: number): Promise<void> {
  const cached = await loadLocalMessages(chatId);
  const kept = cached.filter((m) => !isClearedBy(m, cutoffMs));
  if (kept.length === cached.length) return;
  await clearLocalMessages(chatId);
  if (kept.length > 0) await mergeLocalMessages(chatId, kept);
}

// ── BackendMessage → FireMessage ──────────────────────────────────────────────
// Resolves object keys to download URLs using a prefetched key→url map so a
// batch of messages only needs one /media/download-url round-trip.

function collectObjectKeys(messages: BackendMessage[]): string[] {
  const keys = new Set<string>();
  for (const m of messages) {
    if (m.mediaObjectKey) keys.add(m.mediaObjectKey);
    if (m.thumbnailObjectKey) keys.add(m.thumbnailObjectKey);
    const catalogImage = (m.catalogItem as CatalogItem | null)?.imageUri;
    if (catalogImage && !/^[a-z][a-z0-9+.-]*:/i.test(catalogImage)) keys.add(catalogImage);
    if (m.order?.items) {
      for (const it of m.order.items) if (it.imageObjectKey) keys.add(it.imageObjectKey);
    }
    if (m.contact?.photoObjectKey) keys.add(m.contact.photoObjectKey);
    if (m.contact?.contacts) {
      for (const c of m.contact.contacts) if (c.photoObjectKey) keys.add(c.photoObjectKey);
    }
  }
  return Array.from(keys);
}

function mapContact(contact: ContactPayload, urls: Record<string, string>): FireMessage['contact'] {
  const resolve = (key?: string | null) => (key ? urls[key] ?? null : null);
  const base = {
    name: contact.name,
    phone: contact.phone,
    userId: contact.userId ?? null,
    registered: !!contact.registered,
    photoURL: resolve(contact.photoObjectKey),
  };
  if (contact.contacts && contact.contacts.length > 0) {
    return {
      ...base,
      contacts: contact.contacts.map((c) => ({
        name: c.name,
        phone: c.phone,
        userId: c.userId ?? null,
        registered: !!c.registered,
        photoURL: resolve(c.photoObjectKey),
      })),
    };
  }
  return base;
}

function mapBackendMessage(m: BackendMessage, urls: Record<string, string>): FireMessage {
  const resolve = (key?: string | null) => (key ? urls[key] ?? null : null);
  const mediaUrl = resolve(m.mediaObjectKey);
  const thumbUrl = resolve(m.thumbnailObjectKey);
  const rawCatalogItem = (m.catalogItem as CatalogItem | null) ?? null;
  const catalogImageKey = rawCatalogItem?.imageObjectKey
    ?? (rawCatalogItem?.imageUri && !/^[a-z][a-z0-9+.-]*:/i.test(rawCatalogItem.imageUri)
      ? rawCatalogItem.imageUri
      : null);

  const type = (m.type ?? 'text') as FireMessage['type'];

  return {
    messageId:    m.id,
    clientId:     m.clientId ?? null,
    senderId:     m.senderId,
    text:         m.text ?? null,
    imageUrl:     type === 'image' ? mediaUrl : null,
    voiceUrl:     type === 'voice' ? mediaUrl : null,
    videoUrl:     type === 'video' ? mediaUrl : null,
    fileUrl:      type === 'file'  ? mediaUrl : null,
    type,
    timestamp:    toDate(m.createdAt),
    expiresAt:    toDate(m.expiresAt),
    readBy:       m.readBy ?? [],
    deliveredTo:  m.deliveredTo ?? [],
    duration:     m.durationMs ?? null,
    fileName:     m.fileName ?? null,
    fileSize:     m.fileSize ?? null,
    mimeType:     m.mimeType ?? null,
    thumbnailUrl: thumbUrl,
    blockedMessage: false,
    catalogItem:  rawCatalogItem
      ? {
          ...rawCatalogItem,
          imageObjectKey: catalogImageKey,
          imageUri: catalogImageKey ? resolve(catalogImageKey) : rawCatalogItem.imageUri ?? null,
        }
      : null,
    order:        m.order
      ? {
          items: m.order.items.map((it) => ({
            id: it.id,
            name: it.name,
            price: it.price,
            imageUri: resolve(it.imageObjectKey),
            quantity: it.quantity,
          })),
          total: m.order.total ?? null,
          currency: m.order.currency,
        }
      : null,
    contact:      m.contact ? mapContact(m.contact, urls) : null,
    poll:         m.poll
      ? {
          question: m.poll.question,
          options: m.poll.options,
          votes: m.poll.votes ?? {},
          multiple: m.poll.multiple,
        }
      : null,
    meeting:      m.meeting
      ? {
          meetingId: m.meeting.meetingId,
          title: m.meeting.title,
          startsAt: m.meeting.startsAt,
          endsAt: m.meeting.endsAt,
          venue: m.meeting.venue,
          joinUrl: m.meeting.joinUrl,
          organizerName: m.meeting.organizerName ?? null,
          location: m.meeting.location ?? null,
        }
      : null,
    location:     (m.location as FireMessage['location']) ?? null,
    isLiveLocation: false,
    liveLocationExpiry: null,
    replyTo:      (m.replyTo as FireMessage['replyTo']) ?? null,
    edited:       m.edited ?? false,
    editedAt:     toDate(m.editedAt),
    forwarded:    (m.subtype === 'forwarded'),
  };
}

// How many messages to request per page. The first page loads instantly; older
// pages are fetched on demand when the user scrolls toward the top.
const MESSAGE_PAGE_SIZE = 30;

export function useMessages(chatId: string | null, ownerUid: string | null) {
  const [messages, setMessages] = useState<FireMessage[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  // This user's server-side "cleared" cutoff (ms): messages at/before it are
  // hidden for this user only. Does not affect the other members.
  const [clearedAt, setClearedAt] = useState<number>(0);
  // Message ids this user deleted "for me" (local-only, survives reloads).
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  // Keep the live chatId available inside socket handlers without re-subscribing.
  const chatIdRef = useRef<string | null>(chatId);
  chatIdRef.current = chatId;

  // Load the per-user deleted-for-me set for this chat.
  useEffect(() => {
    if (!chatId) { setDeletedIds(new Set()); return; }
    loadDeletedIds(chatId).then((ids) => setDeletedIds(new Set(ids)));
  }, [chatId]);

  // Seed from local cache immediately. If the app was killed during an upload,
  // the task itself cannot survive the process restart; restore that bubble as
  // failed/retryable rather than leaving a permanently spinning indicator.
  useEffect(() => {
    if (!chatId) return;
    loadLocalMessages(chatId).then((cached) => {
      const restored = cached.map((message) =>
        message.uploadStatus && message.uploadStatus !== 'failed'
          ? {
              ...message,
              uploadStatus: 'failed' as const,
              uploadError: 'Upload interrupted. Tap to retry.',
            }
          : message,
      );
      if (restored.length > 0) {
        messagesRef.current = restored;
        setMessages(restored);
        setLoading(false);
      }
    });
  }, [chatId]);

  // The cutoff belongs to one chat; it is re-read from the server on load.
  // Also reset pagination state so a loadOlder fired right after a chat switch
  // can't page the PREVIOUS chat's cursor into the new chat's list.
  useEffect(() => {
    setClearedAt(0);
    nextCursorRef.current = null;
    loadingMoreRef.current = false;
    setHasMore(false);
  }, [chatId]);

  // Apply the server's cutoff: hide everything at/before it now and prune the
  // local cache so a later reload can't bring those messages back.
  const applyClearedAt = useCallback(async (targetChatId: string, cutoffMs: number) => {
    if (cutoffMs <= 0 || targetChatId !== chatIdRef.current) return;
    setClearedAt((prev) => Math.max(prev, cutoffMs));
    setMessages((prev) => prev.filter((m) => !isClearedBy(m, cutoffMs)));
    await pruneLocalBefore(targetChatId, cutoffMs);
  }, []);

  // Apply a batch of backend messages into state + local cache. A backend
  // message carrying clientId replaces its optimistic counterpart instead of
  // creating a duplicate. The current-session local preview is retained in
  // memory for a seamless visual handoff, but is not persisted after success.
  const applyBackendMessages = useCallback(async (incoming: BackendMessage[]) => {
    const activeChatId = chatIdRef.current;
    if (!activeChatId) return;
    const optimisticSnapshot = messagesRef.current;
    const urls = await mediaService.getDownloadUrls(collectObjectKeys(incoming));
    const mapped = incoming
      .filter((m) => !m.deletedForEveryone)
      .map((m) => mapBackendMessage(m, urls));
    if (mapped.length === 0) return;
    await mergeLocalMessages(activeChatId, mapped).catch(() => {});
    const merged = await loadLocalMessages(activeChatId);
    const withLocalPreview = merged.map((message) => {
      if (!message.clientId) return message;
      const optimistic = optimisticSnapshot.find(
        (candidate) =>
          candidate.senderId === message.senderId &&
          candidate.clientId === message.clientId &&
          !!candidate.localMediaUri,
      );
      return optimistic
        ? {
            ...message,
            localMediaUri: optimistic.localMediaUri,
            mediaWidth: optimistic.mediaWidth,
            mediaHeight: optimistic.mediaHeight,
          }
        : message;
    });
    messagesRef.current = withLocalPreview;
    setMessages(withLocalPreview);
  }, []);

  // Fetch the next (older) page of messages and merge it into the list. Called
  // when the user scrolls toward the top. No-op when there's nothing older or a
  // fetch is already in flight.
  const loadOlder = useCallback(async () => {
    const activeChatId = chatIdRef.current;
    const cursor = nextCursorRef.current;
    if (!activeChatId || !cursor || loadingMoreRef.current) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await endpoints.listMessages(activeChatId, { cursor, limit: MESSAGE_PAGE_SIZE });
      if (activeChatId !== chatIdRef.current) return; // chat switched mid-fetch
      if (!res.ok) return;

      nextCursorRef.current = res.data.nextCursor;
      setHasMore(res.data.nextCursor != null);

      const urls = await mediaService.getDownloadUrls(collectObjectKeys(res.data.messages));
      if (activeChatId !== chatIdRef.current) return;
      const mapped = res.data.messages
        .filter((m) => !m.deletedForEveryone)
        .map((m) => mapBackendMessage(m, urls));
      if (mapped.length > 0) {
        await mergeLocalMessages(activeChatId, mapped).catch(() => {});
        const merged = await loadLocalMessages(activeChatId);
        if (activeChatId === chatIdRef.current) setMessages(merged);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, []);

  // Initial load + live socket updates.
  useEffect(() => {
    if (!chatId) return;
    let active = true;
    setLoading(true);

    const load = async () => {
      // The server already leaves out messages older than this user's cutoff;
      // the cutoff itself is only needed to prune the local cache, which may
      // predate a clear made on another device.
      const [res, cutoff] = await Promise.all([
        endpoints.listMessages(chatId, { limit: MESSAGE_PAGE_SIZE }),
        fetchClearedAt(chatId),
      ]);
      if (!active) return;
      if (cutoff > 0) await applyClearedAt(chatId, cutoff);
      if (!active) return;
      if (res.ok) {
        // Remember where the next (older) page starts.
        nextCursorRef.current = res.data.nextCursor;
        setHasMore(res.data.nextCursor != null);

        const urls = await mediaService.getDownloadUrls(collectObjectKeys(res.data.messages));
        if (!active) return;
        const mapped = res.data.messages
          .filter((m) => !m.deletedForEveryone)
          .map((m) => mapBackendMessage(m, urls));
        await mergeLocalMessages(chatId, mapped).catch(() => {});
        const merged = await loadLocalMessages(chatId);
        if (!active) return;
        setMessages(merged);
        setLoading(false);

        if (ownerUid) {
          markAsRead(chatId, ownerUid, mapped);
        }
      } else {
        setError(errText(res.error));
        setLoading(false);
      }
    };

    // Join the chat room and load, then refetch on reconnect so no live message
    // is missed while the socket was down.
    void socketClient.connect()
      .then(() => { socketClient.joinChat(chatId); return load(); })
      .catch(() => load());

    const onNew = (payload: unknown) => {
      const message = (payload as { message?: BackendMessage })?.message;
      if (!message || message.chatId !== chatIdRef.current) return;
      void applyBackendMessages([message]).then(() => {
        if (ownerUid && message.senderId !== ownerUid) {
          socketClient.emit('message:read', {
            chatId: message.chatId,
            messageIds: [message.id],
          });
        }
      });
    };

    const onDeleted = (payload: unknown) => {
      const p = payload as { chatId?: string; messageId?: string };
      if (!p?.messageId || p.chatId !== chatIdRef.current) return;
      setMessages((prev) => prev.filter((m) => m.messageId !== p.messageId));
      if (chatIdRef.current) removeLocalMessage(chatIdRef.current, p.messageId).catch(() => {});
    };

    // A recipient acknowledged delivery of one of OUR messages. The server
    // emits { chatId, messageId, userId }; add that user to the message's
    // deliveredTo list so the tick advances to the grey double-tick live.
    const onDelivered = (payload: unknown) => {
      const p = payload as { chatId?: string; messageId?: string; userId?: string };
      if (!p?.messageId || !p.userId || p.chatId !== chatIdRef.current) return;
      setMessages((prev) => {
        let changed = false;
        const next = prev.map((m) => {
          if (m.messageId !== p.messageId) return m;
          const delivered = m.deliveredTo ?? [];
          if (delivered.includes(p.userId!)) return m;
          changed = true;
          return { ...m, deliveredTo: [...delivered, p.userId!] };
        });
        if (changed && chatIdRef.current) {
          const updated = next.find((m) => m.messageId === p.messageId);
          if (updated) mergeLocalMessages(chatIdRef.current, [updated]).catch(() => {});
        }
        return changed ? next : prev;
      });
    };

    // A recipient read one or more of OUR messages. The server emits
    // { chatId, messageIds, userId }; add that user to each message's readBy
    // list so the tick turns blue live.
    const onRead = (payload: unknown) => {
      const p = payload as { chatId?: string; messageIds?: string[]; userId?: string };
      if (!Array.isArray(p?.messageIds) || !p.userId || p.chatId !== chatIdRef.current) return;
      const ids = new Set(p.messageIds);
      setMessages((prev) => {
        const touched: FireMessage[] = [];
        const next = prev.map((m) => {
          if (!ids.has(m.messageId)) return m;
          const read = m.readBy ?? [];
          if (read.includes(p.userId!)) return m;
          const updated = { ...m, readBy: [...read, p.userId!] };
          touched.push(updated);
          return updated;
        });
        if (touched.length > 0 && chatIdRef.current) {
          mergeLocalMessages(chatIdRef.current, touched).catch(() => {});
        }
        return touched.length > 0 ? next : prev;
      });
    };

    const onEditedOrPoll = (payload: unknown) => {
      const message = (payload as { message?: BackendMessage })?.message;
      if (!message || message.chatId !== chatIdRef.current) return;
      void applyBackendMessages([message]);
    };

    // This user cleared the open chat (here or on another of their devices).
    const onCleared = (payload: unknown) => {
      const p = payload as { chatId?: string; clearedAt?: string };
      if (!p?.chatId || p.chatId !== chatIdRef.current) return;
      void applyClearedAt(p.chatId, parseMs(p.clearedAt));
    };

    const unsubs = [
      socketClient.subscribe('message:new', onNew),
      socketClient.subscribe('message:deleted', onDeleted),
      socketClient.subscribe('message:delivered', onDelivered),
      socketClient.subscribe('message:read', onRead),
      socketClient.subscribe('message:edited', onEditedOrPoll),
      socketClient.subscribe('poll:updated', onEditedOrPoll),
      socketClient.subscribe('chat:cleared', onCleared),
      socketClient.subscribe('client:reconnect', () => { void load(); }),
    ];

    return () => {
      active = false;
      unsubs.forEach((u) => u());
      socketClient.leaveChat(chatId);
    };
  }, [chatId, ownerUid, applyBackendMessages, applyClearedAt]);

  async function sendMessage(text: string): Promise<boolean> {
    if (!chatId || !ownerUid || !text.trim()) return false;
    try {
      const res = await endpoints.sendMessage(chatId, { type: 'text', text: text.trim() });
      if (!res.ok) { setError(errText(res.error)); return false; }
      await applyBackendMessages([res.data.message]);
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }

  // Delete FOR THIS USER ONLY ("delete for me"). Purely local — the backend copy
  // for other members is untouched. The id is recorded in a persistent local set
  // so the message stays hidden even if the backend re-delivers it on reconnect.
  const deleteMessage = useCallback(async (messageId: string) => {
    if (!chatId || !messageId) return;
    setDeletedIds((prev) => new Set(prev).add(messageId));
    setMessages((prev) => prev.filter((m) => m.messageId !== messageId));
    await removeLocalMessage(chatId, messageId);
    await addDeletedIds(chatId, [messageId]);
  }, [chatId]);

  // Clear chat FOR THIS USER ONLY. The server records the cutoff and stops
  // returning older messages to this user; nothing is deleted, so the other
  // members keep their full history. Throws if the server refuses, leaving the
  // list as it was.
  const clearMessages = useCallback(async () => {
    if (!chatId || !ownerUid) return;
    const res = await endpoints.clearChat(chatId);
    if (!res.ok) {
      setError(errText(res.error));
      throw new Error(`clearChat failed: ${errText(res.error)}`);
    }
    setDeletedIds(new Set());
    await clearDeletedIds(chatId);
    await applyClearedAt(chatId, parseMs(res.data.clearedAt));
  }, [chatId, ownerUid, applyClearedAt]);

  // Optimistically insert a locally-built message so it appears instantly.
  // Media uses messageId === clientId until the backend returns its real id.
  const addOptimisticMessage = useCallback((partial: Partial<FireMessage> & { messageId: string }) => {
    if (!chatId) return;
    const echo: FireMessage = {
      messageId: partial.messageId,
      clientId: partial.clientId ?? partial.messageId,
      senderId: partial.senderId ?? ownerUid ?? '',
      text: partial.text ?? null,
      imageUrl: partial.imageUrl ?? null,
      voiceUrl: partial.voiceUrl ?? null,
      videoUrl: partial.videoUrl ?? null,
      fileUrl: partial.fileUrl ?? null,
      type: partial.type ?? 'text',
      timestamp: partial.timestamp ?? new Date(),
      expiresAt: partial.expiresAt ?? null,
      readBy: partial.readBy ?? (ownerUid ? [ownerUid] : []),
      deliveredTo: partial.deliveredTo ?? [],
      duration: partial.duration ?? null,
      fileName: partial.fileName ?? null,
      fileSize: partial.fileSize ?? null,
      mimeType: partial.mimeType ?? null,
      thumbnailUrl: partial.thumbnailUrl ?? null,
      blockedMessage: partial.blockedMessage ?? false,
      localMediaUri: partial.localMediaUri ?? null,
      uploadStatus: partial.uploadStatus,
      uploadProgress: partial.uploadProgress ?? 0,
      uploadBytesSent: partial.uploadBytesSent ?? 0,
      uploadBytesTotal: partial.uploadBytesTotal ?? 0,
      uploadError: partial.uploadError ?? null,
      mediaWidth: partial.mediaWidth ?? null,
      mediaHeight: partial.mediaHeight ?? null,
      catalogItem: partial.catalogItem ?? null,
      order: partial.order ?? null,
      contact: partial.contact ?? null,
      poll: partial.poll ?? null,
      meeting: partial.meeting ?? null,
      location: partial.location ?? null,
      replyTo: partial.replyTo ?? null,
      forwarded: partial.forwarded ?? false,
    };
    setMessages((prev) => {
      if (prev.some((m) => m.messageId === echo.messageId)) return prev;
      const next = [...prev, echo];
      messagesRef.current = next;
      return next;
    });
    mergeLocalMessages(chatId, [echo]).catch(() => {});
  }, [chatId, ownerUid]);

  /** Update one optimistic bubble; persist only meaningful stage/failure changes. */
  const updateOptimisticMessage = useCallback((
    messageId: string,
    patch: Partial<FireMessage>,
    persist = false,
  ) => {
    setMessages((prev) => {
      const next = prev.map((message) =>
        message.messageId === messageId ? { ...message, ...patch } : message,
      );
      messagesRef.current = next;
      return next;
    });
    if (persist && chatId) {
      void updateLocalMessage(chatId, messageId, patch);
    }
  }, [chatId]);

  /** Replace an optimistic send with the backend message using its clientId. */
  const reconcileBackendMessage = useCallback(async (message: BackendMessage) => {
    await applyBackendMessages([message]);
  }, [applyBackendMessages]);

  // Hide messages the user cleared for themselves (timestamp <= their cutoff)
  // and any they deleted "for me".
  const visibleMessages = messages.filter((m) => {
    if (deletedIds.has(m.messageId)) return false;
    if (isClearedBy(m, clearedAt)) return false;
    return true;
  });

  return {
   
    messages: visibleMessages,
    loading,
    error,
   
    sendMessage,
    clearMessages,
    deleteMessage,
    addOptimisticMessage,
    updateOptimisticMessage,
    reconcileBackendMessage,
 ,
    loadOlder, hasMore, loadingMore,
  };
}

// ── Mark incoming messages as read ────────────────────────────────────────────
// The server clears the reader's unread counter unconditionally on message:read
// and only forwards the receipt to the senders when the reader's readReceipts
// privacy allows it. So we ALWAYS emit to clear the badge; the server decides
// whether to tell the senders.
function markAsRead(
  chatId: string,
  ownerUid: string,
  messages: FireMessage[],
) {
  try {
    const unreadIds = messages
      .filter((m) => m.senderId !== ownerUid && !(m.readBy ?? []).includes(ownerUid))
      .map((m) => m.messageId);
    if (unreadIds.length === 0) return;
    socketClient.emit('message:read', { chatId, messageIds: unreadIds });
    // Notify local subscribers (useUnreadCount) that the reader has marked
    // messages as read, so badges/counters refresh immediately without waiting
    // for a server echo that never comes back to the reader.
    socketClient.emitLocal('client:read', { chatId });
  } catch (error) {
    console.warn('[useMessages] Error marking messages:', error);
  }
}
