// ─── SwipeableRow ─────────────────────────────────────────────────────────────
// Swipe-to-reveal row built on PanResponder + Animated (no native
// gesture-handler dependency). Swiping LEFT slides the row open and HOLDS it,
// revealing a set of tappable action buttons on the right edge. The buttons are
// invisible at rest and only fade/slide in as the row is dragged, so there's no
// visual clutter until the user swipes.
//
// Only left-swipe is used so it never conflicts with the stack's right-edge
// back-swipe gesture.

import React, { useRef, useState, useImperativeHandle, forwardRef } from 'react';
import {
  View, Animated, PanResponder, StyleSheet, TouchableOpacity, Text,
} from 'react-native';
import { AppIcon } from '../context/ThemeContext';

export interface SwipeAction {
  key: string;
  label: string;
  icon: string;
  color: string;        // background colour of the button
  onPress: () => void;
}

export interface SwipeableRowHandle {
  close: () => void;
}

interface Props {
  children: React.ReactNode;
  actions: SwipeAction[];   // rendered left-to-right on the right edge
  actionWidth?: number;     // width of each action button
}

export const SwipeableRow = forwardRef<SwipeableRowHandle, Props>(function SwipeableRow(
  { children, actions, actionWidth = 72 },
  ref,
) {
  const translateX = useRef(new Animated.Value(0)).current;
  const openValue  = useRef(0); // current resting offset (0 or -openWidth)
  const openWidth  = actions.length * actionWidth;

  // Track whether the row is open/dragging so the actions layer can be fully
  // hidden (and non-interactive) at rest.
  const [revealed, setRevealed] = useState(false);

  const animateTo = (to: number) => {
    openValue.current = to;
    if (to === 0) {
      // keep layer mounted during the close animation, then hide it
      Animated.spring(translateX, { toValue: to, useNativeDriver: true, friction: 9, tension: 70 })
        .start(() => setRevealed(false));
    } else {
      setRevealed(true);
      Animated.spring(translateX, { toValue: to, useNativeDriver: true, friction: 9, tension: 70 }).start();
    }
  };

  const open  = () => animateTo(-openWidth);
  const close = () => animateTo(0);

  useImperativeHandle(ref, () => ({ close }));

  const panResponder = useRef(
    PanResponder.create({
      // Claim the gesture early and only for clearly-horizontal drags, so it
      // beats the stack back-swipe and doesn't hijack vertical scrolling.
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 6 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
      onPanResponderGrant: () => setRevealed(true),
      onPanResponderMove: (_e, g) => {
        let next = openValue.current + g.dx;
        if (next > 0) next = next * 0.2;                    // resist dragging right past closed
        if (next < -openWidth - 24) next = -openWidth - 24; // clamp over-drag
        translateX.setValue(next);
      },
      onPanResponderRelease: (_e, g) => {
        const projected = openValue.current + g.dx;
        if (projected < -openWidth / 2) open();
        else close();
      },
      onPanResponderTerminate: () => {
        if (openValue.current < 0) open(); else close();
      },
    }),
  ).current;

  // Fade + slide the actions layer in as the row is dragged open.
  const actionsOpacity = translateX.interpolate({
    inputRange: [-openWidth, -openWidth * 0.25, 0],
    outputRange: [1, 0.6, 0],
    extrapolate: 'clamp',
  });
  const actionsTranslate = translateX.interpolate({
    inputRange: [-openWidth, 0],
    outputRange: [0, openWidth * 0.5],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.container}>
      {/* Action buttons sit behind the row on the right edge — hidden at rest */}
      {revealed && (
        <Animated.View
          style={[styles.actionsLayer, { opacity: actionsOpacity, transform: [{ translateX: actionsTranslate }] }]}
          pointerEvents="box-none"
        >
          {actions.map((a) => (
            <TouchableOpacity
              key={a.key}
              style={[styles.actionBtn, { width: actionWidth, backgroundColor: a.color }]}
              activeOpacity={0.8}
              onPress={() => { close(); a.onPress(); }}
            >
              <AppIcon name={a.icon as any} size={20} color="#fff" fixedColor />
              <Text style={styles.actionLabel} numberOfLines={1}>{a.label}</Text>
            </TouchableOpacity>
          ))}
        </Animated.View>
      )}

      <Animated.View
        style={{ transform: [{ translateX }] }}
        {...panResponder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { position: 'relative', justifyContent: 'center' },
  actionsLayer: {
    position: 'absolute',
    top: 0, bottom: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: 16,
    overflow: 'hidden',
  },
  actionBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  actionLabel: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
