// ─── Auth Context ─────────────────────────────────────────────────────────────
//
// Behaviour:
//   Mobile  – once signed in, the session is persisted indefinitely via
//             AsyncStorage. The user never has to sign in again unless they
//             explicitly sign out.
//
//   Web     – session expires after WEB_SESSION_TIMEOUT_MS ms of inactivity
//             (default: 4 hours).  Every auth-guarded interaction refreshes
//             the "last active" timestamp.  When the tab regains focus or the
//             app mounts, we check whether the timeout has elapsed and redirect
//             to Sign In if so.
//
import React, {
  createContext, useContext, useEffect, useState, useCallback, useRef,
} from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuth, onAuthStateChanged, signOut as fbSignOut } from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { startStatusCleanupService, stopStatusCleanupService } from '../services/statusCleanupService';
import { writePresence } from '../hooks/usePresence';

// 4 hours in milliseconds
const WEB_SESSION_TIMEOUT_MS = 4 * 60 * 60 * 1000;

const KEYS = {
  phone:       'auth_phone',
  signedIn:    'auth_signed_in',
  lastActive:  'auth_last_active',
  displayName: 'auth_display_name',
  avatarUri:   'auth_avatar_uri',
} as const;

interface AuthContextValue {
  isSignedIn: boolean;
  phone: string;
  displayName: string;
  setDisplayName: (name: string) => Promise<void>;
  avatarUri: string | null;
  setAvatarUri: (uri: string) => Promise<void>;
  signIn: (phone: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshActivity: () => void;
  loading: boolean;
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
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isSignedIn, setIsSignedIn]         = useState(false);
  const [phone, setPhone]                   = useState('');
  const [displayName, setDisplayNameState]  = useState('');
  const [avatarUri, setAvatarUriState]      = useState<string | null>(null);
  const [loading, setLoading]               = useState(true);
  const webTimerRef                 = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Helpers ──────────────────────────────────────────────────────────────

  const clearWebTimer = () => {
    if (webTimerRef.current) clearTimeout(webTimerRef.current);
  };

