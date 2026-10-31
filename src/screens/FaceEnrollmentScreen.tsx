// ─── Face enrollment / registration gate ────────────────────────────────────
// During NEW registration this is the only path from verified phone OTP to a
// Node users row:
//
//   SDK camera enrollment → SDK 1:1 + motion/silent liveness →
//   Django stores the encrypted SDK feature AND an InsightFace reference
//   computed from the liveness-verified face image, then signs a receipt →
//   Node verifies receipt and creates the account → optional avatar upload →
//   AuthContext signs in.
//
// The 468-point mesh is a presentation-only visual guide. FaceAISDK presents
// its own native full-screen camera and does not expose landmark coordinates;
// its result code, not the decorative mesh, decides whether registration may
// proceed. This screen is the premium lead-in/progress/result UI AROUND that
// native handoff — the camera + liveness prompts themselves are the SDK's own
// screens and cannot be restyled from here.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  Platform,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getAuth, signOut as firebaseSignOut } from '@react-native-firebase/auth';
import { LinearGradient } from 'expo-linear-gradient';

import { AppBg, AppIcon, AppText } from '../context/ThemeContext';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import type { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import FaceMeshScan from '../components/FaceMeshScan';
import {
  enrollFace,
  FACE_AI_SDK_VERSION,
  FaceAICode,
  installFaceFeature,
  isFaceAIModuleAvailable,
  isUserCancel,
  isValidFaceFeature,
  removeLocalFaceFeature,
  verifyFace,
} from '../sdk/faceAI';
import {
  fetchEnrollmentFeature,
  registerFaceForAccount,
  uploadEnrollment,
} from '../api/faceApi';
import { endpoints } from '../api/endpoints';
import { fileSize, mediaService } from '../services/mediaService';

type IconName = React.ComponentProps<typeof AppIcon>['name'];

const SDK_ERROR_COPY: Partial<Record<number, string>> = {
  [FaceAICode.VERIFY_FAILED]: 'The live face did not match the face just enrolled. Start again and use the same person.',
  [FaceAICode.NO_FACE_MULTI]: 'The camera could not see your face clearly. Find better light and try again.',
  [FaceAICode.MOTION_LIVENESS_TIMEOUT]: 'The movement challenge timed out. Follow each prompt and try again.',
  [FaceAICode.NO_FACE_FEATURE]: 'The enrolled face reference was not available. Start the scan again.',
  [FaceAICode.COLOR_LIVENESS_FAILED]: 'The screen-light liveness check failed. Move somewhere less bright and retry.',
  [FaceAICode.COLOR_LIVENESS_LIGHT_TOO_HIGH]: 'The surrounding light is too strong. Move away from direct sunlight.',
  [FaceAICode.SILENT_LIVENESS_FAILED]: 'Anti-spoofing rejected this attempt. Use your live face in a well-lit space.',
  [FaceAICode.NOT_ALLOW_MULTI_FACES]: 'Only one face can be visible during verification.',
};

const SERVER_ERROR_COPY: Record<string, string> = {
  bad_feature: 'The face reference was incomplete. Please repeat the scan.',
  liveness_rejected: 'The secure service did not accept the anti-spoofing result. Please repeat the live check.',
  already_enrolled: 'A different enrollment already exists for this identity. Contact support.',
  receipt_not_configured: 'Secure registration is temporarily unavailable. Contact support.',
  service_unavailable: 'The face service is temporarily unavailable. Check that it is running and retry.',
  no_face_detected: 'The secure service could not find one clear face in the capture. Face the camera in even light and scan again.',
  arcface_failed: 'The captured face could not be processed. Scan again in good, even light.',
};

// Server rejected the IMAGE itself, so reusing it can never succeed: the next
// attempt must run the camera again and capture a new one.
const IMAGE_REJECTED_ERRORS = new Set(['no_face_detected', 'arcface_failed']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type NavProp = NativeStackNavigationProp<RootStackParamList, 'FaceEnrollment'>;
type RouteP = RouteProp<RootStackParamList, 'FaceEnrollment'>;
type Phase = 'ready' | 'enrolling' | 'verifying' | 'saving-face' | 'creating-account' | 'done';

type RegistrationProfile = Extract<
  NonNullable<RootStackParamList['FaceEnrollment']>,
  { mode: 'registration' }
>['profile'];

export default function FaceEnrollmentScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteP>();
  const auth = useAuth();

  const registrationProfile: RegistrationProfile | null =
    route.params?.mode === 'registration' ? route.params.profile : null;
  const registrationMode = registrationProfile !== null;
  const onDone = route.params?.mode !== 'registration' ? route.params?.onDone : undefined;
  const firebaseUid = auth.userId ?? getAuth().currentUser?.uid ?? null;

  const mountedRef = useRef(true);
  const approvedFeatureRef = useRef<string | null>(null);
  const approvedLivenessRef = useRef<{ code: number; score: number } | null>(null);
  // The liveness-verified face image. Django runs InsightFace on it to create
  // the server-side reference that later recovery checks are matched against.
  const approvedImageRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [status, setStatus] = useState('Ready for secure face setup');
  const [captureBase64, setCaptureBase64] = useState<string | null>(null);
  const [avatarWarning, setAvatarWarning] = useState(false);

  const intro = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    Animated.timing(intro, {
      toValue: 1,
      duration: 460,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [intro]);

  const sdkReady = Platform.OS !== 'web' && isFaceAIModuleAvailable();
  const busy = phase !== 'ready' && phase !== 'done';
  const done = phase === 'done';

  const sdkMessage = useCallback((code: number, fallback: string) => {
    return SDK_ERROR_COPY[code] ?? fallback ?? 'The face check could not be completed. Please try again.';
  }, []);

  const finishNodeRegistration = useCallback(
    async (
      feature: string,
      liveness: { code: number; score: number },
      faceImage: string | null,
    ) => {
      if (!registrationProfile) return false;
      setPhase('saving-face');
      setStatus('Encrypting your face reference…');
      const face = await registerFaceForAccount(feature, {
        livenessCode: liveness.code,
        livenessScore: liveness.score,
        sdkVersion: FACE_AI_SDK_VERSION,
        faceImage,
      });
      if (!mountedRef.current) return false;
      if (!face.ok) {
        if (IMAGE_REJECTED_ERRORS.has(face.error)) {
          approvedFeatureRef.current = null;
          approvedLivenessRef.current = null;
          approvedImageRef.current = null;
        }
        throw new Error(SERVER_ERROR_COPY[face.error] ?? face.hint ?? 'The secure face service rejected this enrollment.');
      }

      setPhase('creating-account');
      setStatus('Creating your account…');
      const registered = await endpoints.registerSelf(face.receipt, {
        displayName: registrationProfile.displayName,
        email: registrationProfile.email ?? null,
        website: registrationProfile.website ?? null,
        about: registrationProfile.about ?? null,
      });
      if (!mountedRef.current) return false;
      if (!registered.ok) {
        throw new Error(registered.error.message || 'The account could not be created. Please retry.');
      }

      // Media endpoints are deliberately inaccessible before the users row
      // exists. Upload the optional logo only after the signed registration
      // transaction commits; a failed optional logo never rolls back identity.
      if (registrationProfile.avatarUri) {
        setStatus('Uploading your business logo…');
        try {
          const sizeBytes = await fileSize(registrationProfile.avatarUri);
          const objectKey = await mediaService.upload(
            registrationProfile.avatarUri,
            'avatar',
            { sizeBytes },
          );
          const patched = await endpoints.updateMe({ avatarObjectKey: objectKey });
          if (!patched.ok) throw new Error(patched.error.message);
          await auth.setAvatarUri(registrationProfile.avatarUri);
        } catch (err) {
          console.warn('[FaceEnrollment] optional avatar upload failed:', err);
          if (mountedRef.current) setAvatarWarning(true);
        }
      }

      await auth.setDisplayName(registrationProfile.displayName);
      await auth.signIn(registrationProfile.phoneNumber);
      if (!mountedRef.current) return false;
      setPhase('done');
      setStatus('Registration complete');
      return true;
    },
    [auth, registrationProfile],
  );

  const handleBegin = useCallback(async () => {
    if (!firebaseUid) {
      Alert.alert('Phone verification required', 'Verify your phone number before setting up your face.');
      return;
    }
    if (!sdkReady) {
      Alert.alert(
        'Face SDK unavailable',
        Platform.OS === 'web'
          ? 'Complete registration on a physical iOS or Android device.'
          : 'The face recognition module is not loaded. Rebuild the native app and try again.',
      );
      return;
    }

    try {
      // A previous attempt may already have passed liveness and only failed on
      // a network handoff. Reuse the in-memory proof and ask Django for a fresh
      // short-lived receipt rather than making the person repeat the camera.
      if (registrationMode && approvedFeatureRef.current && approvedLivenessRef.current) {
        await finishNodeRegistration(
          approvedFeatureRef.current,
          approvedLivenessRef.current,
          approvedImageRef.current,
        );
        return;
      }

      let feature: string | null = null;
      let capture: string | null = null;

      // Recover an enrollment that Django stored before a prior Node request
      // was lost. Restore it into the SDK and verify the live owner; otherwise
      // run first-time enrollment now.
      let restored = false;
      if (registrationMode) {
        setPhase('enrolling');
        setStatus('Checking for a saved secure reference…');
        const remote = await fetchEnrollmentFeature();
        if (!mountedRef.current) return;
        if (!remote.ok) {
          throw new Error(SERVER_ERROR_COPY[remote.error] ?? 'The secure face service could not be reached.');
        }
        if (remote.enrolled) {
          const installed = await installFaceFeature(firebaseUid, remote.faceFeature);
          if (installed.code !== FaceAICode.VERIFY_SUCCESS) {
            throw new Error(installed.message || 'Could not restore the secure face reference.');
          }
          feature = remote.faceFeature;
          restored = true;
        }
      }

      if (!restored) {
        setPhase('enrolling');
        setStatus('Follow the enrollment prompts…');
        const enrolled = await enrollFace(firebaseUid, { mode: 1, showConfirm: true });
        if (!mountedRef.current) return;
        if (isUserCancel(enrolled)) {
          setPhase('ready');
          setStatus('Face setup was cancelled');
          return;
        }
        if (enrolled.code !== FaceAICode.VERIFY_SUCCESS || !isValidFaceFeature(enrolled.faceFeature)) {
          throw new Error(sdkMessage(enrolled.code, enrolled.message));
        }
        feature = enrolled.faceFeature;
        capture = enrolled.faceBase64 || null;
        setCaptureBase64(capture);
        // Let the native enrollment screen dismiss and give the user a clear
        // animated mesh confirmation before opening the liveness camera.
        await sleep(900);
        if (!mountedRef.current) return;
      }

      // Enrollment alone extracts a reference; it is not proof of liveness.
      if (!feature) throw new Error('No face reference was produced. Please repeat the scan.');
      // `faceVerify` is the mandatory second SDK operation: motion + silent
      // anti-spoofing and a 1:1 live match against the enrolled reference.
      setPhase('verifying');
      setStatus('Now complete the live anti-spoofing check…');
      const verified = await verifyFace(firebaseUid, {
        threshold: 0.83,
        livenessType: 1,
        motionTypes: '1,2,3,4,5',
        timeout: 10,
        steps: 2,
        allowMultiFaces: false,
      });
      if (!mountedRef.current) return;
      if (isUserCancel(verified)) {
        setPhase('ready');
        setStatus('Live verification was cancelled');
        return;
      }
      if (verified.code !== FaceAICode.VERIFY_SUCCESS) {
        throw new Error(sdkMessage(verified.code, verified.message));
      }

      const liveness = { code: verified.code, score: verified.liveness };
      // Prefer the image from the liveness check: it is the capture the SDK
      // proved live AND matched to the enrolled face. The enrollment capture
      // is only a fallback for a build that returns no verify image.
      const referenceImage = verified.faceBase64 || capture || null;
      approvedFeatureRef.current = feature;
      approvedLivenessRef.current = liveness;
      approvedImageRef.current = referenceImage;

      if (registrationMode) {
        await finishNodeRegistration(feature, liveness, referenceImage);
      } else {
        setPhase('saving-face');
        setStatus('Encrypting your face reference…');
        const stored = await uploadEnrollment(feature, {
          livenessCode: verified.code,
          livenessScore: verified.liveness,
          sdkVersion: FACE_AI_SDK_VERSION,
          faceImage: referenceImage,
        });
        if (!stored.ok) {
          if (IMAGE_REJECTED_ERRORS.has(stored.error)) {
            approvedFeatureRef.current = null;
            approvedLivenessRef.current = null;
            approvedImageRef.current = null;
          }
          throw new Error(SERVER_ERROR_COPY[stored.error] ?? stored.hint ?? 'Could not store the encrypted face reference.');
        }
        if (mountedRef.current) {
          setPhase('done');
          setStatus('Face ID setup complete');
        }
      }
    } catch (err) {
      if (!mountedRef.current) return;
      setPhase('ready');
      setStatus(approvedFeatureRef.current ? 'Secure check passed — retry account creation' : 'Ready to try again');
      Alert.alert(
        approvedFeatureRef.current ? 'Could not finish registration' : 'Face setup failed',
        err instanceof Error ? err.message : 'Please try again.',
      );
    }
  }, [firebaseUid, finishNodeRegistration, registrationMode, sdkMessage, sdkReady]);

  const cancelRegistration = useCallback(async () => {
    if (busy) return;
    if (firebaseUid) {
      try { await removeLocalFaceFeature(firebaseUid); } catch {}
    }
    if (registrationMode) {
      try { await firebaseSignOut(getAuth()); } catch {}
      navigation.replace('CreateAccount');
      return;
    }
    navigation.goBack();
  }, [busy, firebaseUid, navigation, registrationMode]);

  const finish = useCallback(() => {
    if (registrationMode) {
      navigation.reset({ index: 0, routes: [{ name: 'Chats' }] });
    } else if (onDone) {
      onDone();
    } else {
      navigation.goBack();
    }
  }, [navigation, onDone, registrationMode]);

  const phaseLabel: Record<Phase, string> = {
    ready: approvedFeatureRef.current ? 'Retry setup' : (registrationMode ? 'Begin secure scan' : 'Begin secure scan'),
    enrolling: 'Opening enrollment camera…',
    verifying: 'Running anti-spoofing…',
    'saving-face': 'Securing face reference…',
    'creating-account': 'Creating account…',
    done: 'Complete',
  };

  const steps = useMemo<[IconName, string][]>(
    () => [
      ['sunny-outline', 'Find soft, even lighting — avoid strong backlight'],
      ['phone-portrait-outline', 'Hold your phone at eye level'],
      ['happy-outline', 'Follow the quick movement prompts when asked'],
    ],
    [],
  );

  const introStyle = {
    opacity: intro,
    transform: [{ translateY: intro.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
  };

  const titleText = done
    ? (registrationMode ? 'Your account is ready' : 'Face ID is set up')
    : (registrationMode ? 'Secure your registration' : 'Verify your live face');

  const subtitleText = busy
    ? status
    : done
      ? (registrationMode
          ? 'Your phone and live face were verified. Your encrypted face reference is secured and your account registration is complete.'
          : 'Your live face was verified. Your encrypted face reference is now secured on your account.')
      : (registrationMode
          ? 'The secure camera will enroll your face, then ask for two quick movements and run silent anti-spoofing before your account is created.'
          : 'The secure camera will enroll your face, then ask for two quick movements and run silent anti-spoofing to secure your account.');

  return (
    <View style={styles.root}>
      <AppBg />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Animated.View style={[styles.inner, introStyle]}>
          {/* Status chip */}
          <View style={[styles.chip, done && styles.chipDone]}>
            <View style={[styles.chipDot, done && styles.chipDotDone]} />
            <AppText fixedColor style={[styles.chipText, done && styles.chipTextDone]}>
              {registrationMode ? 'FINAL REGISTRATION STEP' : 'SECURE FACE SETUP'}
            </AppText>
          </View>

          {/* Hero scanner */}
          <View style={styles.hero}>
            <FaceMeshScan imageBase64={captureBase64} active={!done} success={done} />
          </View>

          {/* Title + context line */}
          <AppText style={styles.title}>{titleText}</AppText>
          <AppText style={styles.subtitle}>{subtitleText}</AppText>

          {/* State-aware body */}
          {done ? (
            <View style={styles.successCard}>
              <View style={styles.successIcon}>
                <AppIcon name="checkmark-circle" size={22} color="#15803D" fixedColor />
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={styles.successTitle}>FaceAISDK liveness passed</AppText>
                <AppText style={styles.successCopy}>
                  Anti-spoofing and the live match both cleared before anything was secured.
                </AppText>
              </View>
            </View>
          ) : busy ? (
            <View style={styles.progressCard}>
              <ActivityIndicator color={COLORS.blue} />
              <AppText style={styles.progressText}>{status || 'Please wait…'}</AppText>
            </View>
          ) : (
            <View style={styles.stepsCard}>
              <AppText style={styles.stepsTitle}>BEFORE YOU START</AppText>
              {steps.map(([icon, label]) => (
                <View key={label} style={styles.stepRow}>
                  <View style={styles.stepIcon}>
                    <AppIcon name={icon} size={17} color={COLORS.blue} fixedColor />
                  </View>
                  <AppText style={styles.stepText}>{label}</AppText>
                </View>
              ))}
            </View>
          )}

          {avatarWarning && done ? (
            <View style={styles.unavailableCard}>
              <AppIcon name="alert-circle-outline" size={18} color={COLORS.amber} fixedColor />
              <AppText fixedColor style={styles.unavailableText}>
                Your account is ready, but the optional logo didn’t upload. Add it later from Profile.
              </AppText>
            </View>
          ) : null}

          {!sdkReady && !done ? (
            <View style={styles.unavailableCard}>
              <AppIcon name="alert-circle-outline" size={18} color={COLORS.amber} fixedColor />
              <AppText fixedColor style={styles.unavailableText}>
                {Platform.OS === 'web'
                  ? 'Face registration requires a physical iOS or Android device.'
                  : 'The FaceAISDK native module is not loaded. Rebuild the native app.'}
              </AppText>
            </View>
          ) : null}

          {/* Reassurance */}
          <View style={styles.reassureRow}>
            <AppIcon name="lock-closed" size={13} color={COLORS.sub} />
            <AppText style={styles.reassureText}>
              On-device anti-spoofing · encrypted on our secure server
            </AppText>
          </View>
        </Animated.View>
      </ScrollView>

      {/* Floating action bar */}
      <View style={styles.ctaBar}>
        {done ? (
          <TouchableOpacity style={styles.cta} onPress={finish} activeOpacity={0.9}>
            <LinearGradient
              colors={GRADIENTS.primary}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.ctaInner}
            >
              <AppIcon name="checkmark-circle-outline" size={19} color="#fff" fixedColor />
              <AppText fixedColor style={styles.ctaText}>Continue to ChitChat</AppText>
            </LinearGradient>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={[styles.cta, (busy || !sdkReady) && styles.disabled]}
              onPress={handleBegin}
              disabled={busy || !sdkReady}
              activeOpacity={0.9}
              accessibilityRole="button"
              accessibilityLabel="Begin secure face enrollment"
            >
              <LinearGradient
                colors={GRADIENTS.primary}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.ctaInner}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <AppIcon name="scan" size={19} color="#fff" fixedColor />
                    <AppText fixedColor style={styles.ctaText}>{phaseLabel[phase]}</AppText>
                  </>
                )}
              </LinearGradient>
            </TouchableOpacity>
            <TouchableOpacity onPress={cancelRegistration} disabled={busy} style={styles.back}>
              <AppText style={styles.backText}>
                {registrationMode ? 'Cancel registration' : 'Back'}
              </AppText>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingTop: 52,
    paddingBottom: 176,
  },
  inner: { width: '100%', alignItems: 'center', gap: 16 },

  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(9,178,238,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.22)',
  },
  chipDone: { backgroundColor: 'rgba(52,199,89,0.10)', borderColor: 'rgba(52,199,89,0.28)' },
  chipDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.blue },
  chipDotDone: { backgroundColor: COLORS.green },
  chipText: { color: COLORS.blueDark, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  chipTextDone: { color: '#15803D' },

  hero: { marginTop: 10, marginBottom: 2, alignItems: 'center', justifyContent: 'center' },

  title: { fontSize: 24, fontWeight: '800', color: COLORS.text, textAlign: 'center', marginTop: 4 },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    color: COLORS.sub,
    textAlign: 'center',
    maxWidth: 330,
  },

  stepsCard: {
    width: '100%',
    maxWidth: 440,
    borderRadius: RADIUS.lg,
    backgroundColor: COLORS.white,
    padding: 16,
    gap: 13,
    ...SHADOW.card,
  },
  stepsTitle: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.8, color: COLORS.sub },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(9,178,238,0.10)',
  },
  stepText: { flex: 1, fontSize: 14, lineHeight: 19, color: COLORS.text, fontWeight: '600' },

  progressCard: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: RADIUS.lg,
    backgroundColor: COLORS.white,
    padding: 18,
    ...SHADOW.card,
  },
  progressText: { flex: 1, fontSize: 14, color: COLORS.text, fontWeight: '600' },

  successCard: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderRadius: RADIUS.lg,
    backgroundColor: '#F0FDF4',
    borderWidth: 1,
    borderColor: 'rgba(52,199,89,0.30)',
    padding: 16,
  },
  successIcon: {
    width: 34,
    height: 34,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(52,199,89,0.14)',
  },
  successTitle: { fontSize: 14, fontWeight: '800', color: '#15803D' },
  successCopy: { fontSize: 12.5, lineHeight: 18, color: '#166534', marginTop: 3 },

  unavailableCard: {
    width: '100%',
    maxWidth: 440,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    padding: 13,
    borderRadius: RADIUS.md,
    backgroundColor: '#FFF4E5',
    borderWidth: 1,
    borderColor: 'rgba(255,149,0,0.35)',
  },
  unavailableText: { flex: 1, color: '#B4610A', fontSize: 12.5, lineHeight: 18 },

  reassureRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  reassureText: { color: COLORS.sub, fontSize: 11.5 },

  ctaBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 30,
    gap: 4,
    backgroundColor: COLORS.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.border,
  },
  cta: { width: '100%', borderRadius: RADIUS.md, overflow: 'hidden', ...SHADOW.button },
  ctaInner: {
    minHeight: 56,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.md,
  },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  disabled: { opacity: 0.5 },
  back: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 16 },
  backText: { color: COLORS.sub, fontSize: 14, fontWeight: '600' },
});
