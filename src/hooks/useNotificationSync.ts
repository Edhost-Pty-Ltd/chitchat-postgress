// ─── useNotificationSync Hook ─────────────────────────────────────────────────
// Syncs real-time events to the in-app notification system via socket.

import { useEffect, useRef } from 'react';
import type { AppNotification } from '../context/NotificationContext';
import { socketClient } from '../realtime/socket';
import type { BackendMessage } from '../api/endpoints';

type PushNotificationFn = (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => void;

export function useNotificationSync(userId: string | null, pushNotification: PushNotificationFn) {
  const pushNotificationRef = useRef(pushNotification);
  const unsubscribers       = useRef<(() => void)[]>([]);

  useEffect(() => { pushNotificationRef.current = pushNotification; });

  useEffect(() => {
    if (!userId) {
      unsubscribers.current.forEach((u) => u());
      unsubscribers.current = [];
      return;
    }

    void socketClient.connect();

    const unsubMessage = socketClient.subscribe('message:new', async (payload) => {
      const p = payload as {
        message?: Pick<BackendMessage, 'chatId' | 'senderId' | 'text' | 'type'>;
        chat?:    { type?: string; groupName?: string | null };
      };
      const msg  = p?.message;
      const chat = p?.chat;
      if (!msg?.chatId || !msg.senderId || msg.senderId === userId) return;

      try {
        const senderName = msg.senderId;
        const chatName   = chat?.type === 'group' && chat.groupName ? chat.groupName : senderName;
        await pushNotificationRef.current({
          type:      'message',
          title:     chatName,
          body:      chat?.type === 'group'
            ? `${senderName}: ${msg.text || 'Sent a media file'}`
            : (msg.text || 'Sent a media file'),
          contactId: chat?.type === 'direct' ? msg.senderId : undefined,
        });
      } catch (err) {
        console.error('[useNotificationSync] message:new error:', err);
      }
    });
    unsubscribers.current.push(unsubMessage);

    const unsubCalls = socketClient.subscribe('call:missed', async (payload) => {
      const p = payload as { callId?: string; callerId?: string; type?: string };
      try {
        const callType   = p?.type === 'video' ? 'Video Call' : 'Call';
        const callerName = p?.callerId ?? 'Unknown';
        pushNotificationRef.current({
          type:      'call',
          title:     `Missed ${callType}`,
          body:      `${callerName} tried to ${p?.type === 'video' ? 'video ' : ''}call you`,
          contactId: p?.callerId,
        });
      } catch (err) {
        console.error('[useNotificationSync] call:missed error:', err);
      }
    });
    unsubscribers.current.push(unsubCalls);

    return () => {
      unsubscribers.current.forEach((u) => u());
      unsubscribers.current = [];
    };
  }, [userId]);
}
