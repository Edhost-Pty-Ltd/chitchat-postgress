// ─── useRegistration Hook ─────────────────────────────────────────────────────
// Handles only Firebase phone OTP. It deliberately performs NO backend write:
// after OTP, CreateAccount routes to FaceEnrollment; only that screen can call
// POST /me/register with Django's signed face-enrollment receipt.

import { useCallback, useRef, useState } from 'react';
import {
  type FirebaseAuthTypes,
  getAuth,
  signInWithPhoneNumber,
} from '@react-native-firebase/auth';

export type RegistrationStep = 'form' | 'otp' | 'verified' | 'error';

export interface BusinessMeta {
  email?: string;
  website?: string;
  catalog?: string;
  operationalHours?: string;
}

export interface UseRegistrationReturn {
  registrationStep: RegistrationStep;
  error: string | null;
  isLoading: boolean;
  /** Extra arguments stay here for compatibility; this function sends OTP only. */
  submitRegistration: (
    username: string,
    phone: string,
    imageUri: string | null,
    businessMeta?: BusinessMeta,
  ) => Promise<void>;
  /** Confirms OTP only. It never creates a Node user row. */
  verifyOTP: (code: string) => Promise<boolean>;
  resendOTP: () => Promise<boolean>;
  resendCount: number;
  canResend: boolean;
}

export function useRegistration(): UseRegistrationReturn {
  const [registrationStep, setRegistrationStep] = useState<RegistrationStep>('form');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [resendCount, setResendCount] = useState(0);
  const confirmationRef = useRef<FirebaseAuthTypes.ConfirmationResult | null>(null);
  const phoneRef = useRef('');

  const submitRegistration = useCallback(
    async (
      _username: string,
      phone: string,
      _imageUri: string | null,
      _businessMeta?: BusinessMeta,
    ): Promise<void> => {
      try {
        setIsLoading(true);
        setError(null);
        phoneRef.current = phone;
        const confirmation = await signInWithPhoneNumber(getAuth(), phone);
        confirmationRef.current = confirmation;
        setRegistrationStep('otp');
      } catch (err: any) {
        setError(getRegistrationErrorMessage(err?.code));
        setRegistrationStep('error');
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const verifyOTP = useCallback(async (code: string): Promise<boolean> => {
    if (!confirmationRef.current) {
      setError('No confirmation pending — please resend OTP');
      return false;
    }
    try {
      setIsLoading(true);
      setError(null);
      await confirmationRef.current.confirm(code);
      // Firebase now owns an authenticated phone session, but there is still no
      // Node users row. FaceEnrollment is the next and mandatory step.
      setRegistrationStep('verified');
      return true;
    } catch (err: any) {
      setError(getRegistrationErrorMessage(err?.code));
      setRegistrationStep('error');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resendOTP = useCallback(async (): Promise<boolean> => {
    if (resendCount >= 3 || !phoneRef.current) return false;
    try {
      setIsLoading(true);
      setError(null);
      const confirmation = await signInWithPhoneNumber(getAuth(), phoneRef.current);
      confirmationRef.current = confirmation;
      setRegistrationStep('otp');
      setResendCount((previous) => previous + 1);
      return true;
    } catch (err: any) {
      setError(getRegistrationErrorMessage(err?.code));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [resendCount]);

  return {
    registrationStep,
    error,
    isLoading,
    submitRegistration,
    verifyOTP,
    resendOTP,
    resendCount,
    canResend: resendCount < 3,
  };
}

function getRegistrationErrorMessage(code?: string): string {
  const messages: Record<string, string> = {
    'auth/invalid-phone-number': 'Invalid phone number. Use format +27XXXXXXXXX',
    'auth/too-many-requests': 'Too many attempts. Please wait and try again.',
    'auth/invalid-verification-code': 'Incorrect code. Please try again.',
    'auth/code-expired': 'Code expired. Tap Resend to get a new one.',
    'auth/missing-phone-number': 'Please enter your phone number.',
    'auth/session-expired': 'Session expired. Please request a new OTP.',
    'auth/quota-exceeded': 'SMS quota exceeded. Try again later.',
  };
  return messages[code ?? ''] ?? 'Something went wrong. Please try again.';
}
