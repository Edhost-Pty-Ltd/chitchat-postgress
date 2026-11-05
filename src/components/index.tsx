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
  View, TouchableOpacity, StyleSheet, ViewStyle, Image, useWindowDimensions, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList, ContactStatus } from '../types';
import { AppText, AppIcon, useForeground, useTypography, useGlass, AppBg } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useUnreadCount } from '../hooks/useUnreadCount';
import { useUnviewedStatus } from '../hooks/useUnviewedStatus';
import { useMissedCalls } from '../hooks/useMissedCalls';

// Breakpoint: ≥ this width → sidebar replaces the bottom nav bar
const SIDEBAR_BREAKPOINT = 768;

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
export type TabKey = 'chats' | 'calendar' | 'calls' | 'status' | 'dashboard' | 'settings';

const TABS: {
  id: TabKey;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  iconActive: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  screen: keyof RootStackParamList;
}[] = [
  { id: 'status',    icon: 'aperture-outline',     iconActive: 'aperture',     label: 'Updates',   screen: 'Status'    },
  { id: 'calls',     icon: 'call-outline',         iconActive: 'call',         label: 'Calls',     screen: 'Calls'     },
  { id: 'chats',     icon: 'chatbubbles-outline',  iconActive: 'chatbubbles',  label: 'Chats',     screen: 'Chats'     },
  { id: 'calendar',  icon: 'calendar-outline',     iconActive: 'calendar',     label: 'Calendar',  screen: 'Calendar'  },
  { id: 'dashboard', icon: 'stats-chart-outline',  iconActive: 'stats-chart',  label: 'Dashboard', screen: 'Dashboard' },
  { id: 'settings',  icon: 'person-outline',       iconActive: 'person',       label: 'You',       screen: 'Settings'  },
];

interface BottomNavProps {
  active: TabKey;
  /** Optional tap handler. When provided (e.g. by the custom tab bar in
   *  TabNavigator, which emits a cancelable tabPress event), it is used
   *  instead of BottomNav's own navigate call. */
  onTabPress?: (tabId: TabKey) => void;
}

export function BottomNav({ active, onTabPress }: BottomNavProps) {
  const { width: screenWidth } = useWindowDimensions();
  const isSidebar = screenWidth >= SIDEBAR_BREAKPOINT;

  return isSidebar
    ? <SidebarNav active={active} onTabPress={onTabPress} />
    : <BottomNavBar active={active} onTabPress={onTabPress} />;
}

