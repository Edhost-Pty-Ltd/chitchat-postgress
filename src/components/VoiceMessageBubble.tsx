// ─── VoiceMessageBubble ──────────────────────────────────────────────────────
// WhatsApp-style voice note bubble:
//   [PlayBtn]  [▁▃▅▇●▅▃▁▃▅]  0:15
//                                 21:28 ✓✓

import React, { useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, LayoutChangeEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS, SHADOW, RADIUS } from '../types/theme';
import type { PlaybackState } from '../hooks/useVoicePlayer';

// ─── Props ────────────────────────────────────────────────────────────────────

export interface VoiceMessageBubbleProps {
  messageId: string;
  voiceUrl: string;
  durationMs: number;
  isOutgoing: boolean;
  playerState: PlaybackState;
  onPlay: () => void;
  onPause: () => void;
  onSeek?: (positionMs: number) => void;
  timestamp?: Date | null;
  tickIcon?: {
    icon: 'checkmark' | 'checkmark-done';
    color: string;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashSeed(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** 40 bars — taller in the middle, shorter at the edges, with natural variation */
function generateBarHeights(messageId: string): number[] {
  const seed = hashSeed(messageId);
  const bars: number[] = [];
  const count = 40;
  for (let i = 0; i < count; i++) {
    const center = count / 2;
    const distFromCenter = Math.abs(i - center) / center; // 0 at center, 1 at edges
    const envelope = 1 - distFromCenter * 0.5; // 0.5–1.0 scale
    const noise = Math.abs(Math.sin(seed * (i + 1) * 0.37 + i)) * 0.7 + 0.3;
    const height = Math.round(envelope * noise * 22 + 3); // 3–25px range
    bars.push(height);
  }
  return bars;
}

function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTime(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VoiceMessageBubble({
  messageId,
  voiceUrl: _voiceUrl,
  durationMs,
  isOutgoing,
  playerState,
  onPlay,
  onPause,
  onSeek,
  timestamp,
  tickIcon,
}: VoiceMessageBubbleProps) {
  const isActive = playerState.activeMessageId === messageId;
  const status   = isActive ? playerState.status : 'idle';
  const posMs    = isActive ? playerState.positionMs : 0;

  const [waveWidth, setWaveWidth] = useState(0);

  const barHeights = React.useMemo(() => generateBarHeights(messageId), [messageId]);
  const BAR_COUNT  = barHeights.length;

  const effectiveDuration = isActive && playerState.durationMs > 0
    ? playerState.durationMs
    : durationMs;

  const progress   = (status === 'playing' || status === 'paused')
    ? Math.min(posMs / effectiveDuration, 1)
    : 0;
  const filledBars = Math.floor(progress * BAR_COUNT);

  const displayTime = (status === 'playing' || status === 'paused')
    ? formatMmSs(effectiveDuration - posMs)
    : formatMmSs(durationMs);

  // ── Colors ───────────────────────────────────────────────────────
  // isOutgoing = white/glass bubble  |  incoming = blue gradient bubble
  const playBtnBg      = isOutgoing ? COLORS.blue          : '#ffffff';
  const playIconColor  = isOutgoing ? '#ffffff'             : COLORS.blue;
  const barFilled      = isOutgoing ? COLORS.blue           : '#ffffff';
  const barEmpty       = isOutgoing ? 'rgba(0,0,0,0.18)'   : 'rgba(255,255,255,0.45)';
  const durationColor  = isOutgoing ? COLORS.sub            : 'rgba(255,255,255,0.85)';
  const dotColor       = isOutgoing ? COLORS.blue           : '#ffffff';
  const dotBorder      = isOutgoing ? 'rgba(255,255,255,1)' : 'rgba(30,100,200,0.4)';

  // ── Seek on tap ──────────────────────────────────────────────────
  const handleWaveformPress = (e: any) => {
    if (!onSeek || !isActive || waveWidth === 0) return;
    const x     = e.nativeEvent.locationX;
    const ratio = Math.max(0, Math.min(1, x / waveWidth));
    onSeek(Math.floor(ratio * effectiveDuration));
  };

  // ── Error state ──────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <BubbleWrapper isOutgoing={isOutgoing}>
        <View style={styles.row}>
          <TouchableOpacity
            style={[styles.playBtn, { backgroundColor: playBtnBg }]}
            onPress={onPlay}
          >
            <Ionicons name="refresh" size={20} color={playIconColor} />
          </TouchableOpacity>
          <Text style={[styles.duration, { color: durationColor }]}>Failed</Text>
        </View>
      </BubbleWrapper>
    );
  }

  // ── Playhead dot left offset ─────────────────────────────────────
  const dotLeft = waveWidth > 0 ? progress * waveWidth - 5 : -999;

  return (
    <BubbleWrapper isOutgoing={isOutgoing}>
      {/* ── Main row: play btn │ waveform only ── */}
      <View style={styles.row}>

        {/* Play / Pause / Loading */}
        {status === 'loading' ? (
          <View style={[styles.playBtn, { backgroundColor: playBtnBg }]}>
            <ActivityIndicator size="small" color={playIconColor} />
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.playBtn, { backgroundColor: playBtnBg }]}
            onPress={status === 'playing' ? onPause : onPlay}
            activeOpacity={0.75}
          >
            <Ionicons
              name={status === 'playing' ? 'pause' : 'play'}
              size={20}
              color={playIconColor}
              style={status !== 'playing' ? { marginLeft: 2 } : undefined}
            />
          </TouchableOpacity>
        )}

        {/* Waveform + playhead dot — no duration inside here */}
        <TouchableOpacity
          activeOpacity={0.9}
          style={styles.waveformWrap}
          onPress={handleWaveformPress}
          onLayout={(e: LayoutChangeEvent) => setWaveWidth(e.nativeEvent.layout.width)}
          disabled={!isActive}
        >
          {barHeights.map((h, i) => (
            <View
              key={i}
              style={[
                styles.bar,
                {
                  height: h,
                  backgroundColor: i < filledBars ? barFilled : barEmpty,
                },
              ]}
            />
          ))}

          {/* Playhead dot — absolutely positioned within waveform */}
          {isActive && (status === 'playing' || status === 'paused') && waveWidth > 0 && (
            <View
              pointerEvents="none"
              style={[
                styles.playhead,
                {
                  left: Math.min(dotLeft, waveWidth - 12),
                  backgroundColor: dotColor,
                  borderColor: dotBorder,
                },
              ]}
            />
          )}
        </TouchableOpacity>
      </View>

      {/* ── Bottom row: duration left │ timestamp + ticks right ── */}
      <View style={styles.metaRow}>
        <Text style={[styles.duration, { color: durationColor }]}>
          {displayTime}
        </Text>

        {timestamp && (
          <View style={styles.timeRow}>
            <Text style={[styles.time, { color: durationColor }]}>
              {formatTime(timestamp)}
            </Text>
            {isOutgoing && tickIcon && (
              <Ionicons name={tickIcon.icon} size={13} color={tickIcon.color} />
            )}
          </View>
        )}
      </View>
    </BubbleWrapper>
  );
}

