// ─── useRegistration Hook ─────────────────────────────────────────────────────
// Orchestrates the full registration flow:
//   form → OTP verification → profile creation → done
//
// Uses @react-native-firebase/auth (native module) for phone OTP,
// and the JS SDK (firebase/firestore, firebase/storage) for profile persistence.

import { useState, useRef, useCallback } from 'react';
import auth, { FirebaseAuthTypes, getAuth, signInWithPhoneNumber } from '@react-native-firebase/auth';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '../config/firebase';

export type RegistrationStep = 'form' | 'otp' | 'creating' | 'done' | 'error';

export interface UseRegistrationReturn {
  // State
  registrationStep: RegistrationStep;
  error: string | null;
  isLoading: boolean;

  // Form actions
  submitRegistration: (username: string, phone: string, imageUri: string | null, businessMeta?: BusinessMeta) => Promise<void>;

  // OTP actions
  verifyOTP: (code: string) => Promise<boolean>;
  resendOTP: () => Promise<boolean>;
  resendCount: number;
  canResend: boolean;

  // Profile creation
  createProfile: () => Promise<void>;
  retryProfileCreation: () => Promise<void>;
  proceedWithoutPhoto: () => Promise<void>;
}

export interface BusinessMeta {
  email?: string;
  website?: string;
  catalog?: string;
  operationalHours?: string;
}

export function useRegistration(): UseRegistrationReturn {
  const [registrationStep, setRegistrationStep] = useState<RegistrationStep>('form');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [resendCount, setResendCount] = useState(0);

  // Refs to persist data across step transitions
  const confirmationRef = useRef<FirebaseAuthTypes.ConfirmationResult | null>(null);
  const phoneRef = useRef<string>('');
  const usernameRef = useRef<string>('');
  const imageUriRef = useRef<string | null>(null);
  const businessMetaRef = useRef<BusinessMeta>({});

  // ── Submit registration: send OTP to phone ─────────────────────
  const submitRegistration = useCallback(
    async (username: string, phone: string, imageUri: string | null, businessMeta?: BusinessMeta): Promise<void> => {
      try {
        setIsLoading(true);
        setError(null);

        // Store values in refs for later use
        usernameRef.current = username;
        phoneRef.current = phone;
        imageUriRef.current = imageUri;
        businessMetaRef.current = businessMeta || {};

        const authInstance = getAuth();
        const confirmation = await signInWithPhoneNumber(authInstance, phone);
        confirmationRef.current = confirmation;

        setRegistrationStep('otp');
      } catch (err: any) {
        setError(getRegistrationErrorMessage(err.code));
        setRegistrationStep('error');
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  // ── Verify OTP code ────────────────────────────────────────────
  const verifyOTP = useCallback(async (code: string): Promise<boolean> => {
    if (!confirmationRef.current) {
      setError('No confirmation pending — please resend OTP');
      return false;
    }

    try {
      setIsLoading(true);
      setError(null);

      await confirmationRef.current.confirm(code);

      // OTP verified — automatically create profile
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

  // ── Resend OTP (max 3 times) ───────────────────────────────────
  const resendOTP = useCallback(async (): Promise<boolean> => {
    if (resendCount >= 3) {
      return false;
    }

    try {
      setIsLoading(true);
      setError(null);

      const authInstance = getAuth();
      const confirmation = await signInWithPhoneNumber(authInstance, phoneRef.current);
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

  // ── Create user profile in Firestore ───────────────────────────
  async function createProfile(): Promise<void> {
    try {
      setIsLoading(true);
      setError(null);
      setRegistrationStep('creating');

      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      
      console.log('[useRegistration] createProfile - Current user:', currentUser?.uid);
      
      if (!currentUser) {
        throw new Error('No authenticated user found');
      }

      const uid = currentUser.uid;
      let photoURL: string | null = null;

      // Upload profile picture if provided
      if (imageUriRef.current) {
        console.log('[useRegistration] Uploading profile picture...');
        try {
          photoURL = await uploadProfilePicture(uid, imageUriRef.current);
          console.log('[useRegistration] Profile picture uploaded:', photoURL);
        } catch (uploadErr: any) {
          console.error('[useRegistration] Photo upload failed:', uploadErr);
          throw new Error(`Photo upload failed: ${uploadErr.message}`);
        }
      }

      // Create/update Firestore user document
      console.log('[useRegistration] Creating Firestore document for uid:', uid);
      const userDocRef = doc(db, 'users', uid);
      
      try {
        await setDoc(
          userDocRef,
          {
            uid,
            displayName: usernameRef.current,  // Business name
            phone: phoneRef.current,
            photoURL,
            // Business fields
            email: businessMetaRef.current.email || null,
            website: businessMetaRef.current.website || null,
            catalog: businessMetaRef.current.catalog || null,
            operationalHours: businessMetaRef.current.operationalHours || null,
            accountType: 'business',
            createdAt: serverTimestamp(),
            lastSeen: serverTimestamp(),
          },
          { merge: true }
        );
        console.log('[useRegistration] Firestore document created successfully');
      } catch (firestoreErr: any) {
        console.error('[useRegistration] Firestore write failed:', firestoreErr);
        throw new Error(`Database error: ${firestoreErr.message}`);
      }

      setRegistrationStep('done');
      console.log('[useRegistration] Profile creation complete');
    } catch (err: any) {
      console.error('[useRegistration] createProfile error:', err);
      const errorMessage = err.message || getRegistrationErrorMessage(err.code);
      setError(errorMessage);
      setRegistrationStep('error');
    } finally {
      setIsLoading(false);
    }
  }

  // ── Retry profile creation (no re-verification needed) ─────────
  const retryProfileCreation = useCallback(async (): Promise<void> => {
    await createProfile();
  }, []);

  // ── Proceed without photo ──────────────────────────────────────
  const proceedWithoutPhoto = useCallback(async (): Promise<void> => {
    imageUriRef.current = null;
    await createProfile();
  }, []);

  return {
    registrationStep,
    error,
    isLoading,
    submitRegistration,
    verifyOTP,
    resendOTP,
    resendCount,
    canResend: resendCount < 3,
    createProfile,
    retryProfileCreation,
    proceedWithoutPhoto,
  };
}

// ─── Upload profile picture to Firebase Storage ───────────────────────────────
async function uploadProfilePicture(uid: string, imageUri: string): Promise<string> {
  console.log('[uploadProfilePicture] Starting upload for uid:', uid);
  console.log('[uploadProfilePicture] Image URI:', imageUri);
  
  try {
    // Use the fixed uploadFile function from storage.ts that handles React Native properly
    const { uploadFile, generateFileName } = await import('../config/storage');
    
    const fileName = generateFileName('jpg');
    console.log('[uploadProfilePicture] Uploading via storage.ts uploadFile...');
    
    const downloadURL = await uploadFile(imageUri, 'avatar', {
      userId: uid,
      fileName,
    }, (progress) => {
      console.log(`[uploadProfilePicture] Upload progress: ${progress}%`);
    });
    
    console.log('[uploadProfilePicture] Upload complete:', downloadURL);
    return downloadURL;
  } catch (err: any) {
    console.error('[uploadProfilePicture] Upload error:', err);
    throw err;
  }
}

// ─── Human-readable error messages ────────────────────────────────────────────
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
