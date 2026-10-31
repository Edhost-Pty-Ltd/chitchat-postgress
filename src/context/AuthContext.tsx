// ─── Auth Context ─────────────────────────────────────────────────────────────
//
// Two session kinds:
//   • Primary   — signed in with phone OTP. auth.uid == ownerUid. No companion claim.
//   • Companion — signed in with a custom token (ownerUid + { companion: true }).
//                 auth.uid == ownerUid. Custom claim marks this as a companion.
//
// Because the companion's auth.uid IS the owner's uid, every Firestore rule
// that checks `request.auth.uid` works on both devices. The companion claim
// is what blocks Account-tab writes and delete actions.
//
import React, {
  createContext, useContext, useEffect, useState, useCallback, useRef, useMemo,
} from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getAuth, onAuthStateChanged, signOut as fbSignOut,
  signInWithCustomToken,
} from '@react-native-firebase/auth';
import { endpoints } from '../api/endpoints';
import { mediaService } from '../services/mediaService';
import { socketClient } from '../realtime/socket';
import { startStatusCleanupService, stopStatusCleanupService } from '../services/statusCleanupService';
import { writePresence } from '../hooks/usePresence';
import { FirebaseAuthTypes } from '@react-native-firebase/auth';
import {
  DEVICE_OWNER_KEY,
  registerCurrentDevice,
  verifyCompanionStillLinked,
  useCompanionLinkGuard,
} from '../hooks/useLinkedDevices';

const WEB_SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const KEYS = {
  phone:       'auth_phone',
  signedIn:    'auth_signed_in',
  lastActive:  'auth_last_active',
  displayName: 'auth_display_name',
  avatarUri:   'auth_avatar_uri',
} as const;

interface AuthContextValue {
  isSignedIn:   boolean;
  phone:        string;
  displayName:  string;
  setDisplayName: (name: string) => Promise<void>;
  avatarUri:    string | null;
  setAvatarUri: (uri: string) => Promise<void>;
  signIn:       (phone: string) => Promise<void>;
  signOut:      () => Promise<void>;
  refreshActivity: () => void;
  loading:      boolean;
  user:         FirebaseAuthTypes.User | null;
  authUid:      string | null;
  ownerUid:     string | null;
  userId:       string | null;   // alias of ownerUid for existing screens
  isCompanion:  boolean;
  signInAsCompanion: (ownerUid: string, customToken: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  isSignedIn: false,
  phone: '',
  displayName: '',
  setDisplayName: async () => {},
  avatarUri: null,
  setAvatarUri: async () => {},
  signIn: async () => {},
  signOut: async () => {},
  refreshActivity: () => {},
  loading: true,
  user: null,
  authUid: null,
  ownerUid: null,
  userId: null,
  isCompanion: false,
  signInAsCompanion: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isSignedIn,    setIsSignedIn]        = useState(false);
  const [phone,         setPhone]             = useState('');
  const [displayName,   setDisplayNameState]  = useState('');
  const [avatarUri,     setAvatarUriState]    = useState<string | null>(null);
  const [loading,       setLoading]           = useState(true);
  const [user,          setUser]              = useState<FirebaseAuthTypes.User | null>(null);
  const [isCompanion,   setIsCompanion]       = useState(false);
  const [companionOwnerUid, setCompanionOwnerUidState] = useState<string | null>(null);
  const webTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── COMPANION AUTO-LOGOUT GUARD ─────────────────────────────────────────
  // Listens for the backend's device:removed socket event (with a polling
  // fallback that treats 401 AUTH_TOKEN_REVOKED as "removed") and signs out
  // the companion device as soon as the primary phone removes it.
  useCompanionLinkGuard(isCompanion, companionOwnerUid);
  // ─────────────────────────────────────────────────────────────────────────

  const clearWebTimer = () => {
    if (webTimerRef.current) clearTimeout(webTimerRef.current);
  };

