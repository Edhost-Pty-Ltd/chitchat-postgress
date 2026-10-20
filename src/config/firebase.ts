// ─── Firebase Configuration — Auth only ──────────────────────────────────────
// Firestore and Storage have been removed (Slice 8). Only Firebase Auth remains.
// Native uses @react-native-firebase/auth; web uses the firebase/auth JS SDK.

import { Platform } from 'react-native';
import { getAuth as getNativeAuth } from '@react-native-firebase/auth';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth as getWebAuth }  from 'firebase/auth';

const firebaseConfig = {
  apiKey:            'AIzaSyB5utwhyyfeEgdC2EUNLcZChFvuc9oc44U',
  authDomain:        'chitchatbusiness-880ce.firebaseapp.com',
  projectId:         'chitchatbusiness-880ce',
  storageBucket:     'chitchatbusiness-880ce.firebasestorage.app',
  messagingSenderId: '600971982253',
  appId:             '1:600971982253:android:98266dc9861305e84e5d24',
};

// Initialise the JS SDK app so web builds and useAuth.web.ts work.
const webApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const auth =
  Platform.OS !== 'web' ? getNativeAuth() : getWebAuth(webApp);

export default webApp;