// ─── Bubble wrapper ───────────────────────────────────────────────────────────

function BubbleWrapper({
  isOutgoing,
  children,
}: {
  isOutgoing: boolean;
  children: React.ReactNode;
}) {
  if (isOutgoing) {
    return (
      <View style={[styles.bubble, styles.bubbleOut]}>
        {children}
      </View>
    );
  }
  return (
    <LinearGradient
      colors={GRADIENTS.chatSent}
      style={[styles.bubble, styles.bubbleIn]}
    >
      {children}
    </LinearGradient>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bubble: {
    minWidth: '62%',
    maxWidth: '80%',
    borderRadius: RADIUS.lg,
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 6,
    ...SHADOW.card,
  },
  bubbleOut: {
    backgroundColor: 'rgba(255,255,255,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.50)',
    borderBottomRightRadius: 4,
  },
  bubbleIn: {
    borderBottomLeftRadius: 4,
  },

  // ── Main row ─────────────────────────────────────────────────────
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  // ── Play button ──────────────────────────────────────────────────
  playBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    ...SHADOW.button,
  },

  // ── Waveform ─────────────────────────────────────────────────────
  waveformWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    height: 34,
    gap: 2,
    position: 'relative',
    overflow: 'hidden',
  },
  bar: {
    flex: 1,
    borderRadius: 2,
    minWidth: 2,
  },

  // ── Playhead dot ─────────────────────────────────────────────────
  playhead: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    top: '50%',
    marginTop: -6,
    zIndex: 10,
  },

  // ── Meta row: duration left, timestamp+ticks right ────────────────
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
    paddingLeft: 50,    // aligns under the waveform (play btn 42 + gap 8)
  },
  duration: {
    fontSize: 12,
    fontWeight: '500',
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  time: {
    fontSize: 10,
    fontWeight: '400',
  },
});
