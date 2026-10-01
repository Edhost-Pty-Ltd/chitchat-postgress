// ─── useNotificationSync Hook ─────────────────────────────────────────────────
// Syncs real-time Firestore events to the notification system.
//
// COMPANION NOTE
//   `ownerUid` is the real account uid. On a companion the Chats and Call
//   History listeners may receive permission-denied while companionLinks
//   propagates. Retry with backoff.

import { useEffect, useRef } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import type { AppNotification } from '../context/NotificationContext';
import { resolveNotificationName } from '../utils/resolveNotificationName';

interface LastMessageTimestamp { [chatId: string]: Date; }
type PushNotificationFn = (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => void;

const MAX_PERM_RETRIES = 8;

export function useNotificationSync(ownerUid: string | null, pushNotification: PushNotificationFn) {
  const pushNotificationRef      = useRef(pushNotification);
  const lastMessageTimestamps    = useRef<LastMessageTimestamp>({});
  const unsubscribers            = useRef<(() => void)[]>([]);
  const isInitialLoad            = useRef(true);

  useEffect(() => { pushNotificationRef.current = pushNotification; });

  useEffect(() => {
    if (!ownerUid) {
      unsubscribers.current.forEach((u) => u());
      unsubscribers.current = [];
      lastMessageTimestamps.current = {};
      isInitialLoad.current = true;
      return;
    }

    let cancelled = false;
    const fsDb = db as ReturnType<typeof firestore>;

    // ── 1. New messages (with permission-denied retry) ─────────────────────
    let chatAttempt = 0;
    let chatUnsub: (() => void) | null = null;
    let chatRetryTimer: ReturnType<typeof setTimeout> | null = null;

    const attachChatsListener = () => {
      if (cancelled) return;
      chatUnsub = fsDb
        .collection('chats')
        .where('members', 'array-contains', ownerUid)
        .onSnapshot(
          async (chatsSnap) => {
            if (isInitialLoad.current) {
              chatsSnap.docs.forEach((chatDoc) => {
                const lm = chatDoc.data().lastMessage;
                if (lm?.timestamp) {
                  lastMessageTimestamps.current[chatDoc.id] =
                    typeof lm.timestamp.toDate === 'function'
                      ? lm.timestamp.toDate()
                      : new Date(lm.timestamp);
                }
              });
              isInitialLoad.current = false;
              return;
            }

            for (const change of chatsSnap.docChanges()) {
              if (change.type !== 'modified' && change.type !== 'added') continue;
              const chatId   = change.doc.id;
              const chatData = change.doc.data();
              const lastMsg  = chatData.lastMessage;

              if (!lastMsg?.timestamp) continue;

              const lastMsgTime  = typeof lastMsg.timestamp.toDate === 'function'
                ? lastMsg.timestamp.toDate() : new Date(lastMsg.timestamp);
              const lastKnownTime = lastMessageTimestamps.current[chatId];

              if (
                lastMsg.senderId !== ownerUid &&
                (!lastKnownTime || lastMsgTime > lastKnownTime)
              ) {
                lastMessageTimestamps.current[chatId] = lastMsgTime;
                try {
                  const senderSnap = await fsDb.collection('users').doc(lastMsg.senderId).get();
                  if (!senderSnap.exists) continue;
                  const senderPhone = senderSnap.data()!.phone;
                  const senderName  = await resolveNotificationName(senderPhone);
                  const chatName    = chatData.type === 'group' && chatData.groupName
                    ? chatData.groupName : senderName;

                  await pushNotificationRef.current({
                    type:  'message',
                    title: chatName,
                    body:  chatData.type === 'group'
                      ? `${senderName}: ${lastMsg.text || 'Sent a media file'}`
                      : (lastMsg.text || 'Sent a media file'),
                    contactId: chatData.type === 'direct' ? lastMsg.senderId : undefined,
                  });
                } catch (err) {
                  console.warn('[useNotificationSync] Sender lookup failed (ignored):', err);
                }
              }
            }
          },
          (err) => {
            if (cancelled) return;
            const isPerm =
              err?.message === 'firestore/permission-denied' ||
              /permission-denied/i.test(err?.message || '');
            if (isPerm && chatAttempt < MAX_PERM_RETRIES) {
              const delay = Math.min(200 * (chatAttempt + 1), 2000);
              chatAttempt += 1;
              console.warn(
                `[useNotificationSync] chats permission-denied — retry ${chatAttempt}/${MAX_PERM_RETRIES} in ${delay}ms`,
              );
              chatRetryTimer = setTimeout(attachChatsListener, delay);
              return;
            }
            console.error('[useNotificationSync] Error in chats listener:', err);
          },
        );
    };

    attachChatsListener();

    // ── 2. Missed / rejected calls (permission-safe) ────────────────────────
    const lastCallCheck = new Date();
    let callsUnsub: (() => void) | null = null;
    try {
      callsUnsub = fsDb
        .collection('users').doc(ownerUid).collection('callHistory')
        .where('direction', '==', 'incoming')
        .where('status', 'in', ['missed', 'rejected'])
        .orderBy('timestamp', 'desc')
        .onSnapshot(
          async (callsSnap) => {
            for (const change of callsSnap.docChanges()) {
              if (change.type !== 'added') continue;
              const callData = change.doc.data();
              const callTime = callData.timestamp
                ? (typeof callData.timestamp.toDate === 'function'
                    ? callData.timestamp.toDate()
                    : new Date(callData.timestamp))
                : new Date();

              if (callTime <= lastCallCheck) continue;

              const callType = callData.type === 'video' ? 'Video Call' : 'Call';
              const status   = callData.status === 'missed' ? 'Missed' : 'Rejected';
              let callerName = 'Unknown';

              try {
                if (callData.otherParty?.userId) {
                  const callerSnap = await fsDb.collection('users').doc(callData.otherParty.userId).get();
                  if (callerSnap.exists()) {
                    callerName = await resolveNotificationName(callerSnap.data()!.phone);
                  }
                }
              } catch (err) {
                console.warn('[useNotificationSync] Caller lookup failed (ignored):', err);
              }

              pushNotificationRef.current({
                type:      'call',
                title:     `${status} ${callType}`,
                body:      `${callerName} tried to ${callData.type === 'video' ? 'video ' : ''}call you`,
                contactId: callData.otherParty?.userId,
              });
            }
          },
          (err) => {
            // Call history may be unavailable while the companion link is
            // still propagating — log quietly instead of erroring.
            console.warn('[useNotificationSync] callHistory listener:', (err as any)?.code || err);
          },
        );
    } catch (err) {
      console.warn('[useNotificationSync] Failed to attach callHistory listener:', err);
    }

    return () => {
      cancelled = true;
      if (chatRetryTimer) clearTimeout(chatRetryTimer);
      chatUnsub?.();
      callsUnsub?.();
      unsubscribers.current.forEach((u) => u());
      unsubscribers.current = [];
    };
  }, [ownerUid]);
}