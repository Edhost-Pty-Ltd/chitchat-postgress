// ─── ToastNotification ───────────────────────────────────────────────────────
// Slides in from the top of the screen like a real push notification.
// Tap it to navigate to the relevant screen; swipe up or tap × to dismiss.
import React, { useEffect, useRef } from 'react';
import {
  Animated, TouchableOpacity, View, StyleSheet,
  PanResponder, Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { AppText, AppIcon, useForeground } from '../context/ThemeContext';
import { useNotifications, AppNotification } from '../context/NotificationContext';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

const ICON_MAP: Record<string, React.ComponentProps<typeof AppIcon>['name']> = {
  message:       'chatbubble-outline',
  call:          'call-outline',
  number_change: 'phone-portrait-outline',
  system:        'information-circle-outline',
};

function ToastBanner({ notif }: { notif: AppNotification }) {
  const navigation = useNavigation<NavProp>();
  const { FG }     = useForeground();
  const { dismissToast, markRead } = useNotifications();

  // Slide down from -100 → 0
  const slideY = useRef(new Animated.Value(-120)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(slideY, {
        toValue: 0, useNativeDriver: true,
        friction: 8, tension: 65,
      }),
      Animated.timing(opacity, {
        toValue: 1, duration: 200, useNativeDriver: true,
      }),
    ]).start();
  }, [notif.id]);

  // Swipe up to dismiss
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gs) => gs.dy < -8,
      onPanResponderMove: (_, gs) => {
        if (gs.dy < 0) slideY.setValue(gs.dy);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy < -30) {
          dismiss();
        } else {
          Animated.spring(slideY, { toValue: 0, useNativeDriver: true }).start();
        }
      },
    }),
  ).current;

  const dismiss = () => {
    Animated.parallel([
      Animated.timing(slideY, { toValue: -120, duration: 220, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 0,    duration: 180, useNativeDriver: true }),
    ]).start(() => dismissToast());
  };

  const handleTap = () => {
    markRead(notif.id);
    dismiss();
    if (notif.contactId != null) {
      navigation.navigate('Chats');
    }
  };

  const iconName = ICON_MAP[notif.type] ?? 'notifications-outline';

  return (
    <Animated.View
      style={[
        styles.toast,
        {
          transform: [{ translateY: slideY }],
          opacity,
          backgroundColor: FG.glassBg,
          borderColor: FG.glassBorder,
        },
      ]}
      {...pan.panHandlers}
    >
      <TouchableOpacity
        style={styles.toastInner}
        activeOpacity={0.9}
        onPress={handleTap}
      >
        {/* Icon */}
        <LinearGradient colors={GRADIENTS.primary} style={styles.iconWrap}>
          <AppIcon name={iconName} size={18} color="#fff" fixedColor />
        </LinearGradient>

        {/* Text */}
        <View style={styles.textWrap}>
          <AppText style={styles.toastTitle} numberOfLines={1}>{notif.title}</AppText>
          <AppText style={styles.toastBody}  numberOfLines={2}>{notif.body}</AppText>
        </View>

        {/* Time + dismiss */}
        <View style={styles.rightCol}>
          <AppText style={styles.toastTime}>{notif.time}</AppText>
          <TouchableOpacity
            onPress={dismiss}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <AppIcon name="close" size={16} color={COLORS.sub} />
          </TouchableOpacity>
        </View>
      </TouchableOpacity>

      {/* Swipe hint bar */}
      <View style={styles.swipeBar} />
    </Animated.View>
  );
}

/** Drop this inside NavigationContainer so it renders above all screens. */
export default function ToastOverlay() {
  const { toast } = useNotifications();
  if (!toast) return null;
  return <ToastBanner key={toast.id} notif={toast} />;
}

const styles = StyleSheet.create({
  toast: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 36,
    left: 14,
    right: 14,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    ...SHADOW.glow,
    zIndex: 9999,
    overflow: 'hidden',
  },
  toastInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  iconWrap: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    ...SHADOW.button,
  },
  textWrap: { flex: 1 },
  toastTitle: {
    fontSize: 13, fontWeight: '700',
    color: COLORS.text, marginBottom: 2,
  },
  toastBody: {
    fontSize: 12, color: COLORS.sub, lineHeight: 17,
  },
  rightCol: {
    alignItems: 'flex-end', gap: 6, flexShrink: 0,
  },
  toastTime: {
    fontSize: 10, color: COLORS.sub,
  },
  swipeBar: {
    width: 36, height: 3, borderRadius: 2,
    backgroundColor: 'rgba(9,178,238,0.25)',
    alignSelf: 'center', marginBottom: 6,
  },
});
