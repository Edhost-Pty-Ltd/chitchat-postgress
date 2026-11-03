import React from 'react';
import { ActivityIndicator, StyleSheet, TouchableOpacity, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { AppIcon, AppText } from '../context/ThemeContext';

export type MediaUploadStatus = 'pending' | 'preparing' | 'uploading' | 'sending' | 'failed';

interface Props {
  status: MediaUploadStatus;
  progress?: number;
  bytesSent?: number;
  totalBytes?: number;
  onRetry?: () => void;
}

const SIZE = 70;
const STROKE = 4;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function remainingLabel(bytesSent: number, totalBytes: number): string {
  const remaining = Math.max(0, totalBytes - bytesSent);
  if (!totalBytes) return '';
  if (remaining >= 1024 * 1024) return `${(remaining / (1024 * 1024)).toFixed(1)} MB left`;
  if (remaining >= 1024) return `${Math.ceil(remaining / 1024)} KB left`;
  return remaining > 0 ? `${remaining} B left` : 'Finishing';
}

/**
 * Small centered upload ring shown over an optimistic image/video bubble.
 * The completed arc is uploaded bytes; the track behind it is the remainder.
 */
export function MediaUploadOverlay({
  status,
  progress = 0,
  bytesSent = 0,
  totalBytes = 0,
  onRetry,
}: Props) {
  const percentage = Math.max(0, Math.min(100, Math.round(progress)));
  const dashOffset = CIRCUMFERENCE * (1 - percentage / 100);
  const isFailed = status === 'failed';
  const isPreparing = status === 'preparing';
  const label = isPreparing
    ? 'Preparing'
    : status === 'sending'
      ? 'Sending'
      : remainingLabel(bytesSent, totalBytes);

  const content = (
    <View style={styles.backdrop}>
      <View style={styles.ringWrap}>
        <Svg width={SIZE} height={SIZE} style={styles.ring}>
          <Circle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={RADIUS}
            stroke="rgba(255,255,255,0.30)"
            strokeWidth={STROKE}
            fill="rgba(8,18,28,0.72)"
          />
          {!isFailed && (
            <Circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              stroke="#ffffff"
              strokeWidth={STROKE}
              strokeLinecap="round"
              fill="transparent"
              strokeDasharray={`${CIRCUMFERENCE} ${CIRCUMFERENCE}`}
              strokeDashoffset={dashOffset}
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            />
          )}
        </Svg>

        <View style={styles.centerContent}>
          {isFailed ? (
            <>
              <AppIcon name="refresh" size={20} color="#fff" fixedColor />
              <AppText fixedColor style={styles.retryText}>Retry</AppText>
            </>
          ) : isPreparing ? (
            <>
              <ActivityIndicator size="small" color="#fff" />
              <AppText fixedColor style={styles.subText}>{label}</AppText>
            </>
          ) : (
            <>
              <AppText fixedColor style={styles.percent}>{percentage}%</AppText>
              {!!label && <AppText fixedColor style={styles.subText} numberOfLines={1}>{label}</AppText>}
            </>
          )}
        </View>
      </View>
    </View>
  );

  if (isFailed && onRetry) {
    return (
      <TouchableOpacity
        style={StyleSheet.absoluteFill}
        activeOpacity={0.85}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel="Retry media upload"
      >
        {content}
      </TouchableOpacity>
    );
  }

  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>{content}</View>;
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.18)',
    borderRadius: 12,
  },
  ringWrap: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ring: { position: 'absolute' },
  centerContent: {
    width: SIZE - 12,
    height: SIZE - 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  percent: { color: '#fff', fontSize: 15, fontWeight: '800', lineHeight: 18 },
  subText: { color: 'rgba(255,255,255,0.88)', fontSize: 7.5, fontWeight: '600', marginTop: 1 },
  retryText: { color: '#fff', fontSize: 9, fontWeight: '700', marginTop: 1 },
});
