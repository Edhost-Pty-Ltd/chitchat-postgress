// ─── useNotificationSync Hook ─────────────────────────────────────────────────
// Syncs real-time events to the in-app notification system via socket.
//
// Sender names follow the app-wide rule: show the name the user saved in their
// phone book for that person, falling back to the sender's own display name,
// then their phone number, then "Someone". The socket only carries the
// sender's uid, so we resolve uid → phone (via the backend profile, cached) →
// saved contact name (via the device phone book).

import { useEffect, useRef, useCallback } from 'react';
import type { AppNotification } from '../context/NotificationContext';
import { socketClient } from '../realtime/socket';
import { endpoints, type BackendMessage } from '../api/endpoints';
import { usePhoneBook } from './usePhoneBook';
import { normalizePhone } from '../utils/phoneUtils';

type PushNotificationFn = (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => void;

/** A uid looks like a Firebase uid (long alphanumeric), not a name or phone. */
function looksLikeUid(s: string): boolean {
  return /^[A-Za-z0-9]{20,}$/.test(s);
}

export function useNotificationSync(userId: string | null, pushNotification: PushNotificationFn) {
  const pushNotificationRef = useRef(pushNotification);
  const unsubscribers       = useRef<(() => void)[]>([]);

  const { contactsMap } = usePhoneBook();
  const contactsMapRef = useRef(contactsMap);
  useEffect(() => { contactsMapRef.current = contactsMap; }, [contactsMap]);

  // Cache the resolved profile (phone + server display name) per sender uid so
  // a burst of messages from the same person doesn't re-fetch.
  const profileCache = useRef<Map<string, { phone: string | null; displayName: string | null }>>(new Map());

  useEffect(() => { pushNotificationRef.current = pushNotification; });

  /**
   * Resolve a sender's uid to the best display name:
   *   saved contact name → sender's own display name → phone number → "Someone".
   * Never shows the raw uid.
   */
  const resolveSenderName = useCallback(async (senderId: string): Promise<string> => {
    let profile = profileCache.current.get(senderId);
    if (!profile) {
      try {
        const res = await endpoints.getUser(senderId);
        profile = res.ok
          ? { phone: res.data.phoneNumber, displayName: res.data.displayName }
          : { phone: null, displayName: null };
      } catch {
        profile = { phone: null, displayName: null };
      }
      profileCache.current.set(senderId, profile);
    }

    // 1. Saved contact name (device phone book), keyed by normalized phone.
    if (profile.phone) {
      const saved = contactsMapRef.current.get(normalizePhone(profile.phone));
      if (saved) return saved;
    }
    // 2. The sender's own display name (if it's a real name, not a uid).
    const dn = (profile.displayName ?? '').trim();
    if (dn && !looksLikeUid(dn)) return dn;
    // 3. Their phone number.
    if (profile.phone) return profile.phone;
    // 4. Last resort — never the raw uid.
    return 'Someone';
  }, []);

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
        const senderName = await resolveSenderName(msg.senderId);
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
        const callerName  = p?.callerId ? await resolveSenderName(p.callerId) : 'Unknown';
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
  }, [userId, resolveSenderName]);
}
