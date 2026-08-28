// ─── Screen: Splash ──────────────────────────────────────────────────────────
import React, { useEffect, useRef } from 'react';
import {
  View, StyleSheet, Animated, Dimensions, Image,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';

const { width } = Dimensions.get('window');
type NavProp = NativeStackNavigationProp<RootStackParamList, 'Splash'>;

// ─── Timings ─────────────────────────────────────────────────────────────────
const LOGO_IN          = 700;
const POP_DELAY        = 600;
const HOLD_DURATION    = 2600;
const COLOUR_START     = 400;
const COLOUR_DURATION  = 4200;
const FADEOUT_DURATION = 600;

// ─── Sizes ────────────────────────────────────────────────────────────────────
// Container is what the user sees
const CONTAINER  = Math.min(width * 0.54, 230);
// Image is oversized so the logo's own dark outer border is clipped away
const ZOOM       = 1.22;
const IMG_SIZE   = CONTAINER * ZOOM;
const OFFSET     = -(IMG_SIZE - CONTAINER) / 2;  // centre the oversized image

export default function SplashScreen() {
  const navigation = useNavigation<NavProp>();

  const logoScale   = useRef(new Animated.Value(0.5)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const glowOpacity = useRef(new Animated.Value(0)).current;
  const dotsOpacity = useRef(new Animated.Value(0)).current;
  const screenOp    = useRef(new Animated.Value(1)).current;

  // Starting blue matches the screenshot exactly (#87CEEB sky)
  // then transitions to the sign-in screen's GRADIENTS.bg colours
  const bgAnim  = useRef(new Animated.Value(0)).current;
  const bgColor = bgAnim.interpolate({
    inputRange:  [0,        0.45,      0.80,      1       ],
    outputRange: ['#87CEEB','#9DD8F5', '#C5E8F7', '#E8F6FF'],
  });

  useEffect(() => {
    // 1. Logo fades + scales in
    Animated.parallel([
      Animated.timing(logoOpacity, { toValue: 1, duration: LOGO_IN, useNativeDriver: true }),
      Animated.timing(logoScale,   { toValue: 1, duration: LOGO_IN, useNativeDriver: true }),
      Animated.timing(glowOpacity, { toValue: 1, duration: LOGO_IN + 250, useNativeDriver: true }),
      Animated.timing(dotsOpacity, { toValue: 1, duration: 350, delay: 450, useNativeDriver: true }),
    ]).start();

    // 2. Pop — overshoot then settle
    setTimeout(() => {
      Animated.sequence([
        Animated.spring(logoScale, { toValue: 1.14, friction: 4, tension: 90, useNativeDriver: true }),
        Animated.spring(logoScale, { toValue: 1,    friction: 6, tension: 55, useNativeDriver: true }),
      ]).start();
    }, POP_DELAY);

    // 3. Background transitions to sign-in sky; glow fades away with it
    setTimeout(() => {
      Animated.parallel([
        Animated.timing(bgAnim, {
          toValue: 1, duration: COLOUR_DURATION, useNativeDriver: false,
        }),
        Animated.timing(glowOpacity, {
          toValue: 0,
          duration: COLOUR_DURATION * 0.5,
          delay:    COLOUR_DURATION * 0.35,
          useNativeDriver: true,
        }),
      ]).start();
    }, COLOUR_START);

    // 4. Fade out → SignIn
    setTimeout(() => {
      Animated.timing(screenOp, {
        toValue: 0, duration: FADEOUT_DURATION, useNativeDriver: true,
      }).start(() => navigation.replace('CreateAccount'));
    }, LOGO_IN + HOLD_DURATION);
  }, []);

  return (
    <Animated.View style={[styles.root, { opacity: screenOp }]}>
      {/* Animated background — sky blue → pale sign-in sky */}
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: bgColor }]} />

      {/* Logo */}
      <Animated.View style={[
        styles.logoWrap,
        { opacity: logoOpacity, transform: [{ scale: logoScale }] },
      ]}>
        {/* Glow bloom — pure shadow, no fill */}
        <Animated.View style={[styles.glowNode, { opacity: glowOpacity }]} />

        <Image
          source={require('../../assets/chitchat-logo.png')}
          style={styles.logoImg}
          resizeMode="contain"
        />
      </Animated.View>

      {/* Loading dots */}
      <Animated.View style={[styles.dotsRow, { opacity: dotsOpacity }]}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={styles.dot} />
        ))}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  logoWrap: { alignItems: 'center', justifyContent: 'center' },

  // Pure shadow — no visible fill, creates the blue bloom
  glowNode: {
    position: 'absolute',
    width:  140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'transparent',
    shadowColor: '#1E9CF0',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.95,
    shadowRadius: 50,
    elevation: 0,
  },

  logoImg: {
    width:  200,
    height: 200,
    borderRadius: 40,
    overflow: 'hidden',
  },

  // Loading dots
  dotsRow: {
    position: 'absolute',
    bottom: 64,
    flexDirection: 'row',
    gap: 8,
  },
  dot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: 'rgba(30,156,240,0.35)',
  },
});
