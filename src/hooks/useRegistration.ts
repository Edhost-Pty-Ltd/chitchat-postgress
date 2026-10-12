// ─── useRegistration Hook ─────────────────────────────────────────────────────
// Orchestrates the full registration flow via Firebase Auth + backend profile.

import { useState, useRef, useCallback } from 'react';
import { FirebaseAuthTypes, getAuth, signInWithPhoneNumber } from '@react-native-firebase/auth';
import { endpoints } from '../api/endpoints';

export type RegistrationStep = 'form' | 'otp' | 'creating' | 'done' | 'error';

export interface BusinessMeta {
  email?:            string;
  website?:          string;
  catalog?:          string;
  operationalHours?: string;
}

export interface UseRegistrationReturn {
  registrationStep:    RegistrationStep;
  error:               string | null;
  isLoading:           boolean;
  submitRegistration:  (username: string, phone: string, imageUri: string | null, businessMeta?: BusinessMeta) => Promise<void>;
  verifyOTP:           (code: string) => Promise<boolean>;
  resendOTP:           () => Promise<boolean>;
  resendCount:         number;
  canResend:           boolean;
  createProfile:       () => Promise<void>;
  retryProfileCreation:() => Promise<void>;
  proceedWithoutPhoto: () => Promise<void>;
}

export function useRegistration(): UseRegistrationReturn {
  const [registrationStep, setRegistrationStep] = useState<RegistrationStep>('form');
  const [error,  setError]  = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [resendCount, setResendCount] = useState(0);

  const confirmationRef = useRef<FirebaseAuthTypes.ConfirmationResult | null>(null);
  const phoneRef        = useRef<string>('');
  const usernameRef     = useRef<string>('');
  const imageUriRef     = useRef<string | null>(null);
  const businessMetaRef = useRef<BusinessMeta>({});

  const submitRegistration = useCallback(
    async (username: string, phone: string, imageUri: string | null, businessMeta?: BusinessMeta): Promise<void> => {
      try {
        setIsLoading(true); setError(null);
        usernameRef.current     = username;
        phoneRef.current        = phone;
        imageUriRef.current     = imageUri;
        businessMetaRef.current = businessMeta || {};
        const confirmation = await signInWithPhoneNumber(getAuth(), phone);
        confirmationRef.current = confirmation;
        setRegistrationStep('otp');
      } catch (err: any) {
        setError(getRegistrationErrorMessage(err.code));
        setRegistrationStep('error');
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  const verifyOTP = useCallback(async (code: string): Promise<boolean> => {
    if (!confirmationRef.current) { setError('No confirmation pending — please resend OTP'); return false; }
    try {
      setIsLoading(true); setError(null);
      await confirmationRef.current.confirm(code);
      await createProfile();
      return true;
    } catch (err: any) {
      setError(getRegistrationErrorMessage(err.code));
      setRegistrationStep('error');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const resendOTP = useCallback(async (): Promise<boolean> => {
    if (resendCount >= 3) return false;
    try {
      setIsLoading(true); setError(null);
      const confirmation = await signInWithPhoneNumber(getAuth(), phoneRef.current);
      confirmationRef.current = confirmation;
      setResendCount((prev) => prev + 1);
      return true;
    } catch (err: any) {
      setError(getRegistrationErrorMessage(err.code));
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [resendCount]);

  async function createProfile(): Promise<void> {
    try {
      setIsLoading(true); setError(null); setRegistrationStep('creating');

      const currentUser = getAuth().currentUser;
      if (!currentUser) throw new Error('No authenticated user found');

      const uid = currentUser.uid;
      let photoURL: string | null = null;

      if (imageUriRef.current) {
        try {
          photoURL = await uploadProfilePicture(uid, imageUriRef.current);
        } catch (uploadErr: any) {
          throw new Error(`Photo upload failed: ${uploadErr.message}`);
        }
      }

      const phoneRes = await endpoints.updatePhone(phoneRef.current);
      if (!phoneRes.ok && phoneRes.error.kind === 'api' && phoneRes.error.status === 409) {
        throw new Error('That phone number is already registered.');
      }
      const res = await endpoints.updateMe({
        displayName:      usernameRef.current,
        avatarObjectKey:  photoURL,
        email:            businessMetaRef.current.email            || null,
        website:          businessMetaRef.current.website          || null,
        catalog:          businessMetaRef.current.catalog          || null,
        operationalHours: businessMetaRef.current.operationalHours || null,
      });
      if (!res.ok) throw new Error(`Database error: ${res.error.message}`);

      setRegistrationStep('done');
    } catch (err: any) {
      setError(err.message || getRegistrationErrorMessage(err.code));
      setRegistrationStep('error');
    } finally {
      setIsLoading(false);
    }
  }

  const retryProfileCreation = useCallback(async () => { await createProfile(); }, []);
  const proceedWithoutPhoto  = useCallback(async () => { imageUriRef.current = null; await createProfile(); }, []);

  return {
    registrationStep, error, isLoading,
    submitRegistration, verifyOTP, resendOTP,
    resendCount, canResend: resendCount < 3,
    createProfile, retryProfileCreation, proceedWithoutPhoto,
  };
}

async function uploadProfilePicture(uid: string, imageUri: string): Promise<string> {
  const { mediaService, fileSize } = await import('../services/mediaService');
  return mediaService.upload(imageUri, 'avatar', { sizeBytes: await fileSize(imageUri) });
}

function getRegistrationErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    'auth/invalid-phone-number':      'Invalid phone number. Use format +27XXXXXXXXX',
    'auth/too-many-requests':         'Too many attempts. Please wait and try again.',
    'auth/invalid-verification-code': 'Incorrect code. Please try again.',
    'auth/code-expired':              'Code expired. Tap Resend to get a new one.',
    'auth/missing-phone-number':      'Please enter your phone number.',
    'auth/session-expired':           'Session expired. Please request a new OTP.',
    'auth/quota-exceeded':            'SMS quota exceeded. Try again later.',
  };
  return messages[code] ?? 'Something went wrong. Please try again.';
}
