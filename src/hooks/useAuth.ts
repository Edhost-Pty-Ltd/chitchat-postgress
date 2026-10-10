// ─── useAuth Hook ─────────────────────────────────────────────────────────────
// Phone OTP authentication via @react-native-firebase/auth.
// Flow: enterPhone → sendOTP → verifyOTP → signed in

import { useState, useEffect } from 'react';
import { FirebaseAuthTypes, getAuth, onAuthStateChanged, signInWithPhoneNumber, signOut as firebaseSignOut } from '@react-native-firebase/auth';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { useBackend } from '../config/featureFlags';

export type AuthStep = 'idle' | 'sending' | 'otpSent' | 'verifying' | 'done' | 'error';

export function useAuth() {
  const [user,    setUser]    = useState<FirebaseAuthTypes.User | null>(null);
  const [step,    setStep]    = useState<AuthStep>('idle');
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [confirm, setConfirm] = useState<FirebaseAuthTypes.ConfirmationResult | null>(null);

  useEffect(() => {
    const authInstance = getAuth();
    const unsub = onAuthStateChanged(authInstance, async (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsub;
  }, []);

  async function sendOTP(phone: string): Promise<boolean> {
    try {
      setStep('sending');
      setError(null);
      console.log('[useAuth] Sending OTP to:', phone);
      const authInstance = getAuth();
      const confirmation = await signInWithPhoneNumber(authInstance, phone);
      setConfirm(confirmation);
      setStep('otpSent');
      return true;
    } catch (err: any) {
      console.error('[useAuth] sendOTP error:', err.code, err.message);
      setError(getAuthErrorMessage(err.code));
      setStep('error');
      return false;
    }
  }

  async function verifyOTP(otp: string): Promise<boolean> {
    if (!confirm) {
      setError('No confirmation pending — please resend OTP');
      return false;
    }
    try {
      setStep('verifying');
      setError(null);
      console.log('[useAuth] Confirming OTP...');
      const result = await confirm.confirm(otp);
      console.log('[useAuth] OTP confirmed, user authenticated:', result?.user?.uid);

      if (result?.user) {
        try {
          // When the users feature is on the backend, the auth middleware
          // (upsertUserOnFirstContact) already created the Postgres row when
          // the Firebase ID token was verified on the first API call. Skip the
          // Firestore write to avoid a stale legacy record being created.
          if (!useBackend('users')) {
            await upsertUserProfile(result.user);
          }
        } catch (firestoreError: any) {
          console.warn('[useAuth] Non-critical Firestore error - continuing with sign-in:', firestoreError);
        }
        setUser(result.user);
      }

      setStep('done');
      return true;
    } catch (err: any) {
      console.error('[useAuth] verifyOTP error:', err.code, err.message);
      setError(getAuthErrorMessage(err.code));
      setStep('error');
      return false;
    }
  }

  async function signOut() {
    const authInstance = getAuth();
    await firebaseSignOut(authInstance);
    setUser(null);
    setConfirm(null);
    setStep('idle');
  }

  return { user, step, error, loading, sendOTP, verifyOTP, signOut };
}

async function upsertUserProfile(user: FirebaseAuthTypes.User) {
  try {
    const fsDb = db as ReturnType<typeof firestore>;
    const ref = fsDb.collection('users').doc(user.uid);
    const snap = await ref.get();

    if (!snap.exists) {
      console.log('[useAuth] Creating new user profile...');
      await ref.set({
        uid:         user.uid,
        phone:       user.phoneNumber ?? '',
        displayName: user.phoneNumber ?? '',
        photoURL:    null,
        createdAt:   firestore.FieldValue.serverTimestamp(),
        lastSeen:    firestore.FieldValue.serverTimestamp(),
      });
    } else {
      console.log('[useAuth] Updating existing user lastSeen...');
      await ref.set({ lastSeen: firestore.FieldValue.serverTimestamp() }, { merge: true });
    }
  } catch (error: any) {
    console.error('[useAuth] upsertUserProfile error:', error);
    throw error;
  }
}

function getAuthErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    'auth/invalid-phone-number':      'Invalid phone number. Use format +27XXXXXXXXX',
    'auth/too-many-requests':         'Too many attempts. Please wait and try again.',
    'auth/invalid-verification-code': 'Incorrect OTP. Please check and try again.',
    'auth/code-expired':              'OTP has expired. Please request a new one.',
    'auth/missing-phone-number':      'Please enter your phone number.',
    'auth/session-expired':           'Session expired. Please request a new OTP.',
    'auth/quota-exceeded':            'SMS quota exceeded. Try again later.',
  };
  return messages[code] ?? 'Something went wrong. Please try again.';
}
