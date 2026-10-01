// ─── Biometric Gate ──────────────────────────────────────────────────────────
// App-level overlay lock. When biometric login is enabled, the app locks ONCE
// per launch: on cold start when the user already has a signed-in session.
// It does NOT re-prompt on navigation or when returning to the foreground, so
// the user is only asked for biometrics a single time when the app opens.
// Shows a lock screen with the app logo and an unlock button that prompts the
// device's biometric authentication. Unlocks only on a confirmed success.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Image, StyleSheet, TouchableOpacity, Platform,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Text } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import {
  isBiometricEnabled, isBiometricAvailable, authenticateBiometric, getBiometricLabel,
} from '../utils/biometrics';

export function BiometricGate() {
  const { isSignedIn, loading } = useAuth();

  const [locked, setLocked]         = useState(false);
  const [authing, setAuthing]       = useState(false);
  const [label, setLabel]           = useState('Biometrics');
  const initRef                     = useRef(false);

  // Biometrics are mobile-only.
  const supported = Platform.OS !== 'web';

  // ── Lock the app if biometric login is enabled ──────────────────────────────
  const lockIfEnabled = useCallback(async () => {
    if (!supported) return;
    const [enabled, available] = await Promise.all([
      isBiometricEnabled(),
      isBiometricAvailable(),
    ]);
    if (enabled && available) {
      setLabel(await getBiometricLabel());
      setLocked(true);
    }
  }, [supported]);

  // ── Cold start: lock once auth has resolved and the user is signed in ───────
  // We mark initialisation complete as soon as `loading` resolves so that a
  // *fresh* sign-in/registration (isSignedIn flipping true afterwards) does NOT
  // trigger a lock — only an already-signed-in session at cold start does.
  useEffect(() => {
    if (!supported || loading || initRef.current) return;
    initRef.current = true;
    if (isSignedIn) {
      lockIfEnabled();
    }
  }, [supported, loading, isSignedIn, lockIfEnabled]);

  // ── Re-lock on background → foreground transitions ──────────────────────────
  // (Intentionally omitted.) Re-locking on every foreground caused repeated
  // prompts — the biometric system dialog itself briefly backgrounds the app,
  // which would immediately re-trigger the lock. The app now prompts only once
  // per launch.

  // ── If the user signs out while locked, clear the lock ──────────────────────
  // Note: we intentionally do NOT reset `initRef` here. Keeping it set means a
  // subsequent fresh sign-in (OTP) within the same app session won't trigger a
  // cold-start lock; only a true cold start or a background→foreground return
  // (both gated on isSignedIn) will lock.
  useEffect(() => {
    if (!isSignedIn) {
      setLocked(false);
    }
  }, [isSignedIn]);

  const handleUnlock = useCallback(async () => {
    if (authing) return;
    setAuthing(true);
    try {
      const ok = await authenticateBiometric('Unlock ChitChat');
      if (ok) setLocked(false);
    } finally {
      setAuthing(false);
    }
  }, [authing]);

  // Auto-prompt as soon as the lock appears.
  useEffect(() => {
    if (locked) handleUnlock();
  }, [locked]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!locked) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto">
      <LinearGradient colors={GRADIENTS.bg} style={StyleSheet.absoluteFill} />
      <View style={styles.center}>
        <Image
          source={require('../../assets/icon.png')}
          style={styles.logo}
          resizeMode="contain"
        />
        <View style={styles.iconWrap}>
          <Ionicons name="lock-closed" size={42} color={COLORS.blue} />
        </View>
        <Text style={styles.title}>ChitChat Locked</Text>
        <Text style={styles.sub}>Unlock with {label} to continue.</Text>

        <TouchableOpacity onPress={handleUnlock} activeOpacity={0.85} disabled={authing}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.btn}>
            <Ionicons name="finger-print" size={20} color="#fff" style={{ marginRight: 8 }} />
            <Text style={styles.btnText}>{authing ? 'Verifying…' : `Unlock with ${label}`}</Text>
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  logo:   { width: 96, height: 96, marginBottom: 24 },
  iconWrap: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: 'rgba(74,153,233,0.12)',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.45)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
    ...SHADOW.glow,
  },
  title:  { fontSize: 22, fontWeight: '700', color: COLORS.text, marginBottom: 8 },
  sub:    { fontSize: 14, color: COLORS.sub, textAlign: 'center', marginBottom: 28, lineHeight: 20 },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: RADIUS.md, paddingVertical: 15, paddingHorizontal: 28, ...SHADOW.button,
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
