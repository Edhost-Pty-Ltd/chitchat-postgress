// ─── Shared Components ───────────────────────────────────────────────────────
export * from './StatusViewer';
export * from './CreateStatusModal';
export * from './VoiceMessageBubble';
export * from './ForwardModal';
export * from './MessageInfoModal';
export * from './FloatingCallOverlay';
export * from './NotificationTestButton';

import React from 'react';
import {
  View, TouchableOpacity, StyleSheet, ViewStyle, Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList, ContactStatus } from '../types';
import { AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useUnreadCount } from '../hooks/useUnreadCount';
import { useUnviewedStatus } from '../hooks/useUnviewedStatus';
import { useMissedCalls } from '../hooks/useMissedCalls';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

// ─── Avatar ──────────────────────────────────────────────────────────────────
interface AvatarProps {
  initials: string;
  color: string;
  size?: number;
  status?: ContactStatus;
  style?: ViewStyle;
  imageUrl?: string | null;
}
export function Avatar({ initials, color, size = 44, status: _status, style, imageUrl }: AvatarProps) {
  return (
    <View style={[{ width: size, height: size }, style]}>
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 2,
            borderColor: 'rgba(255,255,255,0.50)',
          }}
        />
      ) : (
        <View style={[styles.avatarCircle, {
          width: size, height: size, borderRadius: size / 2,
          backgroundColor: color,
        }]}>
          <AppText style={[styles.avatarText, { fontSize: Math.round(size * 0.36) }]}>
            {initials}
          </AppText>
        </View>
      )}
    </View>
  );
}

// ─── BottomNav ────────────────────────────────────────────────────────────────
type TabKey = 'chats' | 'calls' | 'status' | 'settings';
const TABS: {
  id: TabKey;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconActive: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  screen: keyof RootStackParamList;
}[] = [
  { id: 'status',   icon: 'aperture-outline',    iconActive: 'aperture',    label: 'Updates', screen: 'Status'   },
  { id: 'calls',    icon: 'call-outline',        iconActive: 'call',        label: 'Calls',   screen: 'Calls'    },
  { id: 'chats',    icon: 'chatbubbles-outline', iconActive: 'chatbubbles', label: 'Chats',   screen: 'Chats'    },
  { id: 'settings', icon: 'person-outline',      iconActive: 'person',      label: 'You',     screen: 'Settings' },
];

