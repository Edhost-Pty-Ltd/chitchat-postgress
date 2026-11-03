// ─── VoiceNotePlayer ─────────────────────────────────────────────────────────
// Chat bubble voice-note player. Play/pause, progress bar, time, speed toggle.
// Tap the speed chip to cycle 1x → 1.5x → 2x → 1x.

import React from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS } from '../types/theme';
import { useVoicePlayer, PLAYBACK_RATES } from '../hooks/useVoicePlayer';

export interface VoiceNotePlayerProps {
  voiceUrl: string;
  messageId: string;
  durationMs: number;
  isOwnMessage?: boolean;
  accentColor?: string;
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VoiceNotePlayer({
  voiceUrl,
  messageId,
  durationMs,
  isOwnMessage = false,
  accentColor,
}: VoiceNotePlayerProps) {
  const { state, play, pause, resume, setPlaybackRate } = useVoicePlayer();

  const isActive  = state.activeMessageId === messageId;
  const isPlaying = isActive && state.status === 'playing';
  const isLoading = isActive && state.status === 'loading';
  const isPaused  = isActive && state.status === 'paused';
  const isError   = isActive && state.status === 'error';

  const effectiveDuration =
    isActive && state.durationMs > 0 ? state.durationMs : durationMs;
  const progress =
    isActive && effectiveDuration > 0
      ? Math.min(1, state.positionMs / effectiveDuration)
      : 0;

  const tint        = accentColor ?? (isOwnMessage ? '#fff' : COLORS.blue);
  const trackColor  = isOwnMessage ? 'rgba(255,255,255,0.30)' : 'rgba(30,156,240,0.20)';

  const handleToggle = async () => {
    if (isLoading) return;
    if (isPlaying) { await pause(); return; }
    if (isPaused)  { await resume(); return; }
    await play(voiceUrl, messageId, durationMs);
  };

  const cycleSpeed = () => {
    const idx = PLAYBACK_RATES.indexOf(state.playbackRate);
    const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(next);
  };

  return (
    <View style={styles.container}>
      {/* Play / pause */}
      <TouchableOpacity
        style={[styles.playBtn, { borderColor: tint }]}
        onPress={handleToggle}
        activeOpacity={0.7}
        disabled={isLoading}
      >
        {isLoading ? (
          <ActivityIndicator size="small" color={tint} />
        ) : (
          <Ionicons
            name={isPlaying ? 'pause' : 'play'}
            size={20}
            color={tint}
            style={isPlaying ? undefined : { marginLeft: 2 }}
          />
        )}
      </TouchableOpacity>

      {/* Progress + time */}
      <View style={styles.meta}>
        <View style={[styles.progressTrack, { backgroundColor: trackColor }]}>
          <View
            style={[
              styles.progressFill,
              { width: `${progress * 100}%`, backgroundColor: tint },
            ]}
          />
        </View>
        <View style={styles.timeRow}>
          <Text style={[styles.time, { color: tint }]}>
            {formatMs(isActive ? state.positionMs : effectiveDuration)}
          </Text>
          <Text style={[styles.time, { color: tint, opacity: 0.6 }]}>
            / {formatMs(effectiveDuration)}
          </Text>
          {isError && (
            <Text
              style={[styles.errorText, { color: COLORS.missed }]}
              numberOfLines={1}
            >
              · {state.error ?? 'Error'}
            </Text>
          )}
        </View>
      </View>

      {/* Speed chip — tap to cycle 1x → 1.5x → 2x → 1x */}
      <TouchableOpacity
        style={[styles.speedBtn, { borderColor: tint }]}
        onPress={cycleSpeed}
        activeOpacity={0.7}
        accessibilityLabel={`Playback speed ${state.playbackRate}x`}
      >
        <Text style={[styles.speedText, { color: tint }]}>
          {state.playbackRate}x
        </Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 4,
    minWidth: 210,
    maxWidth: 280,
  },
  playBtn: {
    width: 38, height: 38, borderRadius: 19,
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  meta: { flex: 1, gap: 4 },
  progressTrack: { height: 3, borderRadius: 1.5, overflow: 'hidden' },
  progressFill: { height: 3 },
  timeRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  time: {
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  errorText: { fontSize: 10, marginLeft: 4, flex: 1 },
  speedBtn: {
    minWidth: 42, height: 26,
    paddingHorizontal: 8,
    borderRadius: 13,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  speedText: { fontSize: 11, fontWeight: '800' },
});