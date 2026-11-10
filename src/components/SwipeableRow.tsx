// ─── SwipeableRow ─────────────────────────────────────────────────────────────
// Swipe-to-reveal action buttons. Left-swipe reveals buttons on the right edge.
//
// Key behaviours:
//   1. Forgiving gesture — claims any leftward drag that is at least as
//      horizontal as it is vertical (dx < -8 AND |dx| >= |dy|). Upward or
//      downward swipes don't trigger it; diagonal-left ones do.
//   2. Any meaningful left drag opens — ≥ 20 pt is enough; no need to reach
//      the full open width.
//   3. Tap anywhere on screen closes — ChatsScreen renders a full-screen
//      Pressable overlay when any row is open (see `useAnyRowOpen` below).
//      The overlay intercepts every touch so the contact row underneath is
//      NOT activated. The row itself also has an inline tap-to-close overlay.
//   4. Terminate = smart finish — if the OS steals the gesture mid-swipe the
//      row opens or closes based on how far the user dragged, not always close.

import React, {
  useRef, useState, useImperativeHandle, forwardRef, useEffect,
  useCallback,
} from 'react';
import {
  View, Animated, PanResponder, StyleSheet,
  TouchableOpacity, Text, Alert,
} from 'react-native';
import { AppIcon } from '../context/ThemeContext';

// ── Public types ──────────────────────────────────────────────────────────────

export interface SwipeAction {
  key: string;
  label: string;
  icon: string;
  color: string;
  hint?: string;
  onPress: () => void;
}

export interface SwipeableRowHandle {
  close: () => void;
}

// ── Global registry ───────────────────────────────────────────────────────────
// Tracks every mounted row's `close` function plus a listener set so external
// code (ChatsScreen overlay) can react when any row opens or closes.

const openRegistry = new Set<() => void>();
type OpenChangeListener = (anyOpen: boolean) => void;
const openChangeListeners = new Set<OpenChangeListener>();
let currentlyOpenCount = 0;

function notifyListeners() {
  const anyOpen = currentlyOpenCount > 0;
  openChangeListeners.forEach((fn) => fn(anyOpen));
}

function registerOpen() {
  currentlyOpenCount += 1;
  notifyListeners();
}

function registerClose() {
  if (currentlyOpenCount > 0) currentlyOpenCount -= 1;
  notifyListeners();
}

/** Close every open row. Called by the screen-level overlay. */
export function closeAllRows() {
  openRegistry.forEach((fn) => fn());
}

/**
 * Subscribe to "any row is open" changes. Returns an unsubscribe function.
 * Use this in the parent screen to show/hide the full-screen dismiss overlay.
 *
 * Example:
 *   const [anyOpen, setAnyOpen] = useState(false);
 *   useEffect(() => subscribeRowOpen(setAnyOpen), []);
 */
export function subscribeRowOpen(listener: OpenChangeListener): () => void {
  openChangeListeners.add(listener);
  return () => openChangeListeners.delete(listener);
}

function closeAllExcept(keep: () => void) {
  openRegistry.forEach((fn) => { if (fn !== keep) fn(); });
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  children: React.ReactNode;
  actions: SwipeAction[];
  actionWidth?: number;
}

