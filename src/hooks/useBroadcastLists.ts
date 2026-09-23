// ─── useBroadcastLists ────────────────────────────────────────────────────────
// Real-time Firestore listener for the current user's broadcast lists.
// Mirrors the exact pattern used by useChats.ts — onSnapshot listener, same
// error/loading shape, same collection-path convention.
//
// Firestore layout:
//   broadcasts/{broadcastId}
//     createdBy:   string        ← sender UID
//     name:        string
//     recipients:  string[]      ← array of UIDs
//     createdAt:   Timestamp
//     lastSentAt:  Timestamp | null
//     lastMessage: string | null
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { BroadcastList } from '../types';

const fsDb = () => db as ReturnType<typeof firestore>;

function toDate(raw: any): Date | null {
  if (!raw) return null;
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

// ── Real-time list hook ───────────────────────────────────────────────────────
export function useBroadcastLists(userId: string | null) {
  const [lists,   setLists]   = useState<BroadcastList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!userId) {
      setLists([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const unsub = fsDb()
      .collection('broadcasts')
      .where('createdBy', '==', userId)
      .orderBy('createdAt', 'desc')
      .onSnapshot(
        (snap) => {
          const result: BroadcastList[] = snap.docs.map((doc) => {
            const d = doc.data();
            return {
              id:          doc.id,
              name:        d.name        ?? 'Untitled',
              recipients:  d.recipients  ?? [],
              createdBy:   d.createdBy   ?? userId,
              createdAt:   toDate(d.createdAt) ?? new Date(),
              lastSentAt:  toDate(d.lastSentAt),
              lastMessage: d.lastMessage ?? null,
            };
          });
          setLists(result);
          setLoading(false);
        },
        (err) => {
          console.error('[useBroadcastLists]', err.message);
          setError(err.message);
          setLoading(false);
        },
      );

    return () => unsub();
  }, [userId]);

  return { lists, loading, error };
}

// ── Create a new broadcast list ───────────────────────────────────────────────
export async function createBroadcastList(
  userId:     string,
  name:       string,
  recipients: string[],
): Promise<string> {
  const ref = await fsDb().collection('broadcasts').add({
    createdBy:   userId,
    name:        name.trim(),
    recipients,
    createdAt:   firestore.FieldValue.serverTimestamp(),
    lastSentAt:  null,
    lastMessage: null,
  });
  return ref.id;
}

// ── Update recipients for an existing list ────────────────────────────────────
export async function updateBroadcastRecipients(
  listId:     string,
  recipients: string[],
): Promise<void> {
  await fsDb().collection('broadcasts').doc(listId).update({ recipients });
}

// ── Rename a list ─────────────────────────────────────────────────────────────
export async function renameBroadcastList(
  listId: string,
  name:   string,
): Promise<void> {
  await fsDb().collection('broadcasts').doc(listId).update({ name: name.trim() });
}

// ── Delete a list ─────────────────────────────────────────────────────────────
export async function deleteBroadcastList(listId: string): Promise<void> {
  await fsDb().collection('broadcasts').doc(listId).delete();
}

// ── Record a successful send against the list ─────────────────────────────────
export async function recordBroadcastSend(
  listId:  string,
  message: string,
): Promise<void> {
  await fsDb().collection('broadcasts').doc(listId).update({
    lastSentAt:  firestore.FieldValue.serverTimestamp(),
    lastMessage: message.slice(0, 120), // trim preview
  });
}
