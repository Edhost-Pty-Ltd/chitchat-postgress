// ─── useMessages Hook ─────────────────────────────────────────────────────────
// Real-time listener for messages inside a single chat.
//
// COMPANION NOTE
//   `ownerUid` is the account whose chats we're reading. On the primary device
//   it equals the Firebase Auth uid; on a companion it's the owner's uid, and
//   the companion's auth uid is different. Every write is attributed to
//   `ownerUid`:
//
//     • senderId     = ownerUid
//     • readBy       = ownerUid
//     • deliveredTo  = ownerUid
//
//   That way a message sent from the companion looks identical to one sent
//   from the owner's phone — same tick state, same read receipts.

import { useState, useEffect, useCallback } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { fetchUserPrivacySettings } from './usePrivacySettings';
import { loadLocalMessages, mergeLocalMessages, clearLocalMessages, removeLocalMessage, loadDeletedIds, addDeletedIds, clearDeletedIds } from './useLocalMessages';
import { CatalogItem } from '../types';

export interface FireMessage {
  messageId:    string;
  senderId:     string;
  text:         string | null;
  imageUrl:     string | null;
  voiceUrl:     string | null;
  videoUrl:     string | null;
  fileUrl:      string | null;
  type:         'text' | 'image' | 'voice' | 'video' | 'file' | 'location' | 'system' | 'catalog' | 'order' | 'contact' | 'poll';
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
  return new Date(raw);
}

