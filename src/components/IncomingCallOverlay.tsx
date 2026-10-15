// ─── Component: Incoming Call Overlay ────────────────────────────────────────
// Full-screen overlay for incoming calls with answer/reject buttons

import React, { useEffect, useRef, useState } from 'react';
import {
  View, StyleSheet, TouchableOpacity, Modal, Platform, Animated, Vibration,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import firestore from '@react-native-firebase/firestore';
import { AppText, AppIcon } from '../context/ThemeContext';
import { Avatar } from '.';
import { useRingtone } from '../hooks/useRingtone';
import { usePhoneBook } from '../hooks/usePhoneBook';
import { normalizePhone } from '../utils/phoneUtils';
import { db } from '../config/firebase';
import { COLORS, RADIUS, SHADOW } from '../types/theme';
import type { IncomingCallData } from '../types/call';

interface IncomingCallOverlayProps {
  visible: boolean;
  call: IncomingCallData | null;
  onAnswer: () => void;
  onReject: () => void;
}

export function IncomingCallOverlay({ visible, call, onAnswer, onReject }: IncomingCallOverlayProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const ringtone = useRingtone();
  const { resolveName } = usePhoneBook();

  // Resolve the caller against the RECEIVER's phone book. The call doc's
  // displayName is whatever the caller set (often their phone number); we want
  // the name the receiver saved them under. Look up the caller's authoritative
  // phone + profile photo from users/{callerId}, then resolve the phone.
  const [callerPhone, setCallerPhone] = useState<string | null>(null);
  const [callerPhoto, setCallerPhoto] = useState<string | null>(null);

  useEffect(() => {
    const callerId = call?.caller?.userId;
    if (!callerId) { setCallerPhone(null); setCallerPhoto(null); return; }
    let cancelled = false;
    const fsDb = db as ReturnType<typeof firestore>;
    fsDb.collection('users').doc(callerId).get()
      .then((snap) => {
        if (cancelled || !snap.exists()) return;
        const data = snap.data() ?? {};
        if (typeof data.phone === 'string') setCallerPhone(data.phone);
        if (typeof data.photoURL === 'string' && data.photoURL) setCallerPhoto(data.photoURL);
      })
      .catch((err) => console.warn('[IncomingCallOverlay] caller lookup failed:', err));
    return () => { cancelled = true; };
  }, [call?.caller?.userId]);

  // Pulse animation for avatar
  useEffect(() => {
    if (visible) {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.1,
            duration: 1000,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1000,
            useNativeDriver: true,
          }),
        ])
      );
      animation.start();
      return () => animation.stop();
    }
  }, [visible, pulseAnim]);

  // Play ringtone and vibrate when call comes in
  useEffect(() => {
    if (visible && call) {
      console.log('[IncomingCallOverlay] Starting ringtone and vibration...');
      
      // Start ringtone
      ringtone.play();
      
      // Start vibration pattern (0.5s on, 0.5s off, repeat)
      const vibrationPattern = [0, 500, 500]; // delay, vibrate, pause
      Vibration.vibrate(vibrationPattern, true); // true = repeat
      
      return () => {
        console.log('[IncomingCallOverlay] Stopping ringtone and vibration...');
        ringtone.stop();
        Vibration.cancel();
      };
    }
  }, [visible, call]);

  // Handle answer - stop ringtone and vibration
  const handleAnswer = () => {
    ringtone.stop();
    Vibration.cancel();
    onAnswer();
  };

  // Handle reject - stop ringtone and vibration
  const handleReject = () => {
    ringtone.stop();
    Vibration.cancel();
    onReject();
  };

  const getInitials = (name: string) => {
    const parts = (name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  };

  if (!visible || !call) return null;

  // The number to look up in the phone book: the caller's real phone when we
  // have it, otherwise the displayName if it looks like a phone number.
  const rawDisplay = call.caller.displayName || '';
  const looksLikePhone = /^\+?[0-9\s()-]{6,}$/.test(rawDisplay);
  const phoneToResolve = callerPhone ?? (looksLikePhone ? rawDisplay : null);
  // Saved contact name from the receiver's phone book, or a sensible fallback.
  const resolvedName = phoneToResolve
    ? resolveName(normalizePhone(phoneToResolve), rawDisplay || 'Unknown')
    : (rawDisplay || 'Unknown');
  const resolvedPhoto = callerPhoto ?? call.caller.photoUrl ?? null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        {Platform.OS === 'ios' ? (
          <BlurView intensity={90} style={StyleSheet.absoluteFill} />
        ) : (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(10, 22, 40, 0.95)' }]} />
        )}

        <LinearGradient
          colors={['rgba(10, 22, 40, 0.3)', 'rgba(13, 34, 68, 0.5)', 'rgba(26, 74, 138, 0.3)']}
          style={styles.content}
          start={{ x: 0.3, y: 0 }}
          end={{ x: 0.7, y: 1 }}
        >
          {/* Caller info */}
          <View style={styles.callerSection}>
            <Animated.View style={[styles.avatarContainer, { transform: [{ scale: pulseAnim }] }]}>
              <View style={styles.avatarRing}>
                <Avatar
                  initials={getInitials(resolvedName)}
                  color={COLORS.blue}
                  size={120}
                  imageUrl={resolvedPhoto}
                />
              </View>
            </Animated.View>

            <AppText fixedColor style={styles.callerName}>
              {resolvedName}
            </AppText>
            <AppText fixedColor style={styles.callStatus}>
              Incoming {call.type} call...
            </AppText>
          </View>

          {/* Action buttons */}
          <View style={styles.actionsRow}>
            {/* Reject button */}
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleReject}
              activeOpacity={0.8}
            >
              <View style={[styles.actionIcon, styles.rejectIcon]}>
                <AppIcon name="call" size={32} color="#fff" fixedColor />
              </View>
              <AppText fixedColor style={styles.actionLabel}>
                Decline
              </AppText>
            </TouchableOpacity>

            {/* Answer button */}
            <TouchableOpacity
              style={styles.actionButton}
              onPress={handleAnswer}
              activeOpacity={0.8}
            >
              <View style={[styles.actionIcon, styles.answerIcon]}>
                <AppIcon name="call" size={32} color="#fff" fixedColor />
              </View>
              <AppText fixedColor style={styles.actionLabel}>
                Accept
              </AppText>
            </TouchableOpacity>
          </View>
        </LinearGradient>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    justifyContent: 'space-between',
    paddingTop: 100,
    paddingBottom: Platform.OS === 'ios' ? 60 : 40,
    paddingHorizontal: 20,
  },

  callerSection: {
    alignItems: 'center',
    gap: 20,
  },
  avatarContainer: {
    marginBottom: 10,
  },
  avatarRing: {
    padding: 8,
    borderRadius: 80,
    borderWidth: 3,
    borderColor: 'rgba(255, 255, 255, 0.4)',
    ...SHADOW.glow,
  },
  callerName: {
    fontSize: 32,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
  },
  callStatus: {
    fontSize: 18,
    color: 'rgba(255, 255, 255, 0.75)',
    textAlign: 'center',
  },

  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  actionButton: {
    alignItems: 'center',
    gap: 12,
  },
  actionIcon: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },
  rejectIcon: {
    backgroundColor: '#e84343',
    transform: [{ rotate: '135deg' }],
  },
  answerIcon: {
    backgroundColor: '#34C759',
  },
  actionLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
});
