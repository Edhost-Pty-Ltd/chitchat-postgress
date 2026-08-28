// ─── Firebase Configuration (Hybrid) ──────────────────────────────────────────
// Auth:      @react-native-firebase/auth (native module, supports phone OTP)  
// Firestore: firebase/firestore (JS SDK)
//
// WORKAROUND: Since bridging auth between native and JS SDK is complex and requires
// a backend to generate custom tokens, we temporarily use permissive Firestore rules
// that allow authenticated users (from either SDK) to access data.
//
// TODO: Implement proper auth bridge or migrate to full JS SDK when phone auth
// supports it without requiring reCAPTCHA manual handling.

import { Platform } from 'react-native';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, enableIndexedDbPersistence } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { getAuth as getWebAuth } from 'firebase/auth';

// Initialize React Native Firebase (native module)
// This ensures the native auth module is loaded before we use it
import './firebaseNative';

const firebaseConfig = {
  apiKey:            'AIzaSyB5utwhyyfeEgdC2EUNLcZChFvuc9oc44U',
  authDomain:        'chitchatbusiness-880ce.firebaseapp.com',
  projectId:         'chitchatbusiness-880ce',
  storageBucket:     'chitchatbusiness-880ce.firebasestorage.app',
  messagingSenderId: '600971982253',
  appId:             '1:600971982253:android:98266dc9861305e84e5d24',
};

console.log('[Firebase] Initializing Firebase...');

// Prevent duplicate app initialization on hot reload
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

console.log('[Firebase] Firebase app initialized:', app.name);

// Firestore — real-time database (JS SDK)
export const db = getFirestore(app);

console.log('[Firebase] Firestore initialized');

// Firebase Storage — voice note audio file hosting
export const storage = getStorage(app);

console.log('[Firebase] Storage initialized');

// Firebase Auth (Web SDK) — used by web-specific hooks
export const auth = getWebAuth(app);

console.log('[Firebase] Auth initialized');

// Enable offline persistence for better reliability (web only)
// This allows Firestore to work offline and sync when connection is restored
if (Platform.OS === 'web') {
  try {
    enableIndexedDbPersistence(db).catch((err) => {
      if (err.code === 'failed-precondition') {
        console.warn('[Firebase] Persistence failed: Multiple tabs open');
      } else if (err.code === 'unimplemented') {
        console.warn('[Firebase] Persistence not available in this browser');
      }
    });
  } catch (error) {
    console.warn('[Firebase] Persistence initialization error:', error);
  }
}

export default app;
