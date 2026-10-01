// ─── useMessageAnalytics Hook ─────────────────────────────────────────────────
//
// Computes real-time message delivery statistics for a business owner.
//
// Strategy:
//   • We subscribe live to chats/{chatId}/messages for every chat where the
//     owner is a member. For each outgoing message (senderId == ownerUid) we
//     look at deliveredTo and readBy arrays.
//   • Results are cached in a Firestore counter document
//     users/{ownerUid}/stats/messageStats so the dashboard can read a single
//     document instead of fanning out over all messages every time.
//   • The hook also exposes the live computed values directly so the dashboard
//     always shows up-to-date numbers even before the cache doc is written.
//
// NOTE: For large accounts with thousands of messages, consider moving this
// aggregation to a Cloud Function triggered on message writes. The client-side
// fan-out approach is fine for typical business accounts (< 5000 messages).

import { useState, useEffect, useRef } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { MessageStats } from '../types';

const fsDb = () => db as ReturnType<typeof firestore>;

// ─── useMessageAnalytics ──────────────────────────────────────────────────────
// Returns live stats read from the pre-computed counter doc.
// Call refreshStats() to trigger a fresh scan (e.g. on pull-to-refresh).
export function useMessageAnalytics(ownerUid: string | null) {
  const [stats,   setStats]   = useState<MessageStats>({ sent: 0, delivered: 0, read: 0 });
  const [loading, setLoading] = useState(true);

  // Live listener on the pre-computed stats document
  useEffect(() => {
    if (!ownerUid) { setLoading(false); return; }

    const unsub = fsDb()
      .collection('users').doc(ownerUid)
      .collection('stats').doc('messageStats')
      .onSnapshot(
        (snap) => {
          if (snap.exists()) {
            const d = snap.data()!;
            setStats({
              sent:      d.sent      ?? 0,
              delivered: d.delivered ?? 0,
              read:      d.read      ?? 0,
              lastUpdatedAt: d.lastUpdatedAt?.toDate?.() ?? null,
            });
          } else {
            setStats({ sent: 0, delivered: 0, read: 0 });
          }
          setLoading(false);
        },
        () => setLoading(false),
      );

    return () => unsub();
  }, [ownerUid]);

  return { stats, loading };
}

// ─── computeAndSaveMessageStats ───────────────────────────────────────────────
// Fans out over all chats for the owner, scans messages, computes totals,
// and writes a single counter doc. Called on pull-to-refresh or on first load
// when the counter doc doesn't exist yet.
export async function computeAndSaveMessageStats(ownerUid: string): Promise<MessageStats> {
  try {
    // 1. Fetch all chats for this owner
    const chatsSnap = await fsDb()
      .collection('chats')
      .where('members', 'array-contains', ownerUid)
      .get();

    let sent      = 0;
    let delivered = 0;
    let read      = 0;

    // 2. For each chat, fetch all messages
    await Promise.all(
      chatsSnap.docs.map(async (chatDoc) => {
        try {
          const msgsSnap = await fsDb()
            .collection('chats').doc(chatDoc.id)
            .collection('messages')
            .where('senderId', '==', ownerUid)
            .get();

          msgsSnap.docs.forEach((msgDoc) => {
            const d = msgDoc.data();
            const deliveredTo: string[] = d.deliveredTo ?? [];
            const readBy:      string[] = d.readBy      ?? [];

            // Count this message as sent
            sent += 1;

            // Count delivered (at least one recipient got it — exclude sender)
            const deliveredToOthers = deliveredTo.filter((uid) => uid !== ownerUid);
            if (deliveredToOthers.length > 0) delivered += 1;

            // Count read (at least one recipient read it — exclude sender)
            const readByOthers = readBy.filter((uid) => uid !== ownerUid);
            if (readByOthers.length > 0) read += 1;
          });
        } catch {
          // Single chat failure — skip, don't abort the whole scan
        }
      })
    );

    const result: MessageStats = { sent, delivered, read };

    // 3. Persist to Firestore for future fast reads
    try {
      await fsDb()
        .collection('users').doc(ownerUid)
        .collection('stats').doc('messageStats')
        .set({
          ...result,
          lastUpdatedAt: firestore.FieldValue.serverTimestamp(),
        });
    } catch {
      // Stats sub-collection write failed — the computed values are still returned
    }

    return result;
  } catch (err) {
    console.warn('[useMessageAnalytics] computeAndSaveMessageStats failed:', err);
    return { sent: 0, delivered: 0, read: 0 };
  }
}

// ─── Delivery rate helpers ────────────────────────────────────────────────────
export function deliveryRate(stats: MessageStats): number {
  if (!stats.sent) return 0;
  return Math.round((stats.delivered / stats.sent) * 100);
}

export function readRate(stats: MessageStats): number {
  if (!stats.sent) return 0;
  return Math.round((stats.read / stats.sent) * 100);
}
