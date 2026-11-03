// ─── VoiceRecordingOverlay ────────────────────────────────────────────────────
// Live overlay during recording: pulsing dot, live waveform, MM:SS timer,
// thin progress bar (0–120s). Warning state ≥110s, "max reached" at 120s.

import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS } from '../types/theme';

const MAX_DURATION_MS = 120_000;

export interface VoiceRecordingOverlayProps {
  durationMs: number;
  isWarning: boolean;
  amplitudeHistory?: number[];
  onCancel?: () => void;
}

function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceRecordingOverlay({
  durationMs,
  isWarning,
  amplitudeHistory = [],
  onCancel: _onCancel,
}: VoiceRecordingOverlayProps) {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const chevronAnim = useRef(new Animated.Value(0)).current;

  const isMaxReached = durationMs >= MAX_DURATION_MS;
  const progress = Math.min(1, durationMs / MAX_DURATION_MS);

  useEffect(() => {
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 0.25, duration: 600,
          easing: Easing.inOut(Easing.ease), useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1, duration: 600,
          easing: Easing.inOut(Easing.ease), useNativeDriver: true,
        }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [pulseAnim]);

  useEffect(() => {
    const slide = Animated.loop(
      Animated.sequence([
        Animated.timing(chevronAnim, {
          toValue: -8, duration: 800,
          easing: Easing.inOut(Easing.ease), useNativeDriver: true,
        }),
        Animated.timing(chevronAnim, {
          toValue: 0, duration: 800,
          easing: Easing.inOut(Easing.ease), useNativeDriver: true,
        }),
      ]),
    );
    slide.start();
    return () => slide.stop();
  }, [chevronAnim]);

  const backgroundColor = isWarning
    ? 'rgba(245,158,11,0.18)'
    : 'rgba(160,215,240,0.35)';
  const dotColor = isWarning ? COLORS.amber : COLORS.missed;
  const textColor = isWarning ? COLORS.amber : COLORS.white;
  const hintColor = isWarning ? COLORS.amber : 'rgba(255,255,255,0.70)';

  return (
    <View style={[styles.overlay, { backgroundColor }]}>
      {isMaxReached ? (
        <View style={styles.maxReachedContainer}>
          <Ionicons name="time-outline" size={16} color={textColor} />
          <Text style={[styles.maxReachedText, { color: textColor }]}>
            Maximum duration reached
          </Text>
        </View>
      ) : (
        <View style={styles.contentRow}>
          {/* Left: dot + timer */}
          <View style={styles.leftSection}>
            <Animated.View
              style={[styles.dot, { backgroundColor: dotColor, opacity: pulseAnim }]}
            />
            <Text style={[styles.timer, { color: textColor }]}>
              {formatMmSs(durationMs)}
            </Text>
          </View>

          {/* Center: live waveform */}
          <View style={styles.waveform}>
            {amplitudeHistory.slice(-24).map((amp, i) => (
              <View
                key={i}
                style={[
                  styles.waveBar,
                  {
                    height: 4 + Math.max(0, Math.min(1, amp)) * 18,
                    backgroundColor: dotColor,
                    opacity: 0.35 + amp * 0.65,
                  },
                ]}
              />
            ))}
          </View>

          {/* Right: slide to cancel */}
          <View style={styles.rightSection}>
            <Animated.View style={{ transform: [{ translateX: chevronAnim }] }}>
              <Ionicons name="chevron-back" size={16} color={hintColor} />
            </Animated.View>
            <Text style={[styles.hintText, { color: hintColor }]}>
              Slide to cancel
            </Text>
          </View>
        </View>
      )}

      {/* Thin progress bar (always visible except at max) */}
      {!isMaxReached && (
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              {
                width: `${progress * 100}%`,
                backgroundColor: isWarning ? COLORS.amber : COLORS.missed,
              },
            ]}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    height: 52,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 2,
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: {
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  waveform: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flex: 1,
    marginHorizontal: 12,
    height: 24,
    overflow: 'hidden',
  },
  waveBar: {
    width: 3,
    borderRadius: 1.5,
  },
  rightSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  hintText: { fontSize: 13, fontWeight: '500' },
  maxReachedContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  maxReachedText: { fontSize: 14, fontWeight: '600' },
  progressTrack: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    height: 2,
    backgroundColor: 'rgba(0,0,0,0.10)',
  },
  progressFill: { height: 2 },
});