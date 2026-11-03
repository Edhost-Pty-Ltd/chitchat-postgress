// ─── useNetworkState ──────────────────────────────────────────────────────────
// Reactive wrapper around @react-native-community/netinfo. Provides a boolean
// `isOnline` and emits a stable callback `onReconnect` that fires once each time
// the device transitions from offline → online, so callers can flush queues.
//
// The singleton subscription is shared — only one NetInfo listener is ever
// registered regardless of how many components use this hook.

import { useState, useEffect, useRef, useCallback } from 'react';
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

type ReconnectListener = () => void;

// ── Module-level singleton ────────────────────────────────────────────────────
let currentlyOnline = true; // optimistic default until first NetInfo event
const reconnectListeners = new Set<ReconnectListener>();
let netInfoSubscribed = false;

function bootstrapNetInfo() {
  if (netInfoSubscribed) return;
  netInfoSubscribed = true;

  NetInfo.addEventListener((state: NetInfoState) => {
    const nowOnline = state.isConnected === true && state.isInternetReachable !== false;
    const wasOffline = !currentlyOnline;
    currentlyOnline = nowOnline;

    if (wasOffline && nowOnline) {
      // Snapshot the set so listeners added during a flush don't get called.
      for (const fn of Array.from(reconnectListeners)) fn();
    }
  });

  // Seed the initial state synchronously so the first render is accurate.
  NetInfo.fetch().then((state) => {
    currentlyOnline = state.isConnected === true && state.isInternetReachable !== false;
  }).catch(() => {});
}

bootstrapNetInfo();

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Returns `{ isOnline }` that updates reactively whenever connectivity changes.
 *
 * Pass `onReconnect` to run a callback each time the device comes back online
 * (offline → online transition). This is the right place to flush an outbox.
 */
export function useNetworkState(onReconnect?: ReconnectListener): { isOnline: boolean } {
  const [isOnline, setIsOnline] = useState<boolean>(currentlyOnline);
  const callbackRef = useRef<ReconnectListener | undefined>(onReconnect);
  callbackRef.current = onReconnect;

  // Stable wrapper so the Set entry never changes reference.
  const stableReconnect = useCallback(() => {
    callbackRef.current?.();
  }, []);

  useEffect(() => {
    // Register for reconnect events.
    if (onReconnect) {
      reconnectListeners.add(stableReconnect);
    }

    // Subscribe to reactive state changes for the isOnline boolean.
    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      const nowOnline = state.isConnected === true && state.isInternetReachable !== false;
      setIsOnline(nowOnline);
    });

    // Apply current state immediately in case it changed since module load.
    NetInfo.fetch().then((state) => {
      setIsOnline(state.isConnected === true && state.isInternetReachable !== false);
    }).catch(() => {});

    return () => {
      unsubscribe();
      if (onReconnect) reconnectListeners.delete(stableReconnect);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isOnline };
}

/** Imperative check — same logic as the hook but returns a Promise. */
export async function checkIsOnline(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    return state.isConnected === true && state.isInternetReachable !== false;
  } catch {
    return true; // assume online if NetInfo itself fails
  }
}
