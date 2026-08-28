// ─── Web Shim: @react-native-firebase/auth ───────────────────────────────────
// On web, we use the Firebase JS SDK auth. This shim re-exports the JS SDK
// equivalents so code importing from @react-native-firebase/auth works on web.
//
// The getAuth wrapper ensures it always resolves the default app, avoiding
// "No Firebase App '[DEFAULT]'" errors if called before the app import is evaluated.

import {
  getAuth as _getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  signInWithPhoneNumber,
  RecaptchaVerifier,
} from 'firebase/auth';
import { getApp, getApps, initializeApp } from 'firebase/app';

// Firebase config (duplicated here to guarantee the app exists when getAuth is called)
const FIREBASE_CONFIG = {
  apiKey:            'AIzaSyB5utwhyyfeEgdC2EUNLcZChFvuc9oc44U',
  authDomain:        'chitchatbusiness-880ce.firebaseapp.com',
  projectId:         'chitchatbusiness-880ce',
  storageBucket:     'chitchatbusiness-880ce.firebasestorage.app',
  messagingSenderId: '600971982253',
  appId:             '1:600971982253:android:98266dc9861305e84e5d24',
};

function ensureApp() {
  if (getApps().length === 0) {
    return initializeApp(FIREBASE_CONFIG);
  }
  return getApp();
}

function getAuth(app?: any) {
  return _getAuth(app ?? ensureApp());
}

export { getAuth, onAuthStateChanged, signOut, signInWithPhoneNumber, signInWithEmailAndPassword, createUserWithEmailAndPassword, RecaptchaVerifier };

// Default export mimics the RN Firebase auth() function pattern
const auth = () => getAuth();
auth.getAuth = getAuth;
auth.onAuthStateChanged = onAuthStateChanged;
auth.signOut = signOut;
auth.signInWithPhoneNumber = signInWithPhoneNumber;

export default auth;

// Type stubs that match what @react-native-firebase/auth exports
export type FirebaseAuthTypes = {
  User: any;
  ConfirmationResult: any;
};
