// ─── Screen: Settings ────────────────────────────────────────────────────────
import React from 'react';
import { View, TouchableOpacity, StyleSheet, ScrollView, Linking } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { BottomNav, UserAvatar } from '../components';
import { COLORS, RADIUS } from '../types/theme';
import { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import { AppBg, AppText, AppIcon, useForeground, useTypography } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];
type NavProp = NativeStackNavigationProp<RootStackParamList, 'Settings'>;

const SETTINGS_SECTIONS: {
  label?: string;
  items: { id: string; icon: IoniconName; label: string; danger?: boolean }[];
}[] = [
  {
    items: [
      { id: 'account',       icon: 'person-outline',        label: 'Account'       },
      { id: 'privacy',       icon: 'lock-closed-outline',   label: 'Privacy'       },
      { id: 'notifications', icon: 'notifications-outline', label: 'Notifications' },
    ],
  },
  {
    items: [
      { id: 'devices',    icon: 'phone-portrait-outline', label: 'Linked Devices' },
      { id: 'appearance', icon: 'color-palette-outline',  label: 'Appearance'            },
    ],
  },
  {
    items: [
      { id: 'help',          icon: 'help-circle-outline',      label: 'Help & Support' },
      { id: 'privacypolicy', icon: 'shield-checkmark-outline', label: 'Privacy Policy' },
    ],
  },
  {
    items: [{ id: 'signout', icon: 'log-out-outline', label: 'Sign Out', danger: true }],
  },
];

export default function SettingsScreen() {
  const navigation = useNavigation<NavProp>();
  const { signOut, displayName, isCompanion } = useAuth();
  const { FG }  = useForeground();
  const { fontFamily, textColor } = useTypography();
  const insets = useSafeAreaInsets();

  const handleItem = (id: string) => {
    if (id === 'signout')       { signOut(); return; }
    if (id === 'appearance')    navigation.navigate('Appearance');
    if (id === 'account')       navigation.navigate('AccountSettings');
    if (id === 'privacy')       navigation.navigate('PrivacySettings');
    if (id === 'notifications') navigation.navigate('NotificationSettings');
    if (id === 'devices')       navigation.navigate('LinkedDevices');
    if (id === 'help')          Linking.openURL('https://chit-chat-67a7f.web.app/support.html');
    if (id === 'privacypolicy') Linking.openURL('https://chit-chat-67a7f.web.app/privacy.html');
  };

  return (
    <View style={styles.root}>
      <AppBg />

      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>Settings</AppText>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* Profile card */}
        <TouchableOpacity
          style={styles.profileCard}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('Profile')}
        >
          <UserAvatar size={52} />
          <View style={styles.profileText}>
            <AppText style={[styles.profileName, { color: textColor, fontFamily }]}>
              {displayName || 'John Doe'}
            </AppText>
            <AppText style={[styles.profileSub, { color: COLORS.sub, fontFamily }]}>
              View business profile
            </AppText>
          </View>
          <AppIcon name="chevron-forward" size={18} color={COLORS.sub} />
        </TouchableOpacity>

        {/* Settings sections */}
        {SETTINGS_SECTIONS.map((section, si) => {
          // Companion devices cannot open the Account tab. Filter the entry
          // out entirely rather than showing a disabled row.
          const items = isCompanion
            ? section.items.filter((i) => i.id !== 'account')
            : section.items;

          if (items.length === 0) return null;

          return (
            <View key={si} style={styles.section}>
              {section.label && (
                <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>{section.label}</AppText>
              )}
              {items.map((item) => (
                <TouchableOpacity
                  key={item.id}
                  style={styles.settingsCard}
                  activeOpacity={0.75}
                  onPress={() => handleItem(item.id)}
                >
                  <View style={[styles.iconCircle, item.danger && styles.iconCircleDanger]}>
                    <AppIcon
                      name={item.icon}
                      size={18}
                      color={item.danger ? COLORS.missed : COLORS.blue}
                      fixedColor
                    />
                  </View>
                  <AppText
                    style={[styles.itemLabel, { color: textColor, fontFamily }, item.danger && styles.itemLabelDanger]}
                    fixedColor={item.danger}
                  >
                    {item.label}
                  </AppText>
                  {!item.danger && <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />}
                </TouchableOpacity>
              ))}
            </View>
          );
        })}
      </ScrollView>

      <BottomNav active="settings" />
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: COLORS.sky1 },
  header: { paddingHorizontal: 20, paddingBottom: 14 },
  title:  { fontSize: 26, fontWeight: '800', color: COLORS.text },
  scroll: { paddingHorizontal: 16, paddingBottom: 20, gap: 8 },

  profileCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 14, marginBottom: 4,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)',
  },
  profileText: { flex: 1 },
  profileName: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  profileSub:  { fontSize: 12, color: COLORS.sub, marginTop: 2 },

  section:      { gap: 8, marginBottom: 6 },
  sectionLabel: { fontSize: 10, fontWeight: '700', color: COLORS.sub, letterSpacing: 1.2, paddingHorizontal: 4, paddingBottom: 2 },

  settingsCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: 14, paddingHorizontal: 14, paddingVertical: 13,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)',
  },
  iconCircle:       { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(30,156,240,0.10)', alignItems: 'center', justifyContent: 'center' },
  iconCircleDanger: { backgroundColor: 'rgba(235,72,72,0.10)' },
  itemLabel:        { flex: 1, fontSize: 15, fontWeight: '500', color: COLORS.text },
  itemLabelDanger:  { color: COLORS.missed, fontWeight: '600' },
});