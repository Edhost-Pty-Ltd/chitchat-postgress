// ─── useMessages Hook ─────────────────────────────────────────────────────────
// Real-time listener for messages inside a single chat.

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
}

function toDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
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
  }, [chatId, currentUserId]);

  async function sendMessage(text: string): Promise<boolean> {
    if (!chatId || !currentUserId || !text.trim()) return false;
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
