// ─── useChats Hook ────────────────────────────────────────────────────────────
// Real-time listener for the current user's chat list.
//
// COMPANION NOTE
//   `ownerUid` is the real account uid. On both primary and companion devices,
//   `auth.uid` equals the owner uid — the companion signs in with a Firebase
//   Custom Token whose uid IS the owner uid (plus a `companion: true` claim).
//   There is no `companionLinks` collection or `effectiveUid()` helper in the
//   rules; the companion is authorised by virtue of sharing the owner uid.
//   If the companion's custom token hasn't been issued yet (linking still in
//   progress) the listener gets permission-denied. We retry with backoff to
//   cover that race, and only surface an error after several tries.

import { useState, useEffect } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { getAuth } from '@react-native-firebase/auth'; 

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

const MAX_PERM_RETRIES = 8;
export function useChats(ownerUid: string | null) {
  const [chats,   setChats]   = useState<ChatPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!ownerUid) { 
// ...
console.log('[useChats][diag] auth.uid =', getAuth().currentUser?.uid,
            '  passed ownerUid =', ownerUid);
      setChats([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    let cancelled = false;

    const unsub = (db as ReturnType<typeof firestore>)
      .collection('chats')
      .where('members', 'array-contains', ownerUid)
      .onSnapshot(
        (snap) => {
          if (cancelled) return;
          const result: ChatPreview[] = snap.docs.map((doc) => {
            const d = doc.data();
            const lm = d.lastMessage;
            const lmTime = lm?.timestamp ? (lm.timestamp as firestore.Timestamp).toDate() : null;

            // Per-user clear: if this user cleared the chat after the last
            // message, hide the preview text/time for them only.
            const clearedRaw = d.clearedAt?.[ownerUid];
            const clearedMs = clearedRaw?.toMillis ? clearedRaw.toMillis() : 0;
            const cleared = clearedMs > 0 && (lmTime?.getTime() ?? 0) <= clearedMs;

            return {
              chatId:       doc.id,
              type:         d.type ?? 'direct',
              members:      d.members ?? [],
              groupName:    d.groupName ?? null,
              lastMessage:  cleared ? '' : (lm?.text ?? ''),
              lastSenderId: cleared ? '' : (lm?.senderId ?? ''),
              timestamp:    cleared ? null : lmTime,
              unreadCount: getUnreadCount(d.unreadCounts, ownerUid),
            };
          });
          setChats(result);
          setError(null);
          setLoading(false);
        },
        (err) => {
          if (cancelled) return;
          const isPerm =
            err?.message === 'firestore/permission-denied' ||
            /permission-denied/i.test(err?.message || '');

          if (isPerm && attempt < MAX_PERM_RETRIES) {
            const delay = Math.min(200 * (attempt + 1), 2000);
            console.warn(
              `[useChats] permission-denied — retry ${attempt + 1}/${MAX_PERM_RETRIES} in ${delay}ms`,
            );
            setTimeout(() => { if (!cancelled) setAttempt((a) => a + 1); }, delay);
            return;
          }

          console.error('[useChats] Error:', err.message, err.message);
          setError(err.message);
          setLoading(false);
        },
      );

    return () => { cancelled = true; unsub(); };
  }, [ownerUid, attempt]);

  return { chats, loading, error };
}

function getUnreadCount(
  unreadCounts: Record<string, number> | undefined,
  ownerUid: string,
): number {
  if (!unreadCounts) return 0;
  return unreadCounts[ownerUid] ?? 0;
}