export function useMessages(chatId: string | null, ownerUid: string | null) {
  const [messages, setMessages] = useState<FireMessage[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  // Per-user "cleared" cutoff: messages at/before this time are hidden for this
  // user only (set when they clear the chat). Does not affect the other member.
  const [clearedAt, setClearedAt] = useState<number>(0);
  // Message ids this user deleted "for me" (local-only, survives snapshots).
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set());

  // Load the per-user deleted-for-me set for this chat.
  useEffect(() => {
    if (!chatId) { setDeletedIds(new Set()); return; }
    loadDeletedIds(chatId).then((ids) => setDeletedIds(new Set(ids)));
  }, [chatId]);

  // Seed from local cache immediately
  useEffect(() => {
    if (!chatId) return;
    loadLocalMessages(chatId).then((cached) => {
      if (cached.length > 0) { setMessages(cached); setLoading(false); }
    });
  }, [chatId]);

  // Watch this user's per-user clear cutoff on the chat doc
  useEffect(() => {
    if (!chatId || !ownerUid) { setClearedAt(0); return; }
    const fsDb = db as ReturnType<typeof firestore>;
    const unsub = fsDb.collection('chats').doc(chatId).onSnapshot((snap) => {
      const raw = snap.exists() ? (snap.data()?.clearedAt?.[ownerUid]) : null;
      const ms = raw?.toMillis ? raw.toMillis() : (raw ? new Date(raw).getTime() : 0);
      setClearedAt(ms || 0);
    }, () => {});
    return () => unsub();
  }, [chatId, ownerUid]);

  // Real-time listener
  useEffect(() => {
    if (!chatId) return;
    setLoading(true);

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
              order:              d.order      ?? null,
              contact:            d.contact    ?? null,
              poll:               d.poll       ?? null,
              location:           d.location   ?? null,
              isLiveLocation:     d.isLiveLocation ?? false,
              liveLocationExpiry: toDate(d.liveLocationExpiry),
              replyTo:            d.replyTo    ?? null,
              edited:             d.edited     ?? false,
              editedAt:           toDate(d.editedAt),
              forwarded:          d.forwarded  ?? false,
            };
          });

          mergeLocalMessages(chatId, firestoreMsgs).catch(() => {});
          loadLocalMessages(chatId).then((merged) => {
            setMessages(merged);
            setLoading(false);
          });

          if (ownerUid) {
            fetchUserPrivacySettings(ownerUid).then((privacy) => {
              markAsRead(chatId, ownerUid, privacy.readReceipts);
            });
          }
        },
        (err) => { setError(err.message); setLoading(false); },
      );

    return () => unsub();
  }, [chatId, ownerUid]);

  async function sendMessage(text: string): Promise<boolean> {
    if (!chatId || !ownerUid || !text.trim()) return false;
    try {
      const trimmed = text.trim();
      const fsDb = db as ReturnType<typeof firestore>;
      const chatRef = fsDb.collection('chats').doc(chatId);

      // Fetch members so we can increment unread counts for everyone else
      const chatSnap = await chatRef.get();
      const members: string[] = chatSnap.exists ? (chatSnap.data()?.members ?? []) : [];
      const otherMembers = members.filter((id) => id !== ownerUid);
      const unreadIncrements = Object.fromEntries(
        otherMembers.map((id) => [`unreadCounts.${id}`, firestore.FieldValue.increment(1)])
      );

      await fsDb.collection('chats').doc(chatId).collection('messages').add({
        senderId:    ownerUid,
        text:        trimmed,
        imageUrl:    null,
        voiceUrl:    null,
        type:        'text',
        timestamp:   firestore.FieldValue.serverTimestamp(),
        readBy:      [ownerUid],
        deliveredTo: [],
      });
      await chatRef.update({
        'lastMessage.text':      trimmed,
        'lastMessage.senderId':  ownerUid,
        'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
        ...unreadIncrements,
      });
      return true;
    } catch (err: any) {
      setError(err.message);
      return false;
    }
  }

  // Delete a single message in real time: remove it from the in-memory list and
  // the local cache immediately, then delete the Firestore doc.
  // Delete FOR THIS USER ONLY ("delete for me"). Purely local — we never touch
  // the shared Firestore doc, so the other member keeps their copy and there's
  // no permission concern. The id is recorded in a persistent local set so the
  // message stays hidden even after Firestore snapshots re-deliver it.
  const deleteMessage = useCallback(async (messageId: string) => {
    if (!chatId || !messageId) return;
    setDeletedIds((prev) => new Set(prev).add(messageId));
    setMessages((prev) => prev.filter((m) => m.messageId !== messageId));
    await removeLocalMessage(chatId, messageId);
    await addDeletedIds(chatId, [messageId]);
  }, [chatId]);

  // Clear every message in the chat: delete the Firestore docs, wipe the local
  // cache, and immediately empty the in-memory list so the UI updates in real
  // time without needing to leave and re-enter the screen.
  // Clear chat FOR THIS USER ONLY. Records a per-user cutoff timestamp on the
  // chat doc; messages are NOT deleted from Firestore, so the other member keeps
  // their full history. The local cache is wiped and the UI empties instantly.
  const clearMessages = useCallback(async () => {
    if (!chatId || !ownerUid) return;
    setMessages([]);
    setClearedAt(Date.now());
    setDeletedIds(new Set());
    await clearLocalMessages(chatId);
    await clearDeletedIds(chatId);
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('chats').doc(chatId).set(
        { clearedAt: { [ownerUid]: firestore.FieldValue.serverTimestamp() } },
        { merge: true },
      );
    } catch (err: any) {
      setError(err.message);
      throw err;
    }
  }, [chatId, ownerUid]);

  // Optimistically insert a locally-built message so it appears instantly,
  // before the Firestore snapshot round-trips. The real snapshot (same
  // messageId) overwrites it on arrival, so this is safe to call right after a
  // successful send. Used for poll/order/contact cards which are written via
  // useChatActions (outside this hook's own sendMessage path).
  const addOptimisticMessage = useCallback((partial: Partial<FireMessage> & { messageId: string }) => {
    if (!chatId) return;
    const echo: FireMessage = {
      messageId: partial.messageId,
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
      catalogItem: partial.catalogItem ?? null,
      order: partial.order ?? null,
      contact: partial.contact ?? null,
      poll: partial.poll ?? null,
      location: partial.location ?? null,
      replyTo: partial.replyTo ?? null,
      forwarded: partial.forwarded ?? false,
    };
    setMessages((prev) => {
      if (prev.some((m) => m.messageId === echo.messageId)) return prev;
      return [...prev, echo];
    });
    mergeLocalMessages(chatId, [echo]).catch(() => {});
  }, [chatId, ownerUid]);

  // Hide messages the user cleared for themselves (timestamp <= their cutoff)
  // and any they deleted "for me".
  const visibleMessages = messages.filter((m) => {
    if (deletedIds.has(m.messageId)) return false;
    if (clearedAt > 0 && (m.timestamp?.getTime() ?? 0) <= clearedAt) return false;
    return true;
  });

  return { messages: visibleMessages, loading, error, sendMessage, clearMessages, deleteMessage, addOptimisticMessage };
}

async function markAsRead(chatId: string, ownerUid: string, readReceipts = true) {
  try {
    const fsDb = db as ReturnType<typeof firestore>;
    await fsDb.collection('chats').doc(chatId).update({
      [`unreadCounts.${ownerUid}`]: 0,
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
      if (data.senderId === ownerUid) return;

      if (!deliveredTo.includes(ownerUid)) {
        batch.update(docSnap.ref, {
          deliveredTo: firestore.FieldValue.arrayUnion(ownerUid),
          readBy:      firestore.FieldValue.arrayUnion(ownerUid),
        });
      } else if (!readBy.includes(ownerUid)) {
        batch.update(docSnap.ref, {
          readBy: firestore.FieldValue.arrayUnion(ownerUid),
        });
      }
    });
    await batch.commit();
  } catch (error) {
    console.warn('[useMessages] Error marking messages:', error);
  }
}