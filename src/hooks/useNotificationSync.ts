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
import { muteStore } from '../state/muteStore';

type PushNotificationFn = (n: Omit<AppNotification, 'id' | 'time' | 'read'>) => void;

/** A uid looks like a Firebase uid (long alphanumeric), not a name or phone. */
function looksLikeUid(s: string): boolean {
  return /^[A-Za-z0-9]{20,}$/.test(s);
}

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

  const { contactsMap } = usePhoneBook();
  const contactsMapRef = useRef(contactsMap);
  useEffect(() => { contactsMapRef.current = contactsMap; }, [contactsMap]);

  // Cache the resolved profile (phone + server display name) per sender uid so
  // a burst of messages from the same person doesn't re-fetch.
  const profileCache = useRef<Map<string, { phone: string | null; displayName: string | null }>>(new Map());

  useEffect(() => { pushNotificationRef.current = pushNotification; });
  useEffect(() => { resolveNameRef.current = resolveSenderName; });

  /**
   * Resolve a sender's uid to the best display name:
   *   saved contact name → sender's own display name → phone number → "Someone".
   * Never shows the raw uid.
   */
  const resolveNameFromUid = useCallback(async (senderId: string): Promise<string> => {
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
        const fallback = p.senderName || await resolveNameFromUid(msg.senderId);
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
        const callerName  = p?.callerId ? await resolveNameFromUid(p.callerId) : 'Unknown';
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
  }, [userId, resolveNameFromUid]);
}
