// ─── Reported-account verification gate ──────────────────────────────────────
// A report changes the canonical server status to verification_required and
// rotates a private generation. The only exit is:
//   On-device SDK liveness + match → Django signed receipt → Node verifies
//   receipt and atomically clears the generation. No local tap and no client-
//   supplied boolean can mark an account verified.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Image,
  Linking,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

import { useAuth } from '../context/AuthContext';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { endpoints } from '../api/endpoints';
import { socketClient } from '../realtime/socket';
import ReportedFaceVerification from './ReportedFaceVerification';
import IdentityVerificationBadge from './IdentityVerificationBadge';

const CACHED_BLOCK_KEY = 'identity_verification_required';

interface IdentityStatusEvent {
  userId?: string;
  identityVerified?: boolean;
  requiresVerification?: boolean;
  verificationGeneration?: string | null;
  verifiedAt?: string | null;
}

export function VerificationGate() {
  const { isSignedIn, loading, isCompanion, signOut, userId } = useAuth();
  const [blocked, setBlocked] = useState(false);
  const [generation, setGeneration] = useState<string | null>(null);
  const [flowOpen, setFlowOpen] = useState(false);
  const [verified, setVerified] = useState(false);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [statusError, setStatusError] = useState(false);
  const mountedRef = useRef(true);
  const blockedRef = useRef(false);
  const verifiedRef = useRef(false);

  useEffect(() => {
    blockedRef.current = blocked;
  }, [blocked]);
  useEffect(() => {
    verifiedRef.current = verified;
  }, [verified]);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const cacheBlocked = useCallback((value: boolean) => {
    if (!userId) return;
    const key = `${CACHED_BLOCK_KEY}:${userId}`;
    if (value) void AsyncStorage.setItem(key, 'true');
    else void AsyncStorage.removeItem(key);
  }, [userId]);

  const refreshStatus = useCallback(async () => {
    if (!isSignedIn) return;
    const res = await endpoints.getMe();
    if (!mountedRef.current) return;
    if (!res.ok) {
      // Never erase a previously-known block because the network failed.
      setStatusError(true);
      return;
    }
    setStatusError(false);
    const needsVerification =
      res.data.requiresVerification === true || res.data.identityVerified === false;
    if (needsVerification) {
      setVerified(false);
      setBlocked(true);
      setGeneration(res.data.verificationGeneration ?? null);
      cacheBlocked(true);
    } else {
      setGeneration(null);
      setFlowOpen(false);
      cacheBlocked(false);
      // A socket authorization refresh happens immediately after success. Keep
      // the explicit confirmation/mesh visible until the user taps Continue;
      // this GET proves the backend state but must not collapse the UI early.
      if (verifiedRef.current && blockedRef.current) return;
      setVerified(false);
      setBlocked(false);
    }
  }, [cacheBlocked, isSignedIn]);

  useEffect(() => {
    if (loading) return;
    if (!isSignedIn) {
      setBlocked(false);
      setGeneration(null);
      setFlowOpen(false);
      setVerified(false);
      setStatusError(false);
      return;
    }

    let active = true;
    // Restore a known report gate even while offline, then ask the server for
    // the authoritative generation/status.
    if (userId) {
      void AsyncStorage.getItem(`${CACHED_BLOCK_KEY}:${userId}`).then((cached) => {
        if (active && cached === 'true') setBlocked(true);
      });
    }
    void refreshStatus();

    const onFlagged = (raw: unknown) => {
      if (!active) return;
      const payload = (raw ?? {}) as IdentityStatusEvent;
      setVerified(false);
      setFlowOpen(false);
      setGeneration(payload.verificationGeneration ?? null);
      setBlocked(true);
      cacheBlocked(true);
      // An old event may not carry the generation; fetch it immediately.
      if (!payload.verificationGeneration) void refreshStatus();
    };

    const onIdentityStatus = (raw: unknown) => {
      if (!active) return;
      const payload = (raw ?? {}) as IdentityStatusEvent;
      if (payload.userId && payload.userId !== userId) return;
      if (payload.identityVerified === false || payload.requiresVerification === true) {
        onFlagged(payload);
      } else if (payload.identityVerified === true && blockedRef.current) {
        // Another primary session may have completed the check. Show the same
        // explicit confirmation rather than silently dropping the gate.
        setVerifiedAt(payload.verifiedAt ?? null);
        setVerified(true);
        setFlowOpen(false);
        setGeneration(null);
        cacheBlocked(false);
      }
    };

    const onReconnect = () => { if (active) void refreshStatus(); };
    void socketClient.connect().catch(() => {});
    const unsubscribeFlagged = socketClient.subscribe('user:flagged', onFlagged);
    const unsubscribeStatus = socketClient.subscribe('user:identity-status', onIdentityStatus);
    const unsubscribeReconnect = socketClient.subscribe('client:reconnect', onReconnect);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active' && active) void refreshStatus();
    });

    return () => {
      active = false;
      unsubscribeFlagged();
      unsubscribeStatus();
      unsubscribeReconnect();
      appState.remove();
    };
  }, [cacheBlocked, isSignedIn, loading, refreshStatus, userId]);

  const finalizeProof = useCallback(async (proof: {
    receipt: string;
    verifiedAt: string;
  }): Promise<boolean> => {
    const res = await endpoints.verifySelf(proof.receipt);
    if (!mountedRef.current) return false;
    if (!res.ok || res.data.identityVerified !== true) {
      setStatusError(true);
      // A 409 means another report rotated the generation while the camera was
      // open. Fetch the new generation and keep the gate firmly in place.
      await refreshStatus();
      return false;
    }

    setVerifiedAt(res.data.verifiedAt ?? proof.verifiedAt);
    setVerified(true);
    setFlowOpen(false);
    setGeneration(null);
    setStatusError(false);
    cacheBlocked(false);
    return true;
  }, [cacheBlocked, refreshStatus]);

  const continueToApp = useCallback(() => {
    // The backend already committed verified status. This only dismisses the
    // confirmation UI; it does not mutate identity state.
    setBlocked(false);
    setVerified(false);
  }, []);

  if (!blocked) return null;

  if (flowOpen && generation && !isCompanion) {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="auto">
        <ReportedFaceVerification
          key={generation}
          reportGeneration={generation}
          onBack={() => setFlowOpen(false)}
          onVerifiedProof={finalizeProof}
        />
      </View>
    );
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="auto">
      <LinearGradient colors={GRADIENTS.bg} style={StyleSheet.absoluteFill} />
      <View style={styles.center}>
        <Image source={require('../../assets/icon.png')} style={styles.logo} resizeMode="contain" />

        <View style={[styles.iconWrap, verified && styles.iconWrapOk]}>
          <Ionicons
            name={verified ? 'shield-checkmark' : 'shield-outline'}
            size={42}
            color={verified ? '#16A34A' : '#B45309'}
          />
        </View>

        {verified ? (
          <>
            <IdentityVerificationBadge verified />
            <View style={styles.successCard}>
              <Ionicons name="lock-closed" size={18} color="#15803D" />
              <View style={{ flex: 1 }}>
                <Text style={styles.successTitle}>Secure verification completed</Text>
                <Text style={styles.successCopy}>
                  Anti-spoofing, motion liveness, and the server-side match against your encrypted reference all passed.
                </Text>
                {verifiedAt ? (
                  <Text style={styles.successTime}>
                    Verified {new Date(verifiedAt).toLocaleString()}
                  </Text>
                ) : null}
              </View>
            </View>
            <Text style={styles.safetyNote}>
              Identity verification confirms continuity with the enrolled face. It is not an endorsement of future messages or transactions.
            </Text>
            <TouchableOpacity onPress={continueToApp} activeOpacity={0.85} style={styles.buttonWrap}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.button}>
                <Ionicons name="checkmark-circle" size={20} color="#fff" />
                <Text style={styles.buttonText}>Continue to ChitChat</Text>
              </LinearGradient>
            </TouchableOpacity>
          </>
        ) : (
          <>
            <IdentityVerificationBadge verified={false} />
            <Text style={styles.title}>Identity verification required</Text>
            <Text style={styles.sub}>
              Your account was reported, so its status changed from verified to not verified. Complete a live anti-spoofing check to continue.
            </Text>

            {isCompanion ? (
              <View style={styles.notice}>
                <Ionicons name="phone-portrait-outline" size={21} color="#B45309" />
                <Text style={styles.noticeText}>
                  Verify on your primary mobile device. This linked device will update automatically afterward.
                </Text>
              </View>
            ) : !generation ? (
              <View style={styles.notice}>
                <Ionicons name="cloud-offline-outline" size={21} color="#B45309" />
                <Text style={styles.noticeText}>
                  The secure verification request could not be loaded. Reconnect and retry.
                </Text>
              </View>
            ) : null}

            {statusError ? (
              <Text style={styles.errorText}>
                We could not confirm the latest account status. Your account remains locked.
              </Text>
            ) : null}

            {!isCompanion && generation ? (
              <TouchableOpacity
                onPress={() => setFlowOpen(true)}
                activeOpacity={0.85}
                style={styles.buttonWrap}
              >
                <LinearGradient colors={GRADIENTS.primary} style={styles.button}>
                  <Ionicons name="scan-outline" size={20} color="#fff" />
                  <Text style={styles.buttonText}>Verify with live face</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={refreshStatus} style={styles.secondaryButton}>
                <Ionicons name="refresh" size={18} color={COLORS.blue} />
                <Text style={styles.secondaryText}>Retry status check</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              onPress={() => Linking.openURL('https://chit-chat-67a7f.web.app/support.html')}
              style={styles.supportButton}
            >
              <Ionicons name="help-circle-outline" size={17} color={COLORS.blue} />
              <Text style={styles.supportText}>Contact support</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={signOut} style={styles.signOutButton}>
              <Text style={styles.signOutText}>Sign out</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 24, gap: 13 },
  logo: { width: 76, height: 76, marginBottom: 4 },
  iconWrap: { width: 82, height: 82, borderRadius: 41, backgroundColor: '#FEF3C7', borderWidth: 1.5, borderColor: '#F59E0B', alignItems: 'center', justifyContent: 'center', ...SHADOW.glow },
  iconWrapOk: { backgroundColor: '#DCFCE7', borderColor: '#22C55E' },
  title: { fontSize: 23, fontWeight: '800', color: COLORS.text, textAlign: 'center' },
  sub: { fontSize: 14, color: COLORS.sub, textAlign: 'center', maxWidth: 440, lineHeight: 21 },
  notice: { maxWidth: 440, flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 14, borderRadius: RADIUS.md, backgroundColor: '#FEF3C7', borderWidth: 1, borderColor: '#F59E0B' },
  noticeText: { flex: 1, color: '#92400E', fontSize: 13, lineHeight: 19 },
  errorText: { color: '#DC2626', fontSize: 12.5, textAlign: 'center' },
  buttonWrap: { width: '100%', maxWidth: 420, borderRadius: RADIUS.md, overflow: 'hidden' },
  button: { minHeight: 52, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24, borderRadius: RADIUS.md, ...SHADOW.button },
  buttonText: { color: '#fff', fontSize: 15.5, fontWeight: '800' },
  secondaryButton: { minHeight: 46, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22, borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.blue },
  secondaryText: { color: COLORS.blue, fontSize: 14, fontWeight: '700' },
  supportButton: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8 },
  supportText: { color: COLORS.blue, fontSize: 13.5, fontWeight: '700' },
  signOutButton: { padding: 10 },
  signOutText: { color: COLORS.sub, fontSize: 13.5, fontWeight: '600' },
  successCard: { width: '100%', maxWidth: 440, flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 15, borderRadius: RADIUS.md, backgroundColor: '#DCFCE7', borderWidth: 1, borderColor: '#22C55E' },
  successTitle: { color: '#166534', fontSize: 14, fontWeight: '800' },
  successCopy: { color: '#166534', fontSize: 12.5, lineHeight: 18, marginTop: 3 },
  successTime: { color: '#15803D', fontSize: 11.5, marginTop: 6, fontWeight: '700' },
  safetyNote: { maxWidth: 430, color: COLORS.sub, fontSize: 11.5, lineHeight: 17, textAlign: 'center' },
});
