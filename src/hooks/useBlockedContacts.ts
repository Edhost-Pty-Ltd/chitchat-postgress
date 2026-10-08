// ─── useBlockedContacts Hook ──────────────────────────────────────────────────
import { useState, useEffect, useCallback } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';

export interface BlockedContact {
  userId: string;
  displayName: string;
  photoURL: string | null;
  phone?: string;
  blockedAt: Date;
  lastSeenAtBlock?: Date;
}

const fsDb = () => db as ReturnType<typeof firestore>;

function toDate(raw: any): Date {
  if (!raw) return new Date();
  if (typeof raw.toDate === 'function') return raw.toDate();
  return new Date(raw);
}

async function sendBlockNotifications(
  blockerId: string, blockedId: string,
  blockerName: string, blockedName: string,
) {
  try {
    const chatsSnap = await fsDb().collection('chats').get();
    let chatId: string | null = null;

    for (const chatDoc of chatsSnap.docs) {
      const data    = chatDoc.data();
      const members = data.members || [];
      if (!data.isGroup && members.length === 2 &&
          members.includes(blockerId) && members.includes(blockedId)) {
        chatId = chatDoc.id; break;
      }
    }
    if (!chatId) return;

    const batch = fsDb().batch();

    const blockerSnap = await fsDb().collection('users').doc(blockerId).get();
    const blockerLastSeen = blockerSnap.exists ? blockerSnap.data()!.lastSeen : null;

    const blockedUserRef = fsDb().collection('users').doc(blockerId).collection('blockedUsers').doc(blockedId);
    batch.update(blockedUserRef, { lastSeenAtBlock: blockerLastSeen || firestore.FieldValue.serverTimestamp() });

    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId: 'system',
      text: `BLOCK:${blockerId}:${blockedId}:${blockerName}:${blockedName}`,
      imageUrl: null, voiceUrl: null, videoUrl: null, fileUrl: null,
      type: 'system', timestamp: firestore.FieldValue.serverTimestamp(),
      readBy: [], deliveredTo: [], duration: null, fileName: null,
      fileSize: null, mimeType: null, thumbnailUrl: null,
      location: null, isLiveLocation: false, replyTo: null,
    });

    batch.update(fsDb().collection('chats').doc(chatId), {
      'lastMessage.text':      `You blocked ${blockedName}`,
      'lastMessage.senderId':  'system',
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
    });

    const notifRef = fsDb().collection('users').doc(blockedId).collection('notifications').doc();
    batch.set(notifRef, {
      id: notifRef.id, type: 'blocked',
      title: 'You were blocked', message: `${blockerName} blocked you`,
      fromUserId: blockerId, fromUserName: blockerName,
      timestamp: firestore.FieldValue.serverTimestamp(), read: false,
    });

    await batch.commit();
  } catch (error) {
    console.error('[sendBlockNotifications] Error:', error);
  }
}

async function sendUnblockNotifications(
  unblockerId: string, unblockedId: string,
  unblockerName: string, unblockedName: string,
) {
  try {
    const chatsSnap = await fsDb().collection('chats').get();
    let chatId: string | null = null;

    for (const chatDoc of chatsSnap.docs) {
      const data    = chatDoc.data();
      const members = data.members || [];
      if (!data.isGroup && members.length === 2 &&
          members.includes(unblockerId) && members.includes(unblockedId)) {
        chatId = chatDoc.id; break;
      }
    }
    if (!chatId) return;

    const batch  = fsDb().batch();
    const msgRef = fsDb().collection('chats').doc(chatId).collection('messages').doc();
    batch.set(msgRef, {
      messageId: msgRef.id, senderId: 'system',
      text: `UNBLOCK:${unblockerId}:${unblockedId}:${unblockerName}:${unblockedName}`,
      imageUrl: null, voiceUrl: null, videoUrl: null, fileUrl: null,
      type: 'system', timestamp: firestore.FieldValue.serverTimestamp(),
      readBy: [], deliveredTo: [], duration: null, fileName: null,
      fileSize: null, mimeType: null, thumbnailUrl: null,
      location: null, isLiveLocation: false, replyTo: null,
    });
    batch.update(fsDb().collection('chats').doc(chatId), {
      'lastMessage.text':      `You unblocked ${unblockedName}`,
      'lastMessage.senderId':  'system',
      'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
    });
    await batch.commit();
  } catch (error) {
    console.error('[sendUnblockNotifications] Error:', error);
  }
}

