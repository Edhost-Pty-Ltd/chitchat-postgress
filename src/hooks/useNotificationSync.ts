// ─── useNotificationSync Hook ─────────────────────────────────────────────────
// Syncs real-time Firestore events to the notification system.

import { useEffect, useRef } from 'react';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import type { AppNotification } from '../context/NotificationContext';
import { resolveNotificationName } from '../utils/resolveNotificationName';

interface LastMessageTimestamp { [chatId: string]: Date; }
type PushNotificationFn = (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => void;

export function useNotificationSync(userId: string | null, pushNotification: PushNotificationFn) {
  const pushNotificationRef      = useRef(pushNotification);
  const lastMessageTimestamps    = useRef<LastMessageTimestamp>({});
  const unsubscribers            = useRef<(() => void)[]>([]);
  const isInitialLoad            = useRef(true);

  useEffect(() => { pushNotificationRef.current = pushNotification; });

  useEffect(() => {
    console.log('[useNotificationSync] Effect triggered, userId:', userId);

    if (!userId) {
      unsubscribers.current.forEach((u) => u());
      unsubscribers.current = [];
      lastMessageTimestamps.current = {};
      isInitialLoad.current = true;
      return;
    }

    console.log('[useNotificationSync] Setting up listeners for userId:', userId);

    const fsDb = db as ReturnType<typeof firestore>;

    // ── 1. New messages ───────────────────────────────────────────
    const unsubChats = fsDb
      .collection('chats')
      .where('members', 'array-contains', userId)
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
              lastMsg.senderId !== userId &&
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
                console.error('[useNotificationSync] Error fetching sender info:', err);
              }
            }
          }
        },
        (error) => console.error('[useNotificationSync] Error in chats listener:', error),
      );

    unsubscribers.current.push(unsubChats);

    // ── 2. Missed / rejected calls ────────────────────────────────
    try {
      const lastCallCheck = new Date();
      console.log('[useNotificationSync] Setting up call history listener, will notify for calls after:', lastCallCheck);

      const unsubCalls = fsDb
        .collection('users').doc(userId).collection('callHistory')
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
                  if (callerSnap.exists) {
                    callerName = await resolveNotificationName(callerSnap.data()!.phone);
                  }
                }
              } catch (err) {
                console.error('[useNotificationSync] Error resolving caller name:', err);
              }

              pushNotificationRef.current({
                type:      'call',
                title:     `${status} ${callType}`,
                body:      `${callerName} tried to ${callData.type === 'video' ? 'video ' : ''}call you`,
                contactId: callData.otherParty?.userId,
              });
            }
          },
          (error) => console.error('[useNotificationSync] Error in call history listener:', error),
        );

      unsubscribers.current.push(unsubCalls);
      console.log('[useNotificationSync] Call history listener set up successfully');
    } catch (error) {
      console.error('[useNotificationSync] Failed to set up call history listener:', error);
    }

    console.log('[useNotificationSync] All listeners set up successfully');
    return () => {
      console.log('[useNotificationSync] Cleaning up listeners');
      unsubscribers.current.forEach((u) => u());
      unsubscribers.current = [];
    };
  }, [userId]);
}
