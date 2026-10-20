// ─── Component: Floating Call Overlay ────────────────────────────────────────
// Minimized floating call that appears when user presses back during a call
// User can tap to maximize back to full screen

import React, { useRef } from 'react';
import {
  View, TouchableOpacity, StyleSheet, Animated, Dimensions,
  PanResponder, Platform,
} from 'react-native';
import { AppText, AppIcon } from '../context/ThemeContext';
import { Avatar } from './index';
import { COLORS, RADIUS, SHADOW } from '../types/theme';

const WINDOW_WIDTH = Dimensions.get('window').width;
const WINDOW_HEIGHT = Dimensions.get('window').height;
const OVERLAY_WIDTH = 120;
const OVERLAY_HEIGHT = 180;
const EDGE_PADDING = 16;

// Try to load RTCView for native video rendering
let RTCView: any = null;
try {
  const rtc = require('@livekit/react-native-webrtc');
  RTCView = rtc.RTCView;
} catch {
  RTCView = null;
}

// Video tile component for rendering streams
const VideoTile = React.memo(({ stream, mirror }: { stream: any; mirror?: boolean }) => {
  if (!stream) return null;

  if (Platform.OS === 'web') {
    return React.createElement('video', {
      key: stream.id, // Force remount when stream changes
      ref: (el: HTMLVideoElement | null) => {
        if (el && el.srcObject !== stream) {
          el.srcObject = stream;
          // Force play after setting srcObject
          el.play().catch(err => console.log('[FloatingCall] Play failed:', err));
        }
      },
      autoPlay: true,
      playsInline: true,
      muted: true,
      style: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        transform: mirror ? 'scaleX(-1)' : undefined,
      },
    });
  }

  if (RTCView) {
    return (
      <RTCView
        key={stream.id} // Force remount when stream changes
        streamURL={stream.toURL()}
        style={StyleSheet.absoluteFill}
        objectFit="cover"
        mirror={!!mirror}
      />
    );
  }

  return null;
});

interface FloatingCallOverlayProps {
  displayName: string;
  avatar: string;
  color: string;
  duration: string;
  isVideo: boolean;
  localStream?: any; // MediaStream for local video
  remoteStream?: any; // MediaStream for remote video
  localIsMain?: boolean; // Whether local camera is in main view
  onMaximize: () => void;
  onEndCall: () => void;
}