export const SwipeableRow = forwardRef<SwipeableRowHandle, Props>(
  function SwipeableRow({ children, actions, actionWidth = 72 }, ref) {
    const translateX    = useRef(new Animated.Value(0)).current;
    const restingOffset = useRef(0);    // 0 = closed, -openWidth = open
    const dragDelta     = useRef(0);    // running dx during the current gesture
    const isOpenRef     = useRef(false);
    const openWidth     = actions.length * actionWidth;

    const [revealed, setRevealed] = useState(false);

    // ── close ─────────────────────────────────────────────────────────────────
    const close = useCallback(() => {
      if (!isOpenRef.current && restingOffset.current === 0) return; // already closed
      restingOffset.current = 0;
      dragDelta.current = 0;
      if (isOpenRef.current) {
        isOpenRef.current = false;
        registerClose();
      }
      Animated.spring(translateX, {
        toValue: 0,
        useNativeDriver: true,
        friction: 9,
        tension: 70,
      }).start(() => setRevealed(false));
    }, [translateX]);

    // ── open ──────────────────────────────────────────────────────────────────
    const open = useCallback(() => {
      closeAllExcept(close);
      restingOffset.current = -openWidth;
      if (!isOpenRef.current) {
        isOpenRef.current = true;
        registerOpen();
      }
      setRevealed(true);
      Animated.spring(translateX, {
        toValue: -openWidth,
        useNativeDriver: true,
        friction: 9,
        tension: 70,
      }).start();
    }, [close, openWidth, translateX]);

    useImperativeHandle(ref, () => ({ close }));

    useEffect(() => {
      openRegistry.add(close);
      return () => {
        openRegistry.delete(close);
        // If this row was open when unmounted, decrement count.
        if (isOpenRef.current) {
          isOpenRef.current = false;
          registerClose();
        }
      };
    }, [close]);

    // ── PanResponder ──────────────────────────────────────────────────────────
    const pan = useRef(
      PanResponder.create({
        // Claim when the drag is leftward (dx < -8) AND at least as horizontal
        // as it is vertical (|dx| >= |dy|). This allows diagonal-left swipes
        // while refusing vertical scrolls that happen to drift left slightly.
        onMoveShouldSetPanResponder: (_e, g) =>
          g.dx < -8 && Math.abs(g.dx) >= Math.abs(g.dy),

        onPanResponderGrant: () => {
          closeAllExcept(close);
          dragDelta.current = 0;
          setRevealed(true);
          // Anchor at current resting position so re-swiping an open row
          // continues from where it is rather than jumping.
          translateX.setOffset(restingOffset.current);
          translateX.setValue(0);
        },

        onPanResponderMove: (_e, g) => {
          dragDelta.current = g.dx;
          let next = g.dx;
          if (next < -openWidth - 24) next = -openWidth - 24; // overdrag clamp
          if (next > 0) next = next * 0.15;                   // resist right-drag
          translateX.setValue(next);
        },

        onPanResponderRelease: (_e, g) => {
          translateX.flattenOffset();
          // Open if dragged at least 20 pt left, or more than halfway open.
          const projected = restingOffset.current + g.dx;
          if (g.dx < -20 || projected < -(openWidth / 2)) {
            open();
          } else {
            close();
          }
        },

        // System stole the gesture (e.g. FlatList scroll took over).
        // Always close — the user is no longer interacting with the swipe
        // actions, so don't try to keep the row open.
        onPanResponderTerminate: () => {
          translateX.flattenOffset();
          close();
        },
      }),
    ).current;

    // ── Animated interpolations ───────────────────────────────────────────────
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

    // ── Render ────────────────────────────────────────────────────────────────
    return (
      <View style={styles.container}>
        {/* Action buttons — hidden at rest, revealed when row is open */}
        {revealed && (
          <Animated.View
            style={[
              styles.actionsLayer,
              {
                opacity: actionsOpacity,
                transform: [{ translateX: actionsTranslate }],
              },
            ]}
          >
            {actions.map((a) => (
              <TouchableOpacity
                key={a.key}
                style={[styles.actionBtn, { width: actionWidth, backgroundColor: a.color }]}
                activeOpacity={0.8}
                onPress={() => { close(); a.onPress(); }}
                onLongPress={() => a.hint && Alert.alert(a.label, a.hint)}
                delayLongPress={300}
              >
                <AppIcon name={a.icon as any} size={20} color="#fff" fixedColor />
                <Text style={styles.actionLabel} numberOfLines={1}>{a.label}</Text>
              </TouchableOpacity>
            ))}
          </Animated.View>
        )}

        {/* Sliding row content */}
        <Animated.View
          style={{ transform: [{ translateX }] }}
          {...pan.panHandlers}
        >
          {/*
           * Inline tap-to-close: sits above the children while the row is
           * open. Prevents the row's own content from being tapped while
           * the swipe-actions are visible. Only covers the sliding content —
           * not the action buttons, which are in a separate absolute layer.
           */}
          {revealed && (
            <TouchableOpacity
              style={StyleSheet.absoluteFill}
              activeOpacity={1}
              onPress={close}
            />
          )}
          {children}
        </Animated.View>
      </View>
    );
  },
);

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    position: 'relative',
    justifyContent: 'center',
  },
  actionsLayer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
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
  actionLabel: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
});
