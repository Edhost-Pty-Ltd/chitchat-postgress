// ─── usePresence Hook ─────────────────────────────────────────────────────────
// Online presence via Socket.IO. The server tracks presence through the live
// socket connection and its heartbeat (Req 7.1-7.3) — nothing to write here.

import { useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';

export function formatLastSeen(date: Date): string {
  const now = new Date();
  const diffMs    = now.getTime() - date.getTime();
  const diffMins  = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays  = Math.floor(diffMs / 86_400_000);

  if (diffMins  < 1)   return 'last seen just now';
  if (diffMins  < 60)  return `last seen ${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24)  return `last seen ${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  if (diffDays  === 1) return 'last seen yesterday';
  if (diffDays  < 7)   return `last seen ${diffDays} days ago`;
  return `last seen ${date.toLocaleDateString([], {
    day: 'numeric', month: 'short',
    year: diffDays > 365 ? 'numeric' : undefined,
  })}`;
}

/** No-op on the backend path — presence follows the socket connection. */
export async function writePresence(_userId: string, _online: boolean): Promise<void> {}

export function useWritePresence(userId: string | null) {
  const appState = useRef<AppStateStatus>(AppState.currentState);

  useEffect(() => {
    if (!userId) return;
    void socketClient.connect();
    const sub = AppState.addEventListener('change', (next) => {
      const prev = appState.current;
      appState.current = next;
      if (next === 'active' && prev !== 'active') void socketClient.connect();
    });
    return () => { sub.remove(); };
  }, [userId]);
}

export interface PresenceInfo {
  statusText: string;
  isOnline:   boolean;
  photoURL:   string | null | undefined;
}

export function useOtherUserPresence(
  otherUserId:      string | null,
  isGroup:          boolean,
  _viewerIsContact?: boolean,
): PresenceInfo {
  const [info, setInfo] = useState<PresenceInfo>({ statusText: '', isOnline: false, photoURL: undefined });

  useEffect(() => {
    if (!otherUserId || isGroup) return;
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
      apply(!!p.online, p.lastSeen ?? null, true);
    });

    return () => { active = false; unsub(); };
  }, [otherUserId, isGroup]);

  return info;
}
