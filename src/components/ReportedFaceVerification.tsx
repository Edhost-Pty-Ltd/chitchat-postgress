// ─── Reported-user identity re-verification ─────────────────────────────────
// Lives INSIDE VerificationGate (which covers the navigator while a report is
// active) and forwards Django's signed proof to Node via onVerifiedProof.
//
// Two cases:
//   • Enrolled account: SDK runs liveness only; the server matches the captured
//     live face against the stored reference and mints the receipt.
//   • Legacy account reported with NO enrolled face: first-time enrollment with
//     live anti-spoofing, stored as the reference, then the report is cleared.
//
// The real camera + liveness prompts are the FaceAISDK's own full-screen native
// screens (not stylable from JS). Everything here is the premium lead-in,
// instructions, live status and result around that handoff.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { AppBg, AppIcon, AppText } from '../context/ThemeContext';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import { useAuth } from '../context/AuthContext';
import FaceMeshScan from './FaceMeshScan';
import {
  enrollFace,
  enrollFaceFromBase64,
  FACE_AI_SDK_VERSION,
  FaceAICode,
  isFaceAIModuleAvailable,
  isUserCancel,
  isValidFaceFeature,
  removeLocalFaceFeature,
  verifyFace,
  verifyLiveness,
} from '../sdk/faceAI';
import {
  faceStatus,
  fetchEnrollmentFeature,
  uploadEnrollment,
  verifyReportedAccount,
} from '../api/faceApi';

interface VerifiedProof {
  receipt: string;
  verifiedAt: string;
}

interface Props {
  reportGeneration: string;
  onBack: () => void;
  /** Returns false when Node did not accept the signed proof. */
  onVerifiedProof: (proof: VerifiedProof) => Promise<boolean>;
}

type IconName = React.ComponentProps<typeof AppIcon>['name'];

const SDK_ERROR_COPY: Partial<Record<number, string>> = {
  [FaceAICode.VERIFY_FAILED]: 'The live face did not match the reference enrolled before this report. Your account remains unverified.',
  [FaceAICode.MOTION_LIVENESS_TIMEOUT]: 'The liveness check timed out. Please try again.',
  [FaceAICode.NO_FACE_MULTI]: 'The camera could not see your face clearly. Find better light and try again.',
  [FaceAICode.NO_FACE_FEATURE]: 'No face reference was found on this device. Contact support if the problem persists.',
  [FaceAICode.COLOR_LIVENESS_FAILED]: 'The screen-light liveness check failed. Move somewhere less bright and retry.',
  [FaceAICode.COLOR_LIVENESS_LIGHT_TOO_HIGH]: 'The surrounding light is too strong. Move away from direct sunlight.',
  [FaceAICode.SILENT_LIVENESS_FAILED]: 'The silent liveness check failed. Please try again in a well-lit space.',
  [FaceAICode.NOT_ALLOW_MULTI_FACES]: 'Only your face should be visible during verification.',
};

