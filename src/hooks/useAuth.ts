// ─── useAuth Hook ─────────────────────────────────────────────────────────────
// Phone OTP authentication via @react-native-firebase/auth.
// Flow: enterPhone → sendOTP → verifyOTP → signed in
// The backend (upsertUserOnFirstContact) creates the Postgres row on first
// verified API call — no Firestore write needed here.

import { useState, useEffect } from 'react';
import { FirebaseAuthTypes, getAuth, onAuthStateChanged, signInWithPhoneNumber, signOut as firebaseSignOut } from '@react-native-firebase/auth';

export type AuthStep = 'idle' | 'sending' | 'otpSent' | 'verifying' | 'done' | 'error';

export function useAuth() {
  const [user,    setUser]    = useState<FirebaseAuthTypes.User | null>(null);
  const [step,    setStep]    = useState<AuthStep>('idle');
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirm, setConfirm] = useState<FirebaseAuthTypes.ConfirmationResult | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(getAuth(), (firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
    });
    return unsub;
  }, []);

  async function sendOTP(phone: string): Promise<boolean> {
    try {
      setStep('sending'); setError(null);
      const confirmation = await signInWithPhoneNumber(getAuth(), phone);
      setConfirm(confirmation);
      setStep('otpSent');
      return true;
    } catch (err: any) {
      setError(getAuthErrorMessage(err.code));
      setStep('error');
      return false;
    }
  }

  async function verifyOTP(otp: string): Promise<boolean> {
    if (!confirm) { setError('No confirmation pending — please resend OTP'); return false; }
    try {
      setStep('verifying'); setError(null);
      const result = await confirm.confirm(otp);
      if (result?.user) setUser(result.user);
      setStep('done');
      return true;
    } catch (err: any) {
      setError(getAuthErrorMessage(err.code));
      setStep('error');
      return false;
    }
  }

  async function signOut() {
    await firebaseSignOut(getAuth());
    setUser(null); setConfirm(null); setStep('idle');
  }

  return { user, step, error, loading, sendOTP, verifyOTP, signOut };
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
