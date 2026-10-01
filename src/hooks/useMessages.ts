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

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { fetchUserPrivacySettings } from './usePrivacySettings';
import { loadLocalMessages, mergeLocalMessages } from './useLocalMessages';
import { CatalogItem } from '../types';

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
  edited?:    boolean;
  editedAt?:  Date | null;
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

  // Seed from local cache immediately
  useEffect(() => {
    if (!chatId) return;
    loadLocalMessages(chatId).then((cached) => {
      if (cached.length > 0) { setMessages(cached); setLoading(false); }
    });
  }, [chatId]);

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
              location:           d.location   ?? null,
              isLiveLocation:     d.isLiveLocation ?? false,
              liveLocationExpiry: toDate(d.liveLocationExpiry),
              replyTo:            d.replyTo    ?? null,
              edited:             d.edited     ?? false,
              editedAt:           toDate(d.editedAt),
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

  return { messages, loading, error, sendMessage };
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