// ─── Sidebar (large screens ≥ 768 px) ────────────────────────────────────────
function SidebarNav({ active, onTabPress }: BottomNavProps) {
  const navigation = useNavigation<NavProp>();
  const { FG, isDark }  = useForeground();
  const { fontFamily }  = useTypography();
  const insets          = useSafeAreaInsets();
  const { userId, avatarUri, displayName, phone } = useAuth();
  const [collapsed, setCollapsed] = React.useState(false);

  const { totalUnread }      = useUnreadCount(userId);
  const { hasUnviewedStatus } = useUnviewedStatus(userId);
  const { missedCount }      = useMissedCalls(userId);

  const sidebarBg    = isDark ? 'rgba(20,20,30,0.96)'  : 'rgba(255,255,255,0.97)';
  const activeBg     = isDark ? 'rgba(9,178,238,0.18)' : 'rgba(9,178,238,0.10)';
  const borderColor  = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
  const dividerColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';

  const handlePress = (t: typeof TABS[number]) =>
    onTabPress ? onTabPress(t.id) : navigation.navigate(t.screen as any);

  // return (
  //   <View
  //     style={[
  //       sidebarStyles.sidebar,
  //       collapsed && sidebarStyles.sidebarCollapsed,
  //       {
  //         backgroundColor: sidebarBg,
  //         borderRightColor: borderColor,
  //         paddingTop: Math.max(insets.top, 20),
  //         paddingBottom: Math.max(insets.bottom, 20),
  //       },
  //     ]}
  //   >
  //     {/* ── Logo / brand ─────────────────────────────────────────────── */}
  //     <View style={[sidebarStyles.brand, collapsed && sidebarStyles.brandCollapsed]}>
  //       <LinearGradient colors={GRADIENTS.primary} style={sidebarStyles.brandIcon}>
  //         <AppIcon name="chatbubbles" size={20} color="#fff" fixedColor />
  //       </LinearGradient>
  //       {!collapsed && (
  //         <View>
  //           <AppText style={[sidebarStyles.brandName, { fontFamily }]} fixedColor>
  //             ChitChat
  //           </AppText>
  //           <AppText style={[sidebarStyles.brandSub, { color: FG.secondary, fontFamily }]} fixedColor>
  //             Business
  //           </AppText>
  //         </View>
  //       )}
  //     </View>

  //     {/* ── Collapse / expand toggle ──────────────────────────────────── */}
  //     <TouchableOpacity
  //       onPress={() => setCollapsed((c) => !c)}
  //       style={[sidebarStyles.collapseBtn, collapsed && sidebarStyles.collapseBtnCenter]}
  //       activeOpacity={0.7}
  //     >
  //       <AppIcon
  //         name={collapsed ? 'chevron-forward' : 'chevron-back'}
  //         size={16}
  //         color={FG.secondary}
  //       />
  //     </TouchableOpacity>

  //     {/* ── Divider ──────────────────────────────────────────────────── */}
  //     <View style={[sidebarStyles.divider, { backgroundColor: dividerColor }]} />

  //     {/* ── Nav items ────────────────────────────────────────────────── */}
  //     <View style={sidebarStyles.navList}>
  //       {TABS.map((t) => {
  //         const isActive        = active === t.id;
  //         const showChatsBadge  = t.id === 'chats'  && totalUnread > 0;
  //         const showCallsBadge  = t.id === 'calls'  && missedCount > 0;
  //         const showStatusDot   = t.id === 'status' && hasUnviewedStatus;
  //         const badgeCount      = showChatsBadge ? totalUnread : showCallsBadge ? missedCount : 0;

  //         return (
  //           <TouchableOpacity
  //             key={t.id}
  //             style={[
  //               sidebarStyles.navItem,
  //               collapsed && sidebarStyles.navItemCollapsed,
  //               isActive && { backgroundColor: activeBg },
  //             ]}
  //             activeOpacity={0.75}
  //             onPress={() => handlePress(t)}
  //           >
  //             {/* Icon tile */}
  //             <View style={sidebarStyles.iconWrap}>
  //               {t.id === 'settings' ? (
  //                 <View style={[
  //                   sidebarStyles.avatarTile,
  //                   isActive && { borderColor: COLORS.blue, borderWidth: 2 },
  //                 ]}>
  //                   {avatarUri ? (
  //                     <Image source={{ uri: avatarUri }} style={sidebarStyles.sidebarAvatar} />
  //                   ) : (
  //                     <View style={[sidebarStyles.avatarFallback, { backgroundColor: COLORS.blue }]}>
  //                       <AppText style={sidebarStyles.avatarInitials} fixedColor>
  //                         {(displayName || 'You').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
  //                       </AppText>
  //                     </View>
  //                   )}
  //                 </View>
  //               ) : isActive ? (
  //                 <LinearGradient colors={GRADIENTS.primary} style={sidebarStyles.iconTileActive}>
  //                   <AppIcon name={t.iconActive} size={18} color="#fff" fixedColor />
  //                 </LinearGradient>
  //               ) : (
  //                 <View style={sidebarStyles.iconTileInactive}>
  //                   <AppIcon name={t.icon} size={18} color={FG.secondary} />
  //                 </View>
  //               )}

  //               {/* Badge */}
  //               {badgeCount > 0 && (
  //                 <View style={sidebarStyles.badge}>
  //                   <AppText style={sidebarStyles.badgeText} fixedColor>
  //                     {badgeCount > 99 ? '99+' : badgeCount}
  //                   </AppText>
  //                 </View>
  //               )}
  //               {showStatusDot && badgeCount === 0 && (
  //                 <View style={sidebarStyles.statusDot} />
  //               )}
  //             </View>

  //             {/* Label — hidden when collapsed */}
  //             {!collapsed && (
  //               <View style={sidebarStyles.labelWrap}>
  //                 <AppText
  //                   numberOfLines={1}
  //                   style={[
  //                     sidebarStyles.label,
  //                     { color: isActive ? COLORS.blue : FG.secondary, fontFamily },
  //                     isActive && sidebarStyles.labelActive,
  //                   ]}
  //                   fixedColor
  //                 >
  //                   {t.label}
  //                 </AppText>
  //               </View>
  //             )}

  //             {/* Active indicator bar */}
  //             {isActive && <View style={sidebarStyles.activeBar} />}
  //           </TouchableOpacity>
  //         );
  //       })}
  //     </View>

  //     {/* ── Spacer pushes profile to bottom ──────────────────────────── */}
  //     <View style={{ flex: 1 }} />

  //     {/* ── Divider ──────────────────────────────────────────────────── */}
  //     <View style={[sidebarStyles.divider, { backgroundColor: dividerColor }]} />

  //     {/* ── User footer ──────────────────────────────────────────────── */}
  //     <TouchableOpacity
  //       style={[sidebarStyles.userFooter, collapsed && sidebarStyles.userFooterCollapsed]}
  //       activeOpacity={0.75}
  //       onPress={() => navigation.navigate('Settings' as any)}
  //     >
  //       {avatarUri ? (
  //         <Image source={{ uri: avatarUri }} style={sidebarStyles.footerAvatar} />
  //       ) : (
  //         <View style={[sidebarStyles.footerAvatarFallback, { backgroundColor: COLORS.blue }]}>
  //           <AppText style={sidebarStyles.footerInitials} fixedColor>
  //             {(displayName || 'You').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
  //           </AppText>
  //         </View>
  //       )}
  //       {!collapsed && (
  //         <>
  //           <View style={sidebarStyles.footerText}>
  //             <AppText style={[sidebarStyles.footerName, { fontFamily }]} numberOfLines={1} fixedColor>
  //               {displayName || 'You'}
  //             </AppText>
  //             <AppText style={[sidebarStyles.footerPhone, { color: FG.secondary, fontFamily }]} numberOfLines={1} fixedColor>
  //               {phone || ''}
  //             </AppText>
  //           </View>
  //           <AppIcon name="ellipsis-horizontal" size={16} color={FG.secondary} />
  //         </>
  //       )}
  //     </TouchableOpacity>
  //   </View>
  // );


  return (
    <View
      style={[
        sidebarStyles.sidebar,
        {
          backgroundColor: sidebarBg,
          borderRightColor: borderColor,
          paddingTop: Math.max(insets.top, 20),
          paddingBottom: Math.max(insets.bottom, 20),
        },
      ]}
    >
      {/* ── Logo / brand ─────────────────────────────────────────────── */}
      <View style={sidebarStyles.brand}>
        <LinearGradient colors={GRADIENTS.primary} style={sidebarStyles.brandIcon}>
          <AppIcon name="chatbubbles" size={20} color="#fff" fixedColor />
        </LinearGradient>
        <View>
          <AppText style={[sidebarStyles.brandName, { fontFamily }]} fixedColor>
            ChitChat
          </AppText>
          <AppText style={[sidebarStyles.brandSub, { color: FG.secondary, fontFamily }]} fixedColor>
            Business
          </AppText>
        </View>
      </View>

      {/* ── Divider ──────────────────────────────────────────────────── */}
      <View style={[sidebarStyles.divider, { backgroundColor: dividerColor }]} />

      {/* ── Nav items ────────────────────────────────────────────────── */}
      <View style={sidebarStyles.navList}>
        {TABS.map((t) => {
          const isActive        = active === t.id;
          const showChatsBadge  = t.id === 'chats'  && totalUnread > 0;
          const showCallsBadge  = t.id === 'calls'  && missedCount > 0;
          const showStatusDot   = t.id === 'status' && hasUnviewedStatus;
          const badgeCount      = showChatsBadge ? totalUnread : showCallsBadge ? missedCount : 0;

          return (
            <TouchableOpacity
              key={t.id}
              style={[
                sidebarStyles.navItem,
                isActive && { backgroundColor: activeBg },
              ]}
              activeOpacity={0.75}
              onPress={() => handlePress(t)}
            >
              {/* Icon tile */}
              <View style={sidebarStyles.iconWrap}>
                {t.id === 'settings' ? (
                  <View style={[
                    sidebarStyles.avatarTile,
                    isActive && { borderColor: COLORS.blue, borderWidth: 2 },
                  ]}>
                    {avatarUri ? (
                      <Image source={{ uri: avatarUri }} style={sidebarStyles.sidebarAvatar} />
                    ) : (
                      <View style={[sidebarStyles.avatarFallback, { backgroundColor: COLORS.blue }]}>
                        <AppText style={sidebarStyles.avatarInitials} fixedColor>
                          {(displayName || 'You').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                        </AppText>
                      </View>
                    )}
                  </View>
                ) : isActive ? (
                  <LinearGradient colors={GRADIENTS.primary} style={sidebarStyles.iconTileActive}>
                    <AppIcon name={t.iconActive} size={18} color="#fff" fixedColor />
                  </LinearGradient>
                ) : (
                  <View style={sidebarStyles.iconTileInactive}>
                    <AppIcon name={t.icon} size={18} color={FG.secondary} />
                  </View>
                )}

                {/* Badge */}
                {badgeCount > 0 && (
                  <View style={sidebarStyles.badge}>
                    <AppText style={sidebarStyles.badgeText} fixedColor>
                      {badgeCount > 99 ? '99+' : badgeCount}
                    </AppText>
                  </View>
                )}
                {showStatusDot && badgeCount === 0 && (
                  <View style={sidebarStyles.statusDot} />
                )}
              </View>

              {/* Label */}
              <View style={sidebarStyles.labelWrap}>
                <AppText
                  numberOfLines={1}
                  style={[
                    sidebarStyles.label,
                    { color: isActive ? COLORS.blue : FG.secondary, fontFamily },
                    isActive && sidebarStyles.labelActive,
                  ]}
                  fixedColor
                >
                  {t.label}
                </AppText>
              </View>

              {/* Active indicator bar */}
              {isActive && <View style={sidebarStyles.activeBar} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── Spacer pushes profile to bottom ──────────────────────────── */}
      <View style={{ flex: 1 }} />

      {/* ── Divider ──────────────────────────────────────────────────── */}
      <View style={[sidebarStyles.divider, { backgroundColor: dividerColor }]} />

      {/* ── User footer ──────────────────────────────────────────────── */}
      <TouchableOpacity
        style={sidebarStyles.userFooter}
        activeOpacity={0.75}
        onPress={() => navigation.navigate('Settings' as any)}
      >
        {avatarUri ? (
          <Image source={{ uri: avatarUri }} style={sidebarStyles.footerAvatar} />
        ) : (
          <View style={[sidebarStyles.footerAvatarFallback, { backgroundColor: COLORS.blue }]}>
            <AppText style={sidebarStyles.footerInitials} fixedColor>
              {(displayName || 'You').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
            </AppText>
          </View>
        )}
        <View style={sidebarStyles.footerText}>
          <AppText style={[sidebarStyles.footerName, { fontFamily }]} numberOfLines={1} fixedColor>
            {displayName || 'You'}
          </AppText>
          <AppText style={[sidebarStyles.footerPhone, { color: FG.secondary, fontFamily }]} numberOfLines={1} fixedColor>
            {phone || ''}
          </AppText>
        </View>
        <AppIcon name="ellipsis-horizontal" size={16} color={FG.secondary} />
      </TouchableOpacity>
    </View>
  );
}

// ─── Bottom pill (mobile < 768 px) ────────────────────────────────────────────
function BottomNavBar({ active, onTabPress }: BottomNavProps) {
  const navigation = useNavigation<NavProp>();
  const { FG }     = useForeground();
  const { fontFamily } = useTypography();
  const { bevel }  = useGlass();
  const insets     = useSafeAreaInsets();
  const { userId, avatarUri, displayName } = useAuth();

  const { totalUnread }      = useUnreadCount(userId);
  const { hasUnviewedStatus } = useUnviewedStatus(userId);
  const { missedCount }      = useMissedCalls(userId);

  const bottomSpace = Math.max(insets.bottom, 10) + 8;

  return (
    <View style={[styles.navBar, bevel, { marginBottom: bottomSpace }]}>
      {TABS.map((t) => {
        const isActive       = active === t.id;
        const showChatsBadge = t.id === 'chats' && totalUnread > 0;
        const showCallsBadge = t.id === 'calls' && missedCount > 0;
        const showStatusDot  = t.id === 'status' && hasUnviewedStatus;

        return (
          <TouchableOpacity
            key={t.id}
            style={styles.navItem}
            activeOpacity={0.75}
            onPress={() => (onTabPress ? onTabPress(t.id) : navigation.navigate(t.screen as any))}
          >
            <View>
              {t.id === 'settings' ? (
                <View style={[styles.iconTileInactive, isActive && styles.avatarActiveRing]}>
                  {avatarUri ? (
                    <Image source={{ uri: avatarUri }} style={styles.navAvatarImg} />
                  ) : (
                    <View style={styles.navAvatarFallback}>
                      <AppText style={styles.navAvatarInitials} fixedColor>
                        {(displayName || 'You').split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2)}
                      </AppText>
                    </View>
                  )}
                </View>
              ) : isActive ? (
                <LinearGradient colors={GRADIENTS.primary} style={styles.iconTileActive}>
                  <AppIcon name={t.iconActive} size={19} color="#fff" fixedColor />
                </LinearGradient>
              ) : (
                <View style={styles.iconTileInactive}>
                  <AppIcon name={t.icon} size={19} color={FG.secondary} />
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
            <AppText
              numberOfLines={1}
              style={[
                styles.navLabel,
                { color: isActive ? COLORS.blue : FG.secondary, fontFamily },
                isActive && styles.navLabelActive,
              ]}
            >
              {t.label}
            </AppText>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ─── ScreenLayout ─────────────────────────────────────────────────────────────
// Wraps a main tab screen so the sidebar sits beside the content on large
// screens and the bottom nav sits below it on small screens.
// Usage: replace the root <View style={{flex:1}}> + <BottomNav> pair with:
//   <ScreenLayout active="chats"><YourContent /></ScreenLayout>
interface ScreenLayoutProps {
  active: TabKey;
  children: React.ReactNode;
  onTabPress?: (tabId: TabKey) => void;
}

export function ScreenLayout({ active, children, onTabPress }: ScreenLayoutProps) {
  const { width } = useWindowDimensions();
  const isSidebar = width >= SIDEBAR_BREAKPOINT;

  if (isSidebar) {
    return (
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <BottomNav active={active} onTabPress={onTabPress} />
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {children}
      <BottomNav active={active} onTabPress={onTabPress} />
    </View>
  );
}

// ─── UserAvatar ───────────────────────────────────────────────────────────────
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

// ─── Sidebar styles ───────────────────────────────────────────────────────────
const sidebarStyles = StyleSheet.create({
  sidebar: {
    width: 240,
    height: '100%',
    flexDirection: 'column',
    borderRightWidth: 1,
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(20px)' } as any) : {}),
  },
  sidebarCollapsed: {
    width: 64,
  },

  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  brandCollapsed: {
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  brandIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },
  brandName: {
    fontSize: 16,
    fontWeight: '800',
    color: COLORS.text,
    letterSpacing: 0.3,
  },
  brandSub: {
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginTop: 1,
  },

  divider: {
    height: 1,
    marginHorizontal: 16,
    marginVertical: 4,
  },

  navList: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 2,
  },

  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: RADIUS.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
    position: 'relative',
    overflow: 'hidden',
  },
  navItemCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
  },

  collapseBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  collapseBtnCenter: {
    justifyContent: 'center',
  },

  iconWrap: {
    position: 'relative',
    marginRight: 12,
  },

  iconTileActive: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },
  iconTileInactive: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },

  avatarTile: {
    width: 36,
    height: 36,
    borderRadius: 18,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sidebarAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarFallback: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },

  labelWrap: { flex: 1 },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  labelActive: {
    fontWeight: '700',
  },

  activeBar: {
    position: 'absolute',
    right: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    backgroundColor: COLORS.blue,
  },

  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
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

  userFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  userFooterCollapsed: {
    justifyContent: 'center',
    paddingHorizontal: 0,
  },
  footerAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  footerAvatarFallback: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerInitials: {
    fontSize: 12,
    fontWeight: '700',
    color: '#fff',
  },
  footerText: { flex: 1, minWidth: 0 },
  footerName: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.text,
  },
  footerPhone: {
    fontSize: 11,
    marginTop: 1,
  },
});

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
    paddingHorizontal: 6,
    marginHorizontal: 14,
    marginTop: 6,
  },
  navItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },

  iconTileActive: {
    width: 42,
    height: 38,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },

  iconTileInactive: {
    width: 42,
    height: 38,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },

  navAvatarImg: {
    width: 28, height: 28, borderRadius: 14,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.7)',
  },
  navAvatarFallback: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.blue,
  },
  navAvatarInitials: { fontSize: 10, fontWeight: '700', color: '#fff' },
  avatarActiveRing: {
    borderWidth: 2,
    borderColor: COLORS.blue,
    borderRadius: 17,
  },

  navLabel:       { fontSize: 9, fontWeight: '500' },
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
  statusDots: {
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
export { IncomingCallOverlay } from './IncomingCallOverlay';
export { IncomingCallManager } from './IncomingCallManager';
export { FloatingCallOverlay } from './FloatingCallOverlay';
export { default as RTCView } from './RTCView';