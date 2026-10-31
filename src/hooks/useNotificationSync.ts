// ─── useNotificationSync Hook ─────────────────────────────────────────────────
// Syncs real-time events to the in-app notification system via socket.

import { useEffect, useRef } from 'react';
import type { AppNotification } from '../context/NotificationContext';
import { socketClient } from '../realtime/socket';
import { endpoints } from '../api/endpoints';
import type { BackendMessage } from '../api/endpoints';
import { muteStore } from '../state/muteStore';

type PushNotificationFn = (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => void;

/** Resolve a saved contact name from a phone number (device phone book). */
type NameResolver = (phone: string | null | undefined, fallback: string) => string;

export function useNotificationSync(
  userId: string | null,
  pushNotification: PushNotificationFn,
  resolveSenderName?: NameResolver,
) {
  const pushNotificationRef = useRef(pushNotification);
  const resolveNameRef      = useRef(resolveSenderName);
  const unsubscribers       = useRef<(() => void)[]>([]);

  useEffect(() => { pushNotificationRef.current = pushNotification; });
  useEffect(() => { resolveNameRef.current = resolveSenderName; });

  useEffect(() => {
    if (!userId) {
      unsubscribers.current.forEach((u) => u());
      unsubscribers.current = [];
      return;
    }

    void socketClient.connect();

    // Keep the shared mute store fresh from the server's authoritative
    // active-mute list so muted chats raise no in-app notification. The list
    // endpoint already excludes expired mutes; we refresh on connect and on a
    // slow interval to catch mutes that lapse or change elsewhere.
    let cancelled = false;
    const refreshMuted = async () => {
      try {
        const res = await endpoints.listMutedChats();
        if (!cancelled && res.ok) muteStore.hydrate(res.data.chatIds);
      } catch { /* keep the current store on failure */ }
    };
    void refreshMuted();
    const muteRefreshTimer = setInterval(refreshMuted, 60_000);

    const unsubMessage = socketClient.subscribe('message:new', async (payload) => {
      const p = payload as {
        message?:    Pick<BackendMessage, 'chatId' | 'senderId' | 'text' | 'type'>;
        chat?:       { type?: string; groupName?: string | null };
        senderName?: string;
        senderPhone?: string | null;
      };
      const msg  = p?.message;
      const chat = p?.chat;
      // Never notify the sender for their own message.
      if (!msg?.chatId || !msg.senderId || msg.senderId === userId) return;

      // Muted chat → deliver the message in-app but raise no notification.
      if (muteStore.isMuted(msg.chatId)) return;

      try {
        // Prefer the name saved in the viewer's own contacts (resolved by the
        // sender's phone), then the sender's profile name, then — last resort —
        // the raw id. Never show the bare uid when we have anything better.
        const resolve  = resolveNameRef.current;
        const fallback = p.senderName || msg.senderId;
        const person   = resolve ? resolve(p.senderPhone, fallback) : fallback;
        const isGroup  = chat?.type === 'group';
        const title    = isGroup && chat?.groupName ? chat.groupName : person;
        const bodyText = msg.text || 'Sent a media file';
        await pushNotificationRef.current({
          type:      'message',
          title,
          body:      isGroup ? `${person}: ${bodyText}` : bodyText,
          contactId: isGroup ? undefined : msg.senderId,
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
      cancelled = true;
      clearInterval(muteRefreshTimer);
      unsubscribers.current.forEach((u) => u());
      unsubscribers.current = [];
    };
  }, [userId]);
}