export function FloatingCallOverlay({
  displayName,
  avatar,
  color,
  duration,
  isVideo,
  localStream,
  remoteStream,
  localIsMain = false,
  onMaximize,
  onEndCall,
}: FloatingCallOverlayProps) {
  // Position animation values
  const position = useRef(
    new Animated.ValueXY({
      x: WINDOW_WIDTH - OVERLAY_WIDTH - EDGE_PADDING,
      y: WINDOW_HEIGHT / 3,
    })
  ).current;

  const scale = useRef(new Animated.Value(1)).current;
  
  // Track offset for pan gestures
  const offset = useRef({ x: WINDOW_WIDTH - OVERLAY_WIDTH - EDGE_PADDING, y: WINDOW_HEIGHT / 3 });

  // Pan responder for dragging
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      
      onPanResponderGrant: () => {
        // Set offset to current position
        position.setOffset({
          x: offset.current.x,
          y: offset.current.y,
        });
        position.setValue({ x: 0, y: 0 });
        
        // Slightly scale down on touch
        Animated.spring(scale, {
          toValue: 0.95,
          useNativeDriver: false,
        }).start();
      },
      
      onPanResponderMove: Animated.event(
        [
          null,
          { dx: position.x, dy: position.y },
        ],
        { useNativeDriver: false }
      ),
      
      onPanResponderRelease: (_, gesture) => {
        // Flatten offset
        position.flattenOffset();
        
        // Scale back to normal
        Animated.spring(scale, {
          toValue: 1,
          useNativeDriver: false,
        }).start();

        // Check if it was a tap (minimal movement)
        const isTap = Math.abs(gesture.dx) < 10 && Math.abs(gesture.dy) < 10;
        
        if (isTap) {
          // Tap to maximize
          onMaximize();
          return;
        }

        // Calculate final position (offset + gesture)
        const finalX = offset.current.x + gesture.dx;
        const finalY = offset.current.y + gesture.dy;

        // Constrain to screen bounds
        const maxX = WINDOW_WIDTH - OVERLAY_WIDTH - EDGE_PADDING;
        const maxY = WINDOW_HEIGHT - OVERLAY_HEIGHT - EDGE_PADDING;
        const minX = EDGE_PADDING;
        const minY = Platform.OS === 'ios' ? 60 : 40; // Account for status bar

        // Determine if closer to left or right edge
        const snapToRight = finalX > WINDOW_WIDTH / 2;
        const targetX = snapToRight ? maxX : minX;
        const constrainedY = Math.max(minY, Math.min(maxY, finalY));

        // Update offset for next drag
        offset.current = { x: targetX, y: constrainedY };

        // Animate to snap position
        Animated.spring(position, {
          toValue: { x: targetX, y: constrainedY },
          useNativeDriver: false,
          tension: 50,
          friction: 8,
        }).start();
      },
    })
  ).current;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          transform: [
            { translateX: position.x },
            { translateY: position.y },
            { scale },
          ],
        },
      ]}
      {...panResponder.panHandlers}
    >
      <View style={styles.overlay}>
        {/* Video streams or avatar */}
        {isVideo && (remoteStream || localStream) ? (
          <>
            {/* Main video - show local if localIsMain, otherwise remote */}
            {localIsMain ? (
              localStream ? (
                <View style={styles.remoteVideoContainer}>
                  <VideoTile stream={localStream} mirror />
                </View>
              ) : (
                <View style={styles.avatarContainer}>
                  <Avatar initials="ME" color={COLORS.blue} size={50} />
                </View>
              )
            ) : (
              remoteStream ? (
                <View style={styles.remoteVideoContainer}>
                  <VideoTile stream={remoteStream} />
                </View>
              ) : (
                <View style={styles.avatarContainer}>
                  <Avatar initials={avatar} color={color} size={50} />
                </View>
              )
            )}

            {/* PiP video - show remote if localIsMain, otherwise local */}
            {localIsMain ? (
              remoteStream && (
                <View style={styles.localVideoPip}>
                  <VideoTile stream={remoteStream} />
                  <AppText fixedColor style={styles.pipLabel}>{displayName}</AppText>
                </View>
              )
            ) : (
              localStream && (
                <View style={styles.localVideoPip}>
                  <VideoTile stream={localStream} mirror />
                  <AppText fixedColor style={styles.pipLabel}>You</AppText>
                </View>
              )
            )}
          </>
        ) : (
          /* Audio call - show avatar */
          <View style={styles.avatarContainer}>
            <Avatar initials={avatar} color={color} size={50} />
          </View>
        )}

        {/* Call type indicator */}
        <View style={[styles.callTypeBadge, { backgroundColor: isVideo ? '#10b981' : '#3b82f6' }]}>
          <AppIcon 
            name={isVideo ? 'videocam' : 'call'} 
            size={12} 
            color="#fff" 
            fixedColor 
          />
        </View>

        {/* End call button */}
        <TouchableOpacity
          style={styles.endButton}
          onPress={(e) => {
            e.stopPropagation();
            onEndCall();
          }}
          activeOpacity={0.8}
        >
          <AppIcon name="call" size={14} color="#fff" fixedColor />
        </TouchableOpacity>
      </View>

      {/* Drag indicator */}
      <View style={styles.dragIndicator}>
        <View style={styles.dragHandle} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    zIndex: 9999,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(10, 26, 48, 0.95)',
    borderRadius: RADIUS.lg,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.25)',
    overflow: 'hidden',
    ...SHADOW.glow,
  },
  remoteVideoContainer: {
    flex: 1,
    backgroundColor: '#0a1a30',
  },
  localVideoPip: {
    position: 'absolute',
    bottom: 36, // Leave space for end button
    right: 4,
    width: 35,
    height: 50,
    borderRadius: RADIUS.sm,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.4)',
    backgroundColor: '#000',
  },
  pipLabel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    fontSize: 8,
    color: '#fff',
    textAlign: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingVertical: 1,
  },
  avatarContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  callTypeBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(255, 255, 255, 0.3)',
    ...SHADOW.card,
  },
  endButton: {
    position: 'absolute',
    bottom: 6,
    left: 0,
    right: 0,
    alignSelf: 'center',
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#e84343',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '135deg' }],
    ...SHADOW.button,
  },
  dragIndicator: {
    position: 'absolute',
    top: 4,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  dragHandle: {
    width: 30,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
  },
});
