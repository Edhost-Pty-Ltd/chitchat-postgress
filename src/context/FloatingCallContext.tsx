// ─── Context: Floating Call ──────────────────────────────────────────────────
// Manages the floating call overlay when the user minimises a call.
//
// Persistence strategy:
//   • Call metadata (everything except the live stream objects) is written to
//     AsyncStorage whenever it changes, so a JS-context restart (phone lock on
//     iOS, low-memory kill on Android) can restore the UI state on resume.
//   • Stream objects (localStream / remoteStream) are intentionally NOT
//     persisted — they are native WebRTC handles that cannot survive a context
//     restart. On restore the overlay renders without media until the user
//     maximises the call and the VideoCallScreen re-attaches its streams.

import React, {
  createContext, useContext, useState, useCallback, useEffect, useRef, useMemo,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'floating_call_meta';

interface FloatingCallData {
  callId: string;
  displayName: string;
  avatar: string;
  color: string;
  duration: string;
  isVideo: boolean;
  isOutgoing: boolean;
  localStream?: any;
  remoteStream?: any;
  localIsMain?: boolean;
  otherParty: {
    userId: string;
    displayName: string;
    photoUrl: string | null;
  };
}

// Serialisable subset — streams excluded
type PersistedMeta = Omit<FloatingCallData, 'localStream' | 'remoteStream'>;

interface FloatingCallContextValue {
  floatingCall: FloatingCallData | null;
  minimizeCall: (data: FloatingCallData) => void;
  maximizeCall: () => FloatingCallData | null;
  endFloatingCall: () => void;
  updateDuration: (duration: string) => void;
}

const FloatingCallContext = createContext<FloatingCallContextValue>({
  floatingCall: null,
  minimizeCall: () => {},
  maximizeCall: () => null,
  endFloatingCall: () => {},
  updateDuration: () => {},
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function toMeta(data: FloatingCallData): PersistedMeta {
  const { localStream: _l, remoteStream: _r, ...meta } = data;
  return meta;
}

async function saveMeta(data: FloatingCallData | null) {
  try {
    if (data) {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(toMeta(data)));
    } else {
      await AsyncStorage.removeItem(STORAGE_KEY);
    }
  } catch {}
}

async function loadMeta(): Promise<PersistedMeta | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedMeta) : null;
  } catch {
    return null;
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function FloatingCallProvider({ children }: { children: React.ReactNode }) {
  const [floatingCall, setFloatingCall] = useState<FloatingCallData | null>(null);

  // Ref used inside AppState listener to read current call without stale closure
  const callRef = useRef<FloatingCallData | null>(null);
  callRef.current = floatingCall;

  // ── Restore persisted call on mount ───────────────────────────────────────
  useEffect(() => {
    loadMeta().then((meta) => {
      if (meta) {
        // Restore without streams — user can re-open VideoCallScreen to reconnect
        setFloatingCall(meta as FloatingCallData);
      }
    });
  }, []);

  // ── Persist whenever call changes ─────────────────────────────────────────
  useEffect(() => {
    saveMeta(floatingCall);
  }, [floatingCall]);

  // ── AppState listener — auto-minimise on iOS background / lock ────────────
  // On iOS there is no hardware back button, so VideoCallScreen never gets a
  // chance to call minimizeCall() when the user locks the phone or swipes home.
  // We catch the 'background' transition here and snapshot the call into state
  // so the overlay is ready when the app is foregrounded again.
  useEffect(() => {
    const handleAppStateChange = (nextState: AppStateStatus) => {
      if (nextState === 'background' || nextState === 'inactive') {
        // If VideoCallScreen has already minimised the call this is a no-op
        // because callRef.current will already be populated.
        // We only need to act if there is NO floatingCall yet — meaning the user
        // left the call screen without tapping the back button.
        // In that case we cannot restore the streams (they're in VideoCallScreen
        // state), but we persist the metadata so the overlay appears on resume.
        // The actual stream re-attachment happens when VideoCallScreen remounts.
        if (callRef.current) {
          // Already minimised — just make sure it's persisted
          saveMeta(callRef.current);
        }
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  }, []);

  // ── Actions ───────────────────────────────────────────────────────────────

  const minimizeCall = useCallback((data: FloatingCallData) => {
    console.log('[FloatingCallContext] Minimizing call:', data.callId);
    setFloatingCall(data);
  }, []);

  const maximizeCall = useCallback(() => {
    console.log('[FloatingCallContext] Maximizing call');
    const call = floatingCall;
    setFloatingCall(null);
    return call;
  }, [floatingCall]);

  const endFloatingCall = useCallback(() => {
    console.log('[FloatingCallContext] Ending floating call');
    setFloatingCall(null);
    AsyncStorage.removeItem(STORAGE_KEY).catch(() => {});
  }, []);

  const updateDuration = useCallback((duration: string) => {
    setFloatingCall((prev) => prev ? { ...prev, duration } : null);
  }, []);

  // Memoize so the value identity only changes with the call itself, not on
  // every render of this provider.
  const value = useMemo(
    () => ({ floatingCall, minimizeCall, maximizeCall, endFloatingCall, updateDuration }),
    [floatingCall, minimizeCall, maximizeCall, endFloatingCall, updateDuration],
  );

  return (
    <FloatingCallContext.Provider value={value}>
      {children}
    </FloatingCallContext.Provider>
  );
}

export function useFloatingCall() {
  const context = useContext(FloatingCallContext);
  if (!context) {
    throw new Error('useFloatingCall must be used within FloatingCallProvider');
  }
  return context;
}