  const scheduleWebExpiry = useCallback((remainingMs: number) => {
    if (Platform.OS !== 'web') return;
    clearWebTimer();
    webTimerRef.current = setTimeout(async () => { await doSignOut(); }, remainingMs);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isSigningOutRef = useRef(false);

  const doSignOut = async () => {
    if (isSigningOutRef.current) return;
    isSigningOutRef.current = true;

    clearWebTimer();

    await AsyncStorage.multiRemove([
      KEYS.phone, KEYS.signedIn, KEYS.lastActive, KEYS.displayName, KEYS.avatarUri,
      DEVICE_OWNER_KEY,
    ]);

    setPhone('');
    setDisplayNameState('');
    setAvatarUriState(null);
    setIsSignedIn(false);
    setUser(null);
    setIsCompanion(false);
    setCompanionOwnerUidState(null);

    try {
      const currentUser = getAuth().currentUser;
      if (currentUser && currentUser.uid) {
        await writePresence(currentUser.uid, false);
      }
    } catch {}

    stopStatusCleanupService();

    try {
      await fbSignOut(getAuth());
    } catch {}

    // Drop the realtime connection: it was authenticated as this session's
    // user, and the shared client would otherwise hand the same socket to the
    // next sign-in (e.g. this device linking as a companion of another account).
    try { socketClient.disconnect(); } catch {}

    isSigningOutRef.current = false;
  };

  // ── Hydrate on mount ──────────────────────────────────────────────────────
  useEffect(() => {
    const maxLoadingTimeout = setTimeout(() => setLoading(false), 10000);

    (async () => {
      try {
        const [signedIn, storedPhone, lastActiveStr, storedName, storedAvatar, companionOwnerUid] =
          await Promise.all([
            AsyncStorage.getItem(KEYS.signedIn),
            AsyncStorage.getItem(KEYS.phone),
            AsyncStorage.getItem(KEYS.lastActive),
            AsyncStorage.getItem(KEYS.displayName),
            AsyncStorage.getItem(KEYS.avatarUri),
            AsyncStorage.getItem(DEVICE_OWNER_KEY),
          ]);

        if (storedName)   setDisplayNameState(storedName);
        if (storedAvatar) setAvatarUriState(storedAvatar);

        if (companionOwnerUid) {
          // ── Companion device: auth.uid should already be the ownerUid (we
          // signed in with a custom token last time). Verify the link is
          // still valid — if the primary removed this device, sign out.
          const stillLinked = await verifyCompanionStillLinked(companionOwnerUid);
          if (!stillLinked) {
            console.warn('[AuthContext] Companion was revoked — signing out.');
            await doSignOut();
          } else {
            let resolvedPhone = storedPhone || '';
            try {
              // Companion is authenticated AS the owner (auth.uid === ownerUid),
              // so /me returns the owner's profile.
              const res = await endpoints.getMe();
              if (res.ok) {
                const data = res.data;
                const name  = data.displayName || '';
                const realP = data.phoneNumber || '';
                if (name)  setDisplayNameState(name);
                if (data.avatarObjectKey) {
                  const url = await mediaService.getDownloadUrl(data.avatarObjectKey);
                  if (url) setAvatarUriState(url);
                }
                if (realP) resolvedPhone = realP;
              }
            } catch {}
            setPhone(resolvedPhone);
            setCompanionOwnerUidState(companionOwnerUid);
            setIsSignedIn(true);
            setIsCompanion(true);
          }
        } else if (signedIn === 'true' && storedPhone) {
          // Primary path
          if (Platform.OS === 'web') {
            const lastActive = lastActiveStr ? parseInt(lastActiveStr, 10) : 0;
            const elapsed    = Date.now() - lastActive;
            if (elapsed >= WEB_SESSION_TIMEOUT_MS) {
              await doSignOut();
            } else {
              setPhone(storedPhone);
              setIsSignedIn(true);
              scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS - elapsed);
              const cu = getAuth().currentUser;
              if (cu) registerCurrentDevice(cu.uid).catch(() => {});
            }
          } else {
            setPhone(storedPhone);
            setIsSignedIn(true);
            const cu = getAuth().currentUser;
            if (cu) registerCurrentDevice(cu.uid).catch(() => {});
          }
        }
      } finally {
        setLoading(false);
      }
    })();

    const unsubscribe = onAuthStateChanged(getAuth(), async (firebaseUser) => {
      setUser(firebaseUser);
      try {
        if (!firebaseUser) {
          const [signedIn, companionOwner] = await Promise.all([
            AsyncStorage.getItem(KEYS.signedIn),
            AsyncStorage.getItem(DEVICE_OWNER_KEY),
          ]);
          if (signedIn === 'true' && !companionOwner) await doSignOut();
        }
      } catch {}
    });

    if (Platform.OS === 'web') {
      const handleVisibilityChange = async () => {
        if (document.visibilityState !== 'visible') return;
        const [signedIn, lastActiveStr, companionOwner] = await Promise.all([
          AsyncStorage.getItem(KEYS.signedIn),
          AsyncStorage.getItem(KEYS.lastActive),
          AsyncStorage.getItem(DEVICE_OWNER_KEY),
        ]);
        if (signedIn === 'true' && lastActiveStr && !companionOwner) {
          const elapsed = Date.now() - parseInt(lastActiveStr, 10);
          if (elapsed >= WEB_SESSION_TIMEOUT_MS) await doSignOut();
          else scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS - elapsed);
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        clearTimeout(maxLoadingTimeout);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        unsubscribe();
      };
    }
    return () => { clearTimeout(maxLoadingTimeout); unsubscribe(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Public API ────────────────────────────────────────────────────────────
  const signIn = useCallback(async (phoneNumber: string) => {
    const now = Date.now().toString();

    await AsyncStorage.multiSet([
      [KEYS.phone,      phoneNumber],
      [KEYS.signedIn,   'true'],
      [KEYS.lastActive, now],
    ]);

    await AsyncStorage.removeItem(DEVICE_OWNER_KEY);

    setPhone(phoneNumber);
    setIsSignedIn(true);
    setIsCompanion(false);
    setCompanionOwnerUidState(null);

    const currentUser = getAuth().currentUser;
    if (currentUser) {
      endpoints.getMe().then(async (res) => {
        if (!res.ok) return;
        const data = res.data;
        const name = data.displayName || '';
        if (name) { setDisplayNameState(name); AsyncStorage.setItem(KEYS.displayName, name); }
        if (data.avatarObjectKey) {
          const url = await mediaService.getDownloadUrl(data.avatarObjectKey);
          if (url) { setAvatarUriState(url); AsyncStorage.setItem(KEYS.avatarUri, url); }
        }
      }).catch(() => {});

      writePresence(currentUser.uid, true).catch(() => {});
      startStatusCleanupService();
      registerCurrentDevice(currentUser.uid).catch(() => {});
    }

    if (Platform.OS === 'web') scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS);
  }, [scheduleWebExpiry]);

  const setDisplayName = useCallback(async (name: string) => {
    setDisplayNameState(name);
    await AsyncStorage.setItem(KEYS.displayName, name);
  }, []);

  const setAvatarUri = useCallback(async (uri: string) => {
    setAvatarUriState(uri);
    await AsyncStorage.setItem(KEYS.avatarUri, uri);
  }, []);

  // ── signInAsCompanion ─────────────────────────────────────────────────────
  // Signs this device in with a Firebase Custom Token that carries the
  // owner's uid and the { companion: true } claim. After this, auth.uid is
  // the owner's uid and rules that check request.auth.uid pass automatically.
  const signInAsCompanion = useCallback(async (ownerUid: string, customToken: string) => {
    // 1. Sign in with the custom token
    try {
      await signInWithCustomToken(getAuth(), customToken);
    } catch (err: any) {
      console.error('[AuthContext] signInWithCustomToken failed:', err);
      throw err;
    }

    // 2. Fetch the owner's profile for display. After signInWithCustomToken the
    // auth.uid is the owner's uid, so /me returns the owner's profile.
    let resolvedPhone = '';
    try {
      const res = await endpoints.getMe();
      if (res.ok) {
        const data = res.data;
        const name  = data.displayName || '';
        const realP = data.phoneNumber || '';
        if (name)  { setDisplayNameState(name);  await AsyncStorage.setItem(KEYS.displayName, name); }
        if (data.avatarObjectKey) {
          const url = await mediaService.getDownloadUrl(data.avatarObjectKey);
          if (url) { setAvatarUriState(url); await AsyncStorage.setItem(KEYS.avatarUri, url); }
        }
        if (realP) resolvedPhone = realP;
      }
    } catch {}

    // 3. Persist companion marker
    await AsyncStorage.multiSet([
      [KEYS.phone,       resolvedPhone],
      [KEYS.signedIn,    'true'],
      [KEYS.lastActive,  Date.now().toString()],
      [DEVICE_OWNER_KEY, ownerUid],
    ]);

    setPhone(resolvedPhone);
    setCompanionOwnerUidState(ownerUid);
    setIsSignedIn(true);
    setIsCompanion(true);

    if (Platform.OS === 'web') scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS);
  }, [scheduleWebExpiry]);

  const signOut = useCallback(async () => { await doSignOut(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshActivity = useCallback(() => {
    if (Platform.OS !== 'web' || !isSignedIn || isCompanion) return;
    AsyncStorage.setItem(KEYS.lastActive, Date.now().toString());
    scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS);
  }, [isSignedIn, isCompanion, scheduleWebExpiry]);

  // A Firebase user exists immediately after OTP. Do not expose it as the app
  // owner until `signIn` runs after POST /me/register succeeds; otherwise push,
  // socket and device hooks fire during the mandatory face step.
  const authUid = user?.uid ?? null;
  const ownerUid = isSignedIn
    ? (isCompanion ? companionOwnerUid : (user?.uid ?? null))
    : null;

  const value = useMemo<AuthContextValue>(() => ({
    isSignedIn, phone, displayName, setDisplayName,
    avatarUri, setAvatarUri,
    signIn, signOut, refreshActivity, loading,
    user,
    authUid,
    ownerUid,
    userId: ownerUid,
    isCompanion,
    signInAsCompanion,
  }), [
    isSignedIn, phone, displayName, avatarUri, loading,
    signIn, signOut, setDisplayName, setAvatarUri, refreshActivity,
    user, authUid, ownerUid, isCompanion, signInAsCompanion,
  ]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}