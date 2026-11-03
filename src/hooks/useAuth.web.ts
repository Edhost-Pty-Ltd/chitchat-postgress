// ─── useAuth Hook (Web Implementation) ───────────────────────────────────────
// Web authentication using Firebase Web SDK
// For testing, provides email/password authentication instead of phone OTP

import { useState, useEffect } from 'react';
import { 
  getAuth, 
  onAuthStateChanged, 
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as firebaseSignOut,
  User,
  type Auth,
} from 'firebase/auth';
import { auth as rawAuth } from '../config/firebase';

// `auth` from config/firebase is typed as the union of the native and web auth
// objects (Module | Auth). This file only runs on web, where it is always the
// firebase/auth JS SDK's Auth, so narrow it once here.
const firebaseAuth = rawAuth as Auth;
import { endpoints } from '../api/endpoints';
// NOTE: This file is web-only. Authentication uses the firebase/auth JS SDK.
// Profile creation goes through the Postgres backend (no Firestore writes).

export type AuthStep = 'idle' | 'sending' | 'otpSent' | 'verifying' | 'done' | 'error';

export function useAuth() {
  const [user, setUser] = useState<User | null>(null);
  const [step, setStep] = useState<AuthStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Listen to auth state changes
  useEffect(() => {
    if (!firebaseAuth) {
      console.error('[useAuth-Web] Firebase auth not initialized');
      setLoading(false);
      return;
    }

    const unsub = onAuthStateChanged(firebaseAuth, async (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsub;
  }, []);

  // Web uses email/password for testing (phone OTP requires reCAPTCHA setup)
  async function sendOTP(phoneOrEmail: string): Promise<boolean> {
    try {
      setStep('sending');
      setError(null);

      // For web testing, treat phone as email
      // Format: +27658500320 becomes 27658500320@chitchat.test
      const email = phoneOrEmail.startsWith('+') 
        ? `${phoneOrEmail.replace('+', '')}@chitchat.test`
        : phoneOrEmail;

      console.log('[useAuth-Web] Using email for auth:', email);
      
      // Store email for verification step
      (window as any).__chitchat_temp_email = email;
      
      setStep('otpSent');
      return true;
    } catch (err: any) {
      console.error('[useAuth-Web] sendOTP error:', err);
      setError(err.message || 'Failed to send OTP');
      setStep('error');
      return false;
    }
  }

  // Verify OTP (on web, use OTP as password)
  async function verifyOTP(code: string): Promise<boolean> {
    try {
      setStep('verifying');
      setError(null);

      if (!firebaseAuth) {
        throw new Error('Firebase auth not initialized');
      }

      const email = (window as any).__chitchat_temp_email;
      if (!email) {
        throw new Error('No email found - call sendOTP first');
      }

      console.log('[useAuth-Web] Verifying with email:', email);

      // Try to sign in first
      let userCredential;
      try {
        userCredential = await signInWithEmailAndPassword(firebaseAuth, email, code);
        console.log('[useAuth-Web] Signed in existing user');
      } catch (signInError: any) {
        if (signInError.code === 'auth/user-not-found' || signInError.code === 'auth/wrong-password') {
          // Create new account
          console.log('[useAuth-Web] Creating new account');
          userCredential = await createUserWithEmailAndPassword(firebaseAuth, email, code);

          // Create the Postgres profile via the backend (no Firestore write).
          const displayName = `User ${email.split('@')[0].slice(-4)}`;
          await endpoints.updateMe({ displayName }).catch(() => {});
        } else {
          throw signInError;
        }
      }

      setUser(userCredential.user);
      setStep('done');
      delete (window as any).__chitchat_temp_email;
      return true;
    } catch (err: any) {
      console.error('[useAuth-Web] verifyOTP error:', err);
      setError(getAuthErrorMessage(err.code));
      setStep('error');
      return false;
    }
  }

  async function signOut(): Promise<void> {
    try {
      if (!firebaseAuth) {
        throw new Error('Firebase auth not initialized');
      }
      await firebaseSignOut(firebaseAuth);
      setUser(null);
      setStep('idle');
      console.log('[useAuth-Web] Signed out');
    } catch (err: any) {
      console.error('[useAuth-Web] signOut error:', err);
      setError(err.message || 'Failed to sign out');
    }
  }

  return {
    user,
    loading,
    step,
    error,
    sendOTP,
    verifyOTP,
    signOut,
    resetError: () => setError(null),
    resetStep: () => setStep('idle'),
  };
}

function getAuthErrorMessage(code: string): string {
  switch (code) {
    case 'auth/invalid-phone-number':
      return 'Invalid phone number format';
    case 'auth/invalid-email':
      return 'Invalid email format';
    case 'auth/user-not-found':
      return 'Account not found';
    case 'auth/wrong-password':
      return 'Invalid code';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection';
    case 'auth/weak-password':
      return 'Code must be at least 6 characters';
    default:
      return 'Authentication failed. Please try again';
  }
}