interface BottomNavProps { active: TabKey; }
export function BottomNav({ active }: BottomNavProps) {
  const navigation = useNavigation<NavProp>();
  const { FG } = useForeground();
  const { fontFamily } = useTypography();
  const { bevel } = useGlass();
  const insets = useSafeAreaInsets();
  const { userId, avatarUri, displayName } = useAuth();
  
  // Use the hooks directly (now properly imported at the top)
  const { totalUnread } = useUnreadCount(userId);
  const { hasUnviewedStatus } = useUnviewedStatus(userId);
  const { missedCount } = useMissedCalls(userId);

  // Sit the pill just above the device's system navigation bar / gesture area.
  // insets.bottom adapts per device (0 on devices w/o a system bar, larger for
  // gesture/3-button bars). Falls back to a sensible minimum.
  const bottomSpace = Math.max(insets.bottom, 10) + 8;

  return (
    <View style={[styles.navBar, bevel, { marginBottom: bottomSpace }]}>
      {TABS.map((t) => {
        const isActive = active === t.id;
        const showChatsBadge = t.id === 'chats' && totalUnread > 0;
        const showCallsBadge = t.id === 'calls' && missedCount > 0;
        const showStatusDot = t.id === 'status' && hasUnviewedStatus;
        
        return (
          <TouchableOpacity
            key={t.id}
            style={styles.navItem}
            activeOpacity={0.75}
            onPress={() => navigation.navigate(t.screen as any)}
          >
            <View>
              {t.id === 'settings' ? (
                // "You" tab — show the user's profile picture
                <View style={[styles.iconTileInactive, isActive && styles.avatarActiveRing]}>
                  {avatarUri ? (
                    <Image
                      source={{ uri: avatarUri }}
                      style={styles.navAvatarImg}
                    />
                  ) : (
                    <View style={styles.navAvatarFallback}>
                      <AppText style={styles.navAvatarInitials} fixedColor>
                        {(displayName || 'You').split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2)}
                      </AppText>
                    </View>
                  )}
                </View>
              ) : isActive ? (
                <LinearGradient colors={GRADIENTS.primary} style={styles.iconTileActive}>
                  <AppIcon name={t.iconActive} size={20} color="#fff" fixedColor />
                </LinearGradient>
              ) : (
                <View style={styles.iconTileInactive}>
                  <AppIcon name={t.icon} size={20} color={FG.secondary} />
                </View>
              )}
              {showChatsBadge && (
                <View style={styles.badge}>
                  <AppText style={styles.badgeText} fixedColor>
                    {totalUnread > 99 ? '99+' : totalUnread}
                  </AppText>
                </View>
              )}
              {showCallsBadge && (
                <View style={styles.badge}>
                  <AppText style={styles.badgeText} fixedColor>
                    {missedCount > 99 ? '99+' : missedCount}
                  </AppText>
                </View>
              )}
              {showStatusDot && !showChatsBadge && !showCallsBadge && (
                <View style={styles.statusDot} />
              )}
            </View>
            <AppText style={[
              styles.navLabel,
              { color: isActive ? COLORS.blue : FG.secondary, fontFamily },
              isActive && styles.navLabelActive,
            ]}>
              {t.label}
            </AppText>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── UserAvatar ───────────────────────────────────────────────────────────────
// Renders the signed-in user's profile picture (or initials fallback).
interface UserAvatarProps { size?: number; }
export function UserAvatar({ size = 44 }: UserAvatarProps) {
  const { avatarUri, displayName } = useAuth();
  const name     = displayName || 'JD';
  const initials = name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
  if (avatarUri) {
    return (
      <Image
        source={{ uri: avatarUri }}
        style={{
          width: size, height: size, borderRadius: size / 2,
          borderWidth: 2, borderColor: 'rgba(255,255,255,0.50)',
        }}
      />
    );
  }
  return <Avatar initials={initials} color={COLORS.blue} size={size} />;
}
interface AppHeaderProps {
  title: string;
  showBack?: boolean;
  rightIcon?: string;
  onRightPress?: () => void;
}
export function AppHeader({ title, showBack, rightIcon, onRightPress }: AppHeaderProps) {
  const navigation = useNavigation<NavProp>();
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  return (
    <View style={[styles.header, { backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder }]}>
      {showBack ? (
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerSide}>
          <AppIcon name="chevron-back" size={26} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
      ) : (
        <View style={styles.headerSide} />
      )}
      <AppText style={[styles.headerTitle, { color: textColor, fontFamily }]}>{title}</AppText>
      {rightIcon ? (
        <TouchableOpacity onPress={onRightPress} style={[styles.headerSide, { alignItems: 'flex-end' }]}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.headerRightBtn}>
            <AppText style={{ fontSize: 15, color: '#fff' }}>{rightIcon}</AppText>
          </LinearGradient>
        </TouchableOpacity>
      ) : (
        <View style={styles.headerSide} />
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  avatarCircle: {
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.50)',
  },
  avatarText: { color: '#fff', fontWeight: '700' },
  statusDot:  { position: 'absolute', borderWidth: 2, borderColor: COLORS.sky1 },

  navBar: {
    flexDirection: 'row',
    borderRadius: 50,
    paddingVertical: 10,
    paddingHorizontal: 8,
    marginHorizontal: 20,
    marginTop: 6,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },

  // Active — blue gradient tile with glow
  iconTileActive: {
    width: 46,
    height: 40,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },

  // Inactive — plain container, no glass tile (avoids Android overflow artifacts)
  iconTileInactive: {
    width: 46,
    height: 40,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // "You" tab avatar
  navAvatarImg: {
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)',
  },
  navAvatarFallback: {
    width: 30, height: 30, borderRadius: 15,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.blue,
  },
  navAvatarInitials: { fontSize: 11, fontWeight: '700', color: '#fff' },
  avatarActiveRing: {
    borderWidth: 2,
    borderColor: COLORS.blue,
    borderRadius: 18,
  },

  navLabel:       { fontSize: 10, fontWeight: '500' },
  navLabelActive: { fontWeight: '700', color: COLORS.blue },
  
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    backgroundColor: '#ef4444',
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
  statusDot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#10b981',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
  },

  header:         { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 52, paddingBottom: 12, ...GLASS.header },
  headerSide:     { width: 40 },
  headerTitle:    { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: COLORS.text },
  headerRightBtn: { width: 32, height: 32, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', ...SHADOW.button },
});

// ─── Re-exports ──────────────────────────────────────────────────────────────
// Export other components that are in separate files
export { IncomingCallOverlay } from './IncomingCallOverlay';
export { IncomingCallManager } from './IncomingCallManager';
export { FloatingCallOverlay } from './FloatingCallOverlay';
export { default as RTCView } from './RTCView';

