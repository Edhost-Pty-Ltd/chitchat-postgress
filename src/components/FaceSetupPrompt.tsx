// ─── "Add Face ID" prompt for pre-feature accounts ──────────────────────────
// Face enrollment became mandatory for NEW sign-ups, but accounts created
// before the feature shipped have a users row yet no encrypted face reference
// in the Django face service. Those users pass the account gate and reach the
// app normally (identity_verified defaults to true), so we must NOT force them
// back through registration. Instead we offer an optional, dismissible path to
// enroll a face now.
//
// Why it matters: without an enrolled reference, a reported account can never
// clear the live-verification gate (Django returns not_enrolled). Enrolling
// here lets an existing user recover later and keeps their identity continuous.
//
// This renders as the Chats list header, so it is zero-height when hidden and
// re-checks enrollment via useFocusEffect whenever the user returns from the
// FaceEnrollment screen. It reuses that screen in non-registration mode, which
// stores the encrypted feature (POST /api/face/enroll/) without creating a new
// account — the existing one is untouched.

import React, { useCallback, useState } from 'react';
import { Platform, StyleSheet, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';

import { AppIcon, AppText, useGlass } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { faceStatus } from '../api/faceApi';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import type { RootStackParamList } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

// Dismissing hides the prompt for a few days rather than forever: face setup is
// optional for existing accounts, but we keep gently reoffering it.
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
const snoozeKey = (userId: string) => `face_setup_snooze:${userId}`;

export default function FaceSetupPrompt() {
  const { isSignedIn, isCompanion, loading, userId } = useAuth();
  const navigation = useNavigation<NavProp>();
  const [visible, setVisible] = useState(false);

  // Companions enroll nothing (Django rejects them), the SDK is native-only,
  // and we need a resolved owner before asking the face service anything.
  const eligible =
    isSignedIn && !isCompanion && !loading && !!userId && Platform.OS !== 'web';

  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (!eligible) {
        setVisible(false);
        return () => {
          active = false;
        };
      }

      (async () => {
        try {
          const [snoozeRaw, status] = await Promise.all([
            AsyncStorage.getItem(snoozeKey(userId!)),
            // Returns null on any error/offline → we simply stay hidden rather
            // than nag when the service state is unknown.
            faceStatus(),
          ]);
          if (!active) return;
          if (!status) return;
          if (status.enrolled) {
            // Enrolled (possibly on another device) → never offer again.
            AsyncStorage.removeItem(snoozeKey(userId!)).catch(() => {});
            setVisible(false);
            return;
          }
          const snoozedUntil = snoozeRaw ? parseInt(snoozeRaw, 10) : 0;
          setVisible(!(snoozedUntil && Date.now() < snoozedUntil));
        } catch {
          // Leave hidden on unexpected failure.
        }
      })();

      return () => {
        active = false;
      };
    }, [eligible, userId]),
  );

  const { bevel } = useGlass();

  const onSetup = useCallback(() => {
    // Hide immediately; the focus re-check on return confirms enrollment and
    // keeps it hidden (or reoffers if the user backed out).
    setVisible(false);
    navigation.navigate('FaceEnrollment', { mode: 'enrollment' });
  }, [navigation]);

  const onDismiss = useCallback(() => {
    setVisible(false);
    if (userId) {
      AsyncStorage.setItem(snoozeKey(userId), String(Date.now() + SNOOZE_MS)).catch(() => {});
    }
  }, [userId]);

  if (!visible) return null;

  return (
    <View style={[styles.card, bevel]}>
      <View style={styles.row}>
        <LinearGradient colors={GRADIENTS.primary} style={styles.iconTile}>
          <AppIcon name="scan-outline" size={20} color="#fff" fixedColor />
        </LinearGradient>
        <View style={styles.copy}>
          <AppText style={styles.title}>Add Face ID to your account</AppText>
          <AppText style={styles.body}>
            Your account was created before face verification. Add your face so you can recover
            access if it is ever reported — you do not need to register again.
          </AppText>
        </View>
        <TouchableOpacity
          onPress={onDismiss}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss face setup for now"
        >
          <AppIcon name="close" size={18} color={COLORS.sub} />
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={onSetup} activeOpacity={0.85} style={styles.buttonWrap}>
        <LinearGradient colors={GRADIENTS.primary} style={styles.button}>
          <AppIcon name="shield-checkmark-outline" size={18} color="#fff" fixedColor />
          <AppText fixedColor style={styles.buttonText}>
            Set up Face ID
          </AppText>
        </LinearGradient>
      </TouchableOpacity>

      <TouchableOpacity onPress={onDismiss} style={styles.later}>
        <AppText style={styles.laterText}>Not now</AppText>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS.lg,
    padding: 14,
    marginTop: 4,
    marginBottom: 12,
    gap: 12,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  iconTile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },
  copy: { flex: 1, gap: 3 },
  title: { fontSize: 14.5, fontWeight: '800', color: COLORS.text },
  body: { fontSize: 12.5, lineHeight: 18, color: COLORS.sub },
  buttonWrap: { borderRadius: RADIUS.md, overflow: 'hidden' },
  button: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
    borderRadius: RADIUS.md,
    ...SHADOW.button,
  },
  buttonText: { color: '#fff', fontSize: 14.5, fontWeight: '800' },
  later: { alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 12 },
  laterText: { color: COLORS.sub, fontSize: 13, fontWeight: '600' },
});
