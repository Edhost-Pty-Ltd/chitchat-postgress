// ─── Firebase Configuration ────────────────────────────────────────────────────
// All Firebase services now use @react-native-firebase (native modules).
// Auth + Firestore + Storage all share the same native SDK instance, so
// security rules work correctly — request.auth is always populated.
//
// Web fallback uses the JS SDK (only for useAuth.web.ts and Platform.OS==='web').

import { Platform } from 'react-native';

// ── Native (iOS / Android) ────────────────────────────────────────────────────
import nativeFirestore from '@react-native-firebase/firestore';
import nativeStorage from '@react-native-firebase/storage';
import { getAuth as getNativeAuth } from '@react-native-firebase/auth';

// ── Web fallback (JS SDK) ─────────────────────────────────────────────────────
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getAuth as getWebAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey:            'AIzaSyB5utwhyyfeEgdC2EUNLcZChFvuc9oc44U',
  authDomain:        'chitchatbusiness-880ce.firebaseapp.com',
  projectId:         'chitchatbusiness-880ce',
  storageBucket:     'chitchatbusiness-880ce.firebasestorage.app',
  messagingSenderId: '600971982253',
  appId:             '1:600971982253:android:98266dc9861305e84e5d24',
};

// Always initialize the JS SDK app so web builds and useAuth.web.ts work
const webApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// ── Exports ───────────────────────────────────────────────────────────────────
// On native: db / storage are the @react-native-firebase instances.
// On web:    db / storage are the JS SDK instances.
// All consumers import from this file — the platform difference is invisible.

export const db =
  Platform.OS !== 'web'
    ? nativeFirestore()
    : getFirestore(webApp);

export const storage =
  Platform.OS !== 'web'
    ? nativeStorage()
    : getStorage(webApp);

export const auth =
  Platform.OS !== 'web'
    ? getNativeAuth()
    : getWebAuth(webApp);

// Named re-exports so existing callers that do `import { db } from '../config/firebase'`
// keep working with zero changes.
export { nativeFirestore, nativeStorage };

export default webApp;