export function useBlockedContacts(currentUserId: string | null) {
  const [blockedContacts, setBlockedContacts] = useState<BlockedContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const backend = useBackend('users');

  const reloadBackend = useCallback(async () => {
    const res = await endpoints.listBlocks();
    if (res.ok) {
      setBlockedContacts(
        res.data.blocked.map((b) => ({
          userId: b.userId,
          displayName: b.displayName || 'Unknown',
          photoURL: b.photoObjectKey,
          phone: b.phone ?? undefined,
          blockedAt: new Date(b.blockedAt),
          lastSeenAtBlock: b.lastSeenAtBlock ? new Date(b.lastSeenAtBlock) : undefined,
        })),
      );
    } else {
      setError('error' in res ? String(res.error.code) : 'Failed to load');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!currentUserId) { setBlockedContacts([]); setLoading(false); return; }
    setLoading(true);

    if (backend) {
      void reloadBackend();
      return;
    }

    const unsub = fsDb()
      .collection('users').doc(currentUserId).collection('blockedUsers')
      .onSnapshot(
        (snapshot) => {
          const contacts: BlockedContact[] = snapshot.docs.map((doc) => {
            const data = doc.data();
            return {
              userId:         doc.id,
              displayName:    data.displayName || 'Unknown',
              photoURL:       data.photoURL || null,
              phone:          data.phone || undefined,
              blockedAt:      toDate(data.blockedAt),
              lastSeenAtBlock: data.lastSeenAtBlock ? toDate(data.lastSeenAtBlock) : undefined,
            };
          });
          setBlockedContacts(contacts);
          setLoading(false);
        },
        (err) => { setError(err.message); setLoading(false); },
      );

    return () => unsub();
  }, [currentUserId, backend, reloadBackend]);

  const blockContact = useCallback(
    async (
      userId: string, displayName: string,
      photoURL?: string | null, phone?: string, blockerDisplayName?: string,
    ): Promise<{ success: boolean; error?: string }> => {
      if (!currentUserId) return { success: false, error: 'Not authenticated' };
      try {
        if (backend) {
          const res = await endpoints.blockUser(userId, {
            displayName,
            photoObjectKey: photoURL || null,
            phone: phone || null,
          });
          if (!res.ok) return { success: false, error: String(res.error.code) };
          await reloadBackend();
          return { success: true };
        }

        const currentUserSnap = await fsDb().collection('users').doc(currentUserId).get();
        const currentLastSeen = currentUserSnap.exists ? currentUserSnap.data()!.lastSeen : null;

        await fsDb()
          .collection('users').doc(currentUserId).collection('blockedUsers').doc(userId)
          .set({
            displayName, photoURL: photoURL || null,
            phone: phone || null, blockedAt: new Date(),
            lastSeenAtBlock: currentLastSeen || new Date(),
          });

        await sendBlockNotifications(currentUserId, userId, blockerDisplayName || 'You', displayName);
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    [currentUserId, backend, reloadBackend],
  );

  const unblockContact = useCallback(
    async (
      userId: string, displayName?: string, unblockerDisplayName?: string,
    ): Promise<{ success: boolean; error?: string }> => {
      if (!currentUserId) return { success: false, error: 'Not authenticated' };
      try {
        if (backend) {
          const res = await endpoints.unblockUser(userId);
          if (!res.ok) return { success: false, error: String(res.error.code) };
          await reloadBackend();
          return { success: true };
        }

        const blockedRef  = fsDb().collection('users').doc(currentUserId).collection('blockedUsers').doc(userId);
        const blockedSnap = await blockedRef.get();
        let contactDisplayName = displayName;
        if (!contactDisplayName && blockedSnap.exists) {
          contactDisplayName = blockedSnap.data()!.displayName || 'Unknown';
        }
        await blockedRef.delete();
        if (contactDisplayName) {
          await sendUnblockNotifications(currentUserId, userId, unblockerDisplayName || 'You', contactDisplayName);
        }
        return { success: true };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    },
    [currentUserId, backend, reloadBackend],
  );

  const isContactBlocked = useCallback(
    (userId: string) => blockedContacts.some((c) => c.userId === userId),
    [blockedContacts],
  );

  return { blockedContacts, loading, error, blockContact, unblockContact, isContactBlocked };
}
