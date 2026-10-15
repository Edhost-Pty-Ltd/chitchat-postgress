// ─── Component: RTCView (Cross-Platform) ─────────────────────────────────────
// Platform-specific video view for WebRTC streams

import React, { useEffect, useRef } from 'react';
import { Platform, View, StyleSheet, ViewStyle } from 'react-native';

interface RTCViewProps {
  streamURL?: string;
  stream?: MediaStream; // Web uses MediaStream directly
  style?: ViewStyle;
  objectFit?: 'contain' | 'cover';
  mirror?: boolean;
  zOrder?: number;
}

// Web implementation
export function RTCViewWeb({ stream, style, objectFit = 'cover', mirror = false }: RTCViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.play().catch(err => {
        console.error('[RTCView-Web] Failed to play stream:', err);
      });
    }
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={mirror} // Mute local video to avoid feedback
      style={{
        width: '100%',
        height: '100%',
        objectFit: objectFit,
        transform: mirror ? 'scaleX(-1)' : undefined,
        ...(style as any),
      }}
    />
  );
}

// Native implementation — resolved lazily on first render.
// @livekit/react-native-webrtc builds `new NativeEventEmitter()` at module
// top level; requiring it during app startup (before the bridge is ready)
// throws and crashes the app. Defer the require until this view renders.
let _rtcResolved = false;
let RTCViewNative: any = null;
function getRTCViewNative(): any {
  if (_rtcResolved) return RTCViewNative;
  _rtcResolved = true;
  try {
    RTCViewNative = require('@livekit/react-native-webrtc').RTCView;
  } catch (err) {
    console.warn('[RTCView] Failed to load @livekit/react-native-webrtc:', err);
  }
  return RTCViewNative;
}

// Cross-platform component
export default function RTCView(props: RTCViewProps) {
  if (Platform.OS === 'web') {
    // Web: use native video element with MediaStream
    // Convert streamURL back to MediaStream if needed
    // For web, we'll pass the stream directly from parent
    return <RTCViewWeb {...props} />;
  }

  // Native: use react-native-webrtc RTCView (resolved on first render)
  const RTCViewNativeComp = getRTCViewNative();
  if (!RTCViewNativeComp) {
    console.error('[RTCView] RTCView not available on native platform');
    return <View style={[styles.fallback, props.style]} />;
  }

  return <RTCViewNativeComp {...props} />;
}

const styles = StyleSheet.create({
  fallback: {
    backgroundColor: '#000',
  },
});
