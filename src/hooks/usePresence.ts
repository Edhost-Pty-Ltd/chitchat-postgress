// ─── usePresence Hook ─────────────────────────────────────────────────────────
// 1. WRITE — keeps the current user's presence current.
// 2. READ  — watches another user's presence in real time.

import { useEffect, useRef, useState, useCallback } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { fetchUserPrivacySettings, isVisibleTo } from './usePrivacySettings';
import { useBackend } from '../config/featureFlags';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export function formatLastSeen(date: Date): string {
  const now = new Date();
  const diffMs    = now.getTime() - date.getTime();
  const diffMins  = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays  = Math.floor(diffMs / 86_400_000);

  if (diffMins  < 1)  return 'last seen just now';
  if (diffMins  < 60) return `last seen ${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `last seen ${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays  === 1)return 'last seen yesterday';
  if (diffDays  < 7)  return `last seen ${diffDays} days ago`;
  return `last seen ${date.toLocaleDateString([], { day: 'numeric', month: 'short', year: diffDays > 365 ? 'numeric' : undefined })}`;
}

export async function writePresence(userId: string, online: boolean): Promise<void> {
  // On the backend path, presence is derived from the live socket connection
  // and its heartbeat; there is nothing to write here (Req 7.1-7.3).
  if (useBackend('presence')) return;
  try {
    const fsDb = db as ReturnType<typeof firestore>;
    await fsDb.collection('users').doc(userId).set(
      { online, lastSeen: firestore.FieldValue.serverTimestamp() },
      { merge: true },
    );
  } catch (err) {
    console.warn('[usePresence] Failed to write presence:', err);
  }
}

export function useWritePresence(userId: string | null) {
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const backend = useBackend('presence');

  useEffect(() => {
    if (!userId) return;

    if (backend) {
      // Online presence follows the socket connection. Ensure it's connected;
      // the SocketClient heartbeat refreshes the server TTL (Req 7.1, 7.2).
      void socketClient.connect();
      const sub = AppState.addEventListener('change', (next) => {
        const prev = appState.current;
        appState.current = next;
        if (next === 'active' && prev !== 'active') {
          void socketClient.connect();
        }
        // When backgrounded, the OS eventually drops the socket and the server
        // presence TTL (60s) marks the user offline — no explicit write needed.
      });
      return () => { sub.remove(); };
    }

    writePresence(userId, true);

    const sub = AppState.addEventListener('change', (next) => {
      const prev = appState.current;
      appState.current = next;
      if (next === 'active' && prev !== 'active') {
        writePresence(userId, true);
      } else if (next.match(/inactive|background/) && prev === 'active') {
        writePresence(userId, false);
      }
    });

    return () => {
      writePresence(userId, false);
      sub.remove();
    };
  }, [userId, backend]);
}

export interface PresenceInfo {
  statusText: string;
  isOnline: boolean;
  photoURL: string | null | undefined;
}

export function useOtherUserPresence(
  otherUserId: string | null,
  isGroup: boolean,
  viewerIsContact?: boolean,
): PresenceInfo {
  const [info, setInfo] = useState<PresenceInfo>({ statusText: '', isOnline: false, photoURL: undefined });
  const backend = useBackend('presence');

  useEffect(() => {
    if (!otherUserId || isGroup) return;

    if (backend) {
      let active = true;
      const apply = (online: boolean, lastSeen: string | null, visible: boolean) => {
        if (!active) return;
        if (online) {
          setInfo({ statusText: visible ? 'Online' : '', isOnline: true, photoURL: null });
        } else if (!visible) {
          setInfo({ statusText: '', isOnline: false, photoURL: null });
        } else {
          const date = lastSeen ? new Date(lastSeen) : null;
          setInfo({ statusText: date ? formatLastSeen(date) : '', isOnline: false, photoURL: null });
        }
      };

      void endpoints.getPresence(otherUserId).then((res) => {
        if (res.ok) apply(res.data.online, res.data.lastSeen, res.data.lastSeenVisible);
      });

      const unsub = socketClient.subscribe('presence', (payload) => {
        const p = payload as { userId?: string; online?: boolean; lastSeen?: string | null };
        if (p?.userId !== otherUserId) return;
        // Live events only arrive from users whose privacy permits visibility.
        apply(!!p.online, p.lastSeen ?? null, true);
      });

      return () => { active = false; unsub(); };
    }

    let cancelled = false;
    let unsubFn: (() => void) | undefined;

    fetchUserPrivacySettings(otherUserId).then((privacy) => {
      if (cancelled) return;

      const lastSeenVisible = isVisibleTo(privacy.lastSeen,     viewerIsContact ?? false);
      const photoVisible    = isVisibleTo(privacy.profilePhoto, viewerIsContact ?? false);

      const fsDb = db as ReturnType<typeof firestore>;
      unsubFn = fsDb.collection('users').doc(otherUserId).onSnapshot((snap) => {
        if (cancelled || !snap.exists) return;
        const data = snap.data()!;
        const online = !!data.online;
        const photoURL = photoVisible ? (data.photoURL || null) : null;

        if (online) {
          setInfo({ statusText: lastSeenVisible ? 'Online' : '', isOnline: true, photoURL });
        } else {
          if (!lastSeenVisible) { setInfo({ statusText: '', isOnline: false, photoURL }); return; }
          const raw = data.lastSeen;
          let date: Date | null = null;
          if (raw) date = typeof raw.toDate === 'function' ? raw.toDate() : new Date(raw);
          setInfo({ statusText: date ? formatLastSeen(date) : '', isOnline: false, photoURL });
        }
      });
    });

    return () => {
      cancelled = true;
      unsubFn?.();
    };
  }, [otherUserId, isGroup, viewerIsContact, backend]);

  return info;
}