const SERVER_ERROR_COPY: Record<string, string> = {
  not_enrolled: 'No face reference exists yet. Set up your face to restore access.',
  locked: 'Too many faces did not match. Contact support to unlock identity verification.',
  reference_unreadable: 'Your encrypted face reference could not be read. Contact support.',
  reference_not_recovery_eligible: 'This face reference cannot be used for reported-account recovery. Contact support.',
  report_generation_invalid: 'This report state changed. Return and start again.',
  liveness_failed: 'The on-device liveness result was not accepted. Please retry in better light.',
  bad_feature: 'The face reference was incomplete. Please repeat the scan.',
  no_face_detected: 'The server could not find a clear single face in the capture. Face the camera in even light and try again.',
  arcface_failed: 'The captured face could not be processed. Please try again in good, even light.',
  insightface_unavailable: 'The face-matching service is warming up or unavailable. Please try again shortly.',
  already_enrolled: 'A face reference already exists for this account. Return and verify instead.',
  service_unavailable: 'The face service is temporarily unavailable. Try again later.',
  receipt_not_configured: 'Secure verification handoff is unavailable. Contact support.',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Turn the SDK's captured live-face image into an SDK feature template
 * on-device. The image itself is also sent to the server, where InsightFace
 * makes the authoritative match; this template is only used by the server's
 * fallback check for accounts that have no InsightFace reference yet. A
 * throwaway id keeps no residual reference on the device.
 */
async function extractLiveFeature(base64Image: string): Promise<string | null> {
  const tempId = `recovery-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const result = await enrollFaceFromBase64(tempId, base64Image);
    if (result.code !== FaceAICode.VERIFY_SUCCESS || !isValidFaceFeature(result.faceFeature)) {
      return null;
    }
    return result.faceFeature;
  } catch (err) {
    console.warn('[ReportedFaceVerification] live feature extraction failed:', err);
    return null;
  } finally {
    void removeLocalFaceFeature(tempId).catch(() => {});
  }
}

export default function ReportedFaceVerification({
  reportGeneration,
  onBack,
  onVerifiedProof,
}: Props) {
  const { userId } = useAuth();
  const mountedRef = useRef(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>('');
  // null = unknown yet, true = account has no reference (first-time enroll),
  // false = enrolled (standard verify). Drives copy only; run() re-checks the
  // authoritative server state before acting.
  const [needsEnrollment, setNeedsEnrollment] = useState<boolean | null>(null);

  // Entrance animation for a polished lead-in.
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

  // Tailor the screen to whether a reference already exists. The server is
  // authoritative; a failed check just leaves the neutral "verify" copy.
  useEffect(() => {
    let active = true;
    (async () => {
      const s = await faceStatus();
      if (active && mountedRef.current && s) setNeedsEnrollment(!s.enrolled);
    })();
    return () => {
      active = false;
    };
  }, []);

  const sdkReady = isFaceAIModuleAvailable();

  // Decide the recovery path (server-authoritative):
  //   'ready'  → the server has a stored reference → liveness-only + server match
  //   'enroll' → the server has NO reference → first-time enrollment
  //   'error'  → could not prepare (already shown to the user)
  const prepare = useCallback(async (): Promise<'ready' | 'enroll' | 'error'> => {
    if (!userId) return 'error';
    // The SERVER decides the path and owns the match. We only need to know
    // whether a stored reference exists. If it does, the SDK runs a liveness-
    // only check and the server compares the live face to that reference; if it
    // does not, this is a first-time enrollment. No local reference is needed on
    // this device for the match.
    setStatus('Checking your secure face reference…');
    const remote = await fetchEnrollmentFeature();
    if (!mountedRef.current) return 'error';
    if (!remote.ok) {
      Alert.alert('Could not reach face service', 'Check your connection and try again.');
      return 'error';
    }
    return remote.enrolled ? 'ready' : 'enroll';
  }, [userId]);

  const run = useCallback(async () => {
    if (!userId) {
      Alert.alert('Not signed in', 'Sign in before verifying.');
      return;
    }
    if (!sdkReady) {
      Alert.alert(
        'Face SDK unavailable',
        'The face recognition module is not loaded. Rebuild the app and try again.',
      );
      return;
    }
    setBusy(true);
    setStatus('Preparing secure verification…');
    try {
      const path = await prepare();
      if (path === 'error' || !mountedRef.current) return;

      let faceFeature: string;
      let livenessScore: number;
      let livenessCode: number;
      let similarity: number;
      // The live face image captured after liveness passes. Sent to the server
      // so InsightFace makes the authoritative ArcFace match. The SDK feature
      // is still sent alongside it for the legacy cosine fallback and audit.
      let liveFaceImage: string | null = null;

      if (path === 'enroll') {
        // Legacy reported account with no reference. The only safe recovery is
        // a fresh enrollment with live anti-spoofing; this live face then
        // becomes the account's immutable reference.
        if (mountedRef.current) setNeedsEnrollment(true);
        // Clear any stale local reference so first-time enrollment starts clean.
        try { await removeLocalFaceFeature(userId); } catch {}
        setStatus('Set up your face — follow the prompts…');
        const enrolled = await enrollFace(userId, { mode: 1, showConfirm: true });
        if (!mountedRef.current) return;
        if (isUserCancel(enrolled)) return;
        if (enrolled.code !== FaceAICode.VERIFY_SUCCESS || !isValidFaceFeature(enrolled.faceFeature)) {
          Alert.alert(
            'Setup not completed',
            SDK_ERROR_COPY[enrolled.code] ?? enrolled.message ?? 'Face setup could not be completed. Please try again.',
          );
          return;
        }
        // Let the native enrollment screen fully dismiss before opening the
        // liveness camera — mirrors the registration flow and avoids a race
        // where verifyFace starts while the enroll UI is still on screen.
        await sleep(900);
        if (!mountedRef.current) return;
        setStatus('Now complete the live anti-spoofing check…');
        const verified = await verifyFace(userId, {
          livenessType: 1,
          motionTypes: '1,2,3,4,5',
          timeout: 7,
          steps: 2,
          allowMultiFaces: false,
          threshold: 0.83,
        });
        if (!mountedRef.current) return;
        if (isUserCancel(verified)) return;
        if (verified.code !== FaceAICode.VERIFY_SUCCESS || !verified.faceFeature) {
          Alert.alert(
            'Verification not completed',
            SDK_ERROR_COPY[verified.code] ?? verified.message ?? 'Verification could not be completed. Please try again.',
          );
          return;
        }
        // Persist the new reference so any later recovery uses the standard 1:1
        // path. A concurrent enrollment (already_enrolled) is fine — proceed.
        setStatus('Securing your new face reference…');
        // The liveness-verified capture becomes the server's InsightFace
        // reference; the enrollment capture is only a fallback.
        const referenceImage = verified.faceBase64 || enrolled.faceBase64 || null;
        const stored = await uploadEnrollment(enrolled.faceFeature, {
          livenessCode: verified.code,
          livenessScore: verified.liveness,
          sdkVersion: FACE_AI_SDK_VERSION,
          faceImage: referenceImage,
        });
        if (!mountedRef.current) return;
        if (!stored.ok && stored.error !== 'already_enrolled') {
          Alert.alert(
            'Could not secure reference',
            SERVER_ERROR_COPY[stored.error] ?? stored.hint ?? 'Your face could not be saved. Please try again.',
          );
          return;
        }
        // First-time enrollment: there is no prior reference to match against,
        // so send the just-stored reference as the live feature (server cosine
        // compares it to itself → 1.0). Liveness was the real gate, and passed.
        faceFeature = enrolled.faceFeature;
        livenessScore = verified.liveness;
        livenessCode = verified.code;
        similarity = verified.similarity;
        liveFaceImage = referenceImage;
      } else {
        // Enrolled on the server. Use the SDK for LIVENESS ONLY, then let the
        // server match the captured live face against the stored reference.
        setStatus('Follow the on-screen liveness prompts…');
        const live = await verifyLiveness({
          livenessType: 1,
          motionTypes: '1,2,3,4,5',
          timeout: 7,
          steps: 2,
          allowMultiFaces: false,
        });
        if (!mountedRef.current) return;
        if (isUserCancel(live)) return;
        if (live.code !== FaceAICode.ALL_LIVENESS_SUCCESS) {
          Alert.alert(
            'Liveness not completed',
            SDK_ERROR_COPY[live.code] ?? live.message ?? 'The liveness check did not pass. Please try again.',
          );
          return;
        }
        if (!live.faceBase64) {
          Alert.alert('No face captured', 'The liveness check did not return a face image. Please try again.');
          return;
        }
        // Convert the captured live face into a template on-device and send it;
        // the server compares it to the stored reference and decides the match.
        setStatus('Verifying your face with the secure service…');
        const liveFeature = await extractLiveFeature(live.faceBase64);
        if (!mountedRef.current) return;
        if (!liveFeature) {
          Alert.alert('Could not read face', 'The captured face could not be processed. Please try again in good, even light.');
          return;
        }
        faceFeature = liveFeature;
        livenessScore = live.liveness;
        livenessCode = live.code;
        similarity = live.similarity;
        // The server runs InsightFace on this live image for the real match.
        liveFaceImage = live.faceBase64;
      }

      setStatus('Confirming with the secure service…');
      const result = await verifyReportedAccount({
        reportGeneration,
        faceFeature,
        livenessScore,
        livenessCode,
        similarity,
        faceImage: liveFaceImage,
      });
      if (!mountedRef.current) return;

      if (!result.ok) {
        const msg =
          SERVER_ERROR_COPY[result.error] ??
          result.hint ??
          'Verification failed. Please try again.';
        Alert.alert('Verification not completed', msg);
        return;
      }
      if (typeof result.score === 'number') {
        const needTxt =
          typeof result.threshold === 'number' ? `, threshold ${(result.threshold * 100).toFixed(0)}%` : '';
        console.log(
          `[ReportedFaceVerification] face match ${(result.score * 100).toFixed(1)}%${needTxt} → ${result.matched ? 'MATCH' : 'no match'}`,
        );
      }
      if (!result.matched) {
        const pct =
          typeof result.score === 'number'
            ? ` Match was ${(result.score * 100).toFixed(1)}%` +
              (typeof result.threshold === 'number' ? ` (need ${(result.threshold * 100).toFixed(0)}%).` : '.')
            : '';
        Alert.alert(
          'Face did not match',
          `The live face did not match the reference on file.${pct} Your account remains unverified.`,
        );
        return;
      }

      const finalized = await onVerifiedProof({
        receipt: result.receipt,
        verifiedAt: result.verifiedAt,
      });
      if (!finalized && mountedRef.current) {
        Alert.alert(
          'Could not finish',
          'Your face check passed, but the account status could not be updated. Please start again.',
        );
      }
    } catch (err) {
      if (mountedRef.current) {
        Alert.alert(
          'Verification error',
          err instanceof Error ? err.message : 'Please try again.',
        );
      }
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setStatus('');
      }
    }
  }, [onVerifiedProof, prepare, reportGeneration, sdkReady, userId]);

  const enrollMode = needsEnrollment === true;

  const steps = useMemo<[IconName, string][]>(
    () => [
      ['sunny-outline', 'Find soft, even lighting — avoid strong backlight'],
      ['phone-portrait-outline', 'Hold your phone at eye level'],
      enrollMode
        ? ['happy-outline', 'Follow the quick prompts to set up Face ID']
        : ['scan-outline', 'Follow the quick movement prompts'],
    ],
    [enrollMode],
  );

  const introStyle = {
    opacity: intro,
    transform: [{ translateY: intro.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }],
  };

  return (
    <View style={styles.root}>
      <AppBg />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Animated.View style={[styles.inner, introStyle]}>
          {/* Status chip */}
          <View style={styles.chip}>
            <View style={styles.chipDot} />
            <AppText fixedColor style={styles.chipText}>SECURE IDENTITY CHECK</AppText>
          </View>

          {/* Hero scanner */}
          <View style={styles.hero}>
            <FaceMeshScan active={!busy} />
          </View>

          {/* Title + context line */}
          <AppText style={styles.title}>
            {enrollMode ? 'Set up Face ID' : 'Verify it’s really you'}
          </AppText>
          <AppText style={styles.subtitle}>
            {busy
              ? status || 'Working…'
              : enrollMode
                ? 'Your account was reported and has no face on file. Add your face to restore access — it becomes your secure reference.'
                : 'A quick live check confirms your face against the encrypted reference on your account.'}
          </AppText>

          {/* State-aware body */}
          {busy ? (
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

          {!sdkReady ? (
            <View style={styles.unavailableCard}>
              <AppIcon name="alert-circle-outline" size={18} color={COLORS.amber} fixedColor />
              <AppText fixedColor style={styles.unavailableText}>
                The face module isn’t loaded in this build. Rebuild the app to continue.
              </AppText>
            </View>
          ) : null}

          {/* Reassurance */}
          <View style={styles.reassureRow}>
            <AppIcon name="lock-closed" size={13} color={COLORS.sub} />
            <AppText style={styles.reassureText}>
              On-device anti-spoofing · matched on our secure server
            </AppText>
          </View>
        </Animated.View>
      </ScrollView>

      {/* Floating action bar */}
      <View style={styles.ctaBar}>
        <TouchableOpacity
          style={[styles.cta, (!sdkReady || busy) && styles.disabled]}
          onPress={run}
          disabled={busy || !sdkReady}
          activeOpacity={0.9}
          accessibilityRole="button"
          accessibilityLabel={enrollMode ? 'Set up your face and restore access' : 'Start secure identity verification'}
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
                <AppText fixedColor style={styles.ctaText}>
                  {enrollMode ? 'Set up Face ID' : 'Start face scan'}
                </AppText>
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
        <TouchableOpacity onPress={onBack} disabled={busy} style={styles.back}>
          <AppText style={styles.backText}>Not now</AppText>
        </TouchableOpacity>
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
  chipDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.blue },
  chipText: { color: COLORS.blueDark, fontSize: 11, fontWeight: '800', letterSpacing: 1 },

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