  const scheduleWebExpiry = useCallback((remainingMs: number) => {
    if (Platform.OS !== 'web') return;
    clearWebTimer();
    webTimerRef.current = setTimeout(async () => {
      await doSignOut();
    }, remainingMs);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const doSignOut = async () => {
    clearWebTimer();
    // Mark the user offline before clearing auth
    try {
      const currentUser = getAuth().currentUser;
      if (currentUser) await writePresence(currentUser.uid, false);
    } catch {}
    // Stop status cleanup service
    stopStatusCleanupService();
    // Sign out from Firebase Auth
    await fbSignOut(getAuth());
    // Clear AsyncStorage session data
    await AsyncStorage.multiRemove([
      KEYS.phone,
      KEYS.signedIn,
      KEYS.lastActive,
      KEYS.displayName,
      KEYS.avatarUri,
    ]);
    setPhone('');
    setIsSignedIn(false);
    setDisplayNameState('');
    setAvatarUriState(null);
  };

  // ── Hydrate on mount ──────────────────────────────────────────────────────

  useEffect(() => {
    // Set a maximum loading timeout to prevent infinite loading
    const maxLoadingTimeout = setTimeout(() => {
      console.warn('[AuthContext] Maximum loading time reached, forcing app to open');
      setLoading(false);
    }, 10000); // 10 seconds max loading time

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
            // Check inactivity timeout
            const lastActive = lastActiveStr ? parseInt(lastActiveStr, 10) : 0;
            const elapsed    = Date.now() - lastActive;

            if (elapsed >= WEB_SESSION_TIMEOUT_MS) {
              // Session expired — clean up and show Sign In
              await doSignOut();
            } else {
              setPhone(storedPhone);
              setIsSignedIn(true);
              scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS - elapsed);
            }
          } else {
            // Mobile — no expiry
            setPhone(storedPhone);
            setIsSignedIn(true);
          }
        }
      } finally {
        setLoading(false);
      }
    })();

    // Listen to Firebase auth state changes
    const unsubscribe = onAuthStateChanged(getAuth(), async (user) => {
      try {
        console.log('[AuthContext] Firebase auth state changed:', user?.uid);
        
        if (!user) {
          // User signed out in Firebase, sync with local state
          const signedIn = await AsyncStorage.getItem(KEYS.signedIn);
          if (signedIn === 'true') {
            console.log('[AuthContext] Firebase signed out but local state says signed in, cleaning up...');
            await doSignOut();
          }
        } else {
          // User signed in to Firebase
          const signedIn = await AsyncStorage.getItem(KEYS.signedIn);
          if (signedIn !== 'true') {
            console.log('[AuthContext] Firebase signed in but local state not updated');
            // This case is handled by explicit signIn() call
          }
        }
      } catch (error: any) {
        // Catch and log any errors from auth state listener
        // Don't let these crash the app
        console.error('[AuthContext] Error in auth state listener:', error);
      }
    });

    // On web, also check whenever the tab becomes visible again
    if (Platform.OS === 'web') {
      const handleVisibilityChange = async () => {
        if (document.visibilityState === 'visible') {
          const [signedIn, lastActiveStr] = await Promise.all([
            AsyncStorage.getItem(KEYS.signedIn),
            AsyncStorage.getItem(KEYS.lastActive),
          ]);
          if (signedIn === 'true' && lastActiveStr) {
            const elapsed = Date.now() - parseInt(lastActiveStr, 10);
            if (elapsed >= WEB_SESSION_TIMEOUT_MS) {
              await doSignOut();
            } else {
              scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS - elapsed);
            }
          }
        }
      };
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => {
        clearTimeout(maxLoadingTimeout);
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        unsubscribe();
      };
    }
    
    return () => {
      clearTimeout(maxLoadingTimeout);
      unsubscribe();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Public API ────────────────────────────────────────────────────────────

  const signIn = async (phoneNumber: string) => {
    try {
      console.log('[AuthContext] Starting signIn for:', phoneNumber);
      const now = Date.now().toString();
      
      // Save basic session data to AsyncStorage
      await AsyncStorage.multiSet([
        [KEYS.phone,      phoneNumber],
        [KEYS.signedIn,   'true'],
        [KEYS.lastActive, now],
      ]);
      console.log('[AuthContext] Session data saved to AsyncStorage');
      
      // Fetch user profile from Firestore and populate displayName and avatarUri
      try {
        const currentUser = getAuth().currentUser;
        
        console.log('[AuthContext] Current Firebase user:', currentUser?.uid);
        
        if (currentUser) {
          const fsDb = db as ReturnType<typeof firestore>;
          console.log('[AuthContext] Fetching user profile from Firestore...');
          
          const userSnap = await fsDb.collection('users').doc(currentUser.uid).get();
          
          if (userSnap.exists) {
            const userData = userSnap.data()!;
            const firestoreDisplayName = userData.displayName || '';
            const firestorePhotoURL = userData.photoURL || null;
            
            console.log('[AuthContext] Profile found in Firestore:', {
              displayName: firestoreDisplayName,
              photoURL: firestorePhotoURL,
            });
            
            // Update state
            if (firestoreDisplayName) {
              setDisplayNameState(firestoreDisplayName);
              await AsyncStorage.setItem(KEYS.displayName, firestoreDisplayName);
            }
            
            if (firestorePhotoURL) {
              setAvatarUriState(firestorePhotoURL);
              await AsyncStorage.setItem(KEYS.avatarUri, firestorePhotoURL);
            }
          } else {
            console.log('[AuthContext] No user profile found in Firestore');
          }
        } else {
          console.warn('[AuthContext] No Firebase user found after sign-in');
        }
      } catch (error: any) {
        console.error('[AuthContext] Error fetching user profile from Firestore:', error);
        // Check if it's an offline error
        if (error?.code === 'unavailable' || error?.message?.includes('offline')) {
          console.warn('[AuthContext] Firestore offline - continuing with sign-in');
        }
        // Continue with sign-in even if profile fetch fails
      }
      
      setPhone(phoneNumber);
      setIsSignedIn(true);
      console.log('[AuthContext] Sign-in completed successfully - isSignedIn state updated to true');
      console.log('[AuthContext] Current state - phone:', phoneNumber, 'isSignedIn:', true);
      
      // Mark the user online
      const currentUser = getAuth().currentUser;
      if (currentUser) writePresence(currentUser.uid, true).catch(() => {});

      // Start status cleanup service
      startStatusCleanupService();
      
      if (Platform.OS === 'web') {
        scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS);
      }
    } catch (error: any) {
      console.error('[AuthContext] Critical error during signIn:', error);
      throw error; // Re-throw to let SignInScreen handle it
    }
  };

  const setDisplayName = async (name: string) => {
    setDisplayNameState(name);
    await AsyncStorage.setItem(KEYS.displayName, name);
  };

  const setAvatarUri = async (uri: string) => {
    setAvatarUriState(uri);
    await AsyncStorage.setItem(KEYS.avatarUri, uri);
  };

  const signOut = async () => {
    await doSignOut();
  };

  const refreshActivity = useCallback(() => {
    if (Platform.OS !== 'web' || !isSignedIn) return;
    const now = Date.now().toString();
    AsyncStorage.setItem(KEYS.lastActive, now);
    scheduleWebExpiry(WEB_SESSION_TIMEOUT_MS);
  }, [isSignedIn, scheduleWebExpiry]);

  return (
    <AuthContext.Provider value={{
      isSignedIn, phone, displayName, setDisplayName,
      avatarUri, setAvatarUri,
      signIn, signOut, refreshActivity, loading,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
