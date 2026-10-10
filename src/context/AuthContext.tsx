// ─── Auth Context ─────────────────────────────────────────────────────────────
//
// Mobile  — session persisted indefinitely via AsyncStorage.
// Web     — session expires after WEB_SESSION_TIMEOUT_MS ms of inactivity.
//
import React, {
  createContext, useContext, useEffect, useState, useCallback, useRef, useMemo,
} from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuth, onAuthStateChanged, signOut as fbSignOut } from '@react-native-firebase/auth';
import { startStatusCleanupService, stopStatusCleanupService } from '../services/statusCleanupService';
import { writePresence } from '../hooks/usePresence';
import { socketClient } from '../realtime/socket';
import { endpoints } from '../api/endpoints';
import { FirebaseAuthTypes } from '@react-native-firebase/auth'; // Add this import at the top
const WEB_SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000; // 4 hours

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
  userId:       string | null;
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
  user:null,
  userId:'' 
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isSignedIn,    setIsSignedIn]        = useState(false);
  const [phone,         setPhone]             = useState('');
  const [displayName,   setDisplayNameState]  = useState('');
  const [avatarUri,     setAvatarUriState]    = useState<string | null>(null);
  const [loading,       setLoading]           = useState(true);
  const [user,          setUser]              = useState<FirebaseAuthTypes.User | null>(null);
  const webTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Clear persisted session first — prevents the onAuthStateChanged listener
    // from triggering a recursive doSignOut call when fbSignOut fires.
    await AsyncStorage.multiRemove([
      KEYS.phone, KEYS.signedIn, KEYS.lastActive, KEYS.displayName, KEYS.avatarUri,
    ]);

    // Update React state before fbSignOut so unmounting components see a clean slate
    setPhone('');
    setDisplayNameState('');
    setAvatarUriState(null);
    setIsSignedIn(false);
    setUser(null);

    try {
      const currentUser = getAuth().currentUser;
      if (currentUser) await writePresence(currentUser.uid, false);
    } catch {}

    stopStatusCleanupService();

    // Disconnect the backend socket and clear its cached state (Req 2.10).
    try {
      socketClient.disconnect();
    } catch {}

    try {
      await fbSignOut(getAuth());
    } catch {}

    isSigningOutRef.current = false;
  };

  // ── Hydrate on mount ──────────────────────────────────────────────────────
  useEffect(() => {
    const maxLoadingTimeout = setTimeout(() => setLoading(false), 10000);

    (async () => {
      try {
        const [signedIn, storedPhone, lastActiveStr, storedName, storedAvatar] = await Promise.all([
          AsyncStorage.getItem(KEYS.signedIn),
          AsyncStorage.getItem(KEYS.phone),
          AsyncStorage.getItem(KEYS.lastActive),
          AsyncStorage.getItem(KEYS.displayName),
          AsyncStorage.getItem(KEYS.avatarUri),
        ]);

        if (storedName)   setDisplayNameState(storedName);
        if (storedAvatar) setAvatarUriState(storedAvatar);

        if (signedIn === 'true' && storedPhone) {
          if (Platform.OS === 'web') {
            const lastActive = lastActiveStr ? parseInt(lastActiveStr, 10) : 0;
            const elapsed    = Date.now() - lastActive;
            if (elapsed >= WEB_SESSION_TIMEOUT_MS) {
              await doSignOut();
            } else {
              setPhone(storedPhone);
              setIsSignedIn(true);
              scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS - elapsed);
            }
          } else {
            setPhone(storedPhone);
            setIsSignedIn(true);
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
          const signedIn = await AsyncStorage.getItem(KEYS.signedIn);
          if (signedIn === 'true') await doSignOut();
        }
        // Signed-in case is handled by the explicit signIn() call
      } catch {}
    });

    if (Platform.OS === 'web') {
      const handleVisibilityChange = async () => {
        if (document.visibilityState !== 'visible') return;
        const [signedIn, lastActiveStr] = await Promise.all([
          AsyncStorage.getItem(KEYS.signedIn),
          AsyncStorage.getItem(KEYS.lastActive),
        ]);
        if (signedIn === 'true' && lastActiveStr) {
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

    // Persist session immediately — navigator can respond right away
    await AsyncStorage.multiSet([
      [KEYS.phone,      phoneNumber],
      [KEYS.signedIn,   'true'],
      [KEYS.lastActive, now],
    ]);

    setPhone(phoneNumber);
    setIsSignedIn(true);

    // Fire-and-forget: fetch displayName/avatar from the backend in background
    // — does NOT block navigation.
    const currentUser = getAuth().currentUser;
    if (currentUser) {
      endpoints.getMe().then((res) => {
        if (!res.ok) return;
        const name  = res.data.displayName || '';
        const photo = res.data.avatarObjectKey || null;
        if (name)  { setDisplayNameState(name);  AsyncStorage.setItem(KEYS.displayName, name); }
        if (photo) { setAvatarUriState(photo);   AsyncStorage.setItem(KEYS.avatarUri, photo); }
      }).catch(() => {});

      // Mark online and start cleanup — non-blocking
      writePresence(currentUser.uid, true).catch(() => {});
      startStatusCleanupService();
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

  const signOut = useCallback(async () => { await doSignOut(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const refreshActivity = useCallback(() => {
    if (Platform.OS !== 'web' || !isSignedIn) return;
    AsyncStorage.setItem(KEYS.lastActive, Date.now().toString());
    scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS);
  }, [isSignedIn, scheduleWebExpiry]);

  // ── Memoized context value — only re-creates when a meaningful value changes
  const value = useMemo<AuthContextValue>(() => ({
    isSignedIn, phone, displayName, setDisplayName,
    avatarUri, setAvatarUri,
    signIn, signOut, refreshActivity, loading,
    user,
    userId: user?.uid ?? null,
  }), [isSignedIn, phone, displayName, avatarUri, loading, signIn, signOut, setDisplayName, setAvatarUri, refreshActivity, user]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {

  return useContext(AuthContext);
}
