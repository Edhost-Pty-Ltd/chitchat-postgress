import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import {
  FACE_MESH_CONTOUR_PATH,
  FACE_MESH_DOT_PATH,
  FACE_MESH_EDGE_PATH,
  FACE_MESH_IRIS_PATH,
  FACE_MESH_SILHOUETTE_PATH,
  FACE_MESH_VIEWBOX,
} from '../data/faceMeshTemplate';

interface Props {
  /** Optional SDK capture shown behind the decorative mesh. */
  imageBase64?: string | null;
  active?: boolean;
  success?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * Presentation-only 468-point face-mesh animation.
 *
 * FaceAISDK owns the real camera, anti-spoofing and liveness decision and does
 * not expose landmark coordinates. This overlay is therefore a fixed visual
 * guide, deliberately kept separate from the SDK verdict. It never gates
 * registration and never claims that its points track the person's face.
 */
export default function FaceMeshScan({
  imageBase64,
  active = true,
  success = false,
  style,
}: Props) {
  const pulse = useRef(new Animated.Value(0)).current;
  const scan = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) {
      pulse.stopAnimation();
      scan.stopAnimation();
      return;
    }
    const animation = Animated.parallel([
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, {
            toValue: 1,
            duration: 1150,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(pulse, {
            toValue: 0,
            duration: 1150,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      ),
      Animated.loop(
        Animated.sequence([
          Animated.timing(scan, {
            toValue: 1,
            duration: 1850,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(scan, {
            toValue: 0,
            duration: 1850,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
      ),
    ]);
    animation.start();
    return () => animation.stop();
  }, [active, pulse, scan]);

  const imageUri = useMemo(() => {
    if (!imageBase64) return null;
    return imageBase64.startsWith('data:')
      ? imageBase64
      : `data:image/jpeg;base64,${imageBase64}`;
  }, [imageBase64]);

  const color = success ? '#34D399' : '#38BDF8';
  const bright = success ? '#A7F3D0' : '#E0F2FE';
  const pulseStyle = {
    opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.76, 1] }),
    transform: [
      { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1.015] }) },
    ],
  };
  const scanStyle = {
    opacity: active ? 0.9 : 0,
    transform: [
      { translateY: scan.interpolate({ inputRange: [0, 1], outputRange: [18, 316] }) },
    ],
  };

  return (
    <View style={[styles.root, success && styles.rootSuccess, style]}>
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={styles.photo} resizeMode="cover" />
      ) : (
        <View style={styles.emptyBackdrop} />
      )}
      <View style={styles.scrim} />

      <Animated.View style={[StyleSheet.absoluteFill, pulseStyle]}>
        <Svg viewBox={FACE_MESH_VIEWBOX} width="100%" height="100%">
          <Defs>
            <LinearGradient id="meshShade" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity="0.03" />
              <Stop offset="0.5" stopColor={color} stopOpacity="0.12" />
              <Stop offset="1" stopColor={color} stopOpacity="0.04" />
            </LinearGradient>
          </Defs>
          {!imageUri ? (
            <Path d={FACE_MESH_SILHOUETTE_PATH} fill="url(#meshShade)" />
          ) : null}
          <Path
            d={FACE_MESH_EDGE_PATH}
            fill="none"
            stroke={color}
            strokeOpacity={imageUri ? 0.72 : 0.55}
            strokeWidth={0.28}
          />
          <Path
            d={FACE_MESH_CONTOUR_PATH}
            fill="none"
            stroke={bright}
            strokeOpacity={0.96}
            strokeWidth={0.6}
            strokeLinejoin="round"
          />
          <Path
            d={FACE_MESH_IRIS_PATH}
            fill="none"
            stroke={bright}
            strokeWidth={0.5}
          />
          <Path
            d={FACE_MESH_DOT_PATH}
            fill="none"
            stroke={bright}
            strokeOpacity={0.98}
            strokeWidth={0.9}
            strokeLinecap="round"
          />
        </Svg>
      </Animated.View>

      <Animated.View pointerEvents="none" style={[styles.scanLine, { backgroundColor: color }, scanStyle]} />
      <View pointerEvents="none" style={[styles.corner, styles.topLeft, { borderColor: bright }]} />
      <View pointerEvents="none" style={[styles.corner, styles.topRight, { borderColor: bright }]} />
      <View pointerEvents="none" style={[styles.corner, styles.bottomLeft, { borderColor: bright }]} />
      <View pointerEvents="none" style={[styles.corner, styles.bottomRight, { borderColor: bright }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: 270,
    height: 350,
    borderRadius: 36,
    overflow: 'hidden',
    backgroundColor: '#050B16',
    borderWidth: 1,
    borderColor: 'rgba(56,189,248,0.42)',
    shadowColor: '#38BDF8',
    shadowOpacity: 0.28,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },
  rootSuccess: {
    borderColor: 'rgba(52,211,153,0.65)',
    shadowColor: '#34D399',
  },
  photo: { ...(StyleSheet.absoluteFill as object), opacity: 0.58 },
  emptyBackdrop: { ...(StyleSheet.absoluteFill as object), backgroundColor: '#071827' },
  scrim: { ...(StyleSheet.absoluteFill as object), backgroundColor: 'rgba(2,8,23,0.22)' },
  scanLine: {
    position: 'absolute',
    left: 14,
    right: 14,
    top: 0,
    height: 1.5,
    borderRadius: 1,
    shadowColor: '#7DD3FC',
    shadowOpacity: 1,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 0 },
  },
  corner: {
    position: 'absolute',
    width: 25,
    height: 25,
  },
  topLeft: { left: 12, top: 12, borderLeftWidth: 2, borderTopWidth: 2, borderTopLeftRadius: 9 },
  topRight: { right: 12, top: 12, borderRightWidth: 2, borderTopWidth: 2, borderTopRightRadius: 9 },
  bottomLeft: { left: 12, bottom: 12, borderLeftWidth: 2, borderBottomWidth: 2, borderBottomLeftRadius: 9 },
  bottomRight: { right: 12, bottom: 12, borderRightWidth: 2, borderBottomWidth: 2, borderBottomRightRadius: 9 },
});
