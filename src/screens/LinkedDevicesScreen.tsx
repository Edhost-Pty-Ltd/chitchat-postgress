// ─── Screen: Linked Devices ──────────────────────────────────────────────────
// Shows all devices currently signed into this account with:
//   • Device name & type icon
//   • Sign-in location (city / country)
//   • Sign-in date/time
//   • "This device" badge for the current device
//   • Log out button (with confirmation) for each other device
import React, { useState } from 'react';
import {
  View, TouchableOpacity, StyleSheet, ScrollView, Modal, Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

// ─── Mock device data ─────────────────────────────────────────────────────────
interface LinkedDevice {
  id: string;
  name: string;
  type: 'phone' | 'tablet' | 'desktop' | 'web';
  os: string;
  location: string;
  signedInAt: string;
  isCurrent: boolean;
}

const DEVICE_ICON: Record<LinkedDevice['type'], IoniconName> = {
  phone:   'phone-portrait-outline',
  tablet:  'tablet-portrait-outline',
  desktop: 'desktop-outline',
  web:     'globe-outline',
};

const INITIAL_DEVICES: LinkedDevice[] = [
  {
    id: 'current',
    name:        Platform.OS === 'web' ? 'Chrome on Windows' : Platform.OS === 'ios' ? 'iPhone 15 Pro' : 'Android Phone',
    type:        Platform.OS === 'web' ? 'web' : 'phone',
    os:          Platform.OS === 'web' ? 'Windows 11' : Platform.OS === 'ios' ? 'iOS 17' : 'Android 14',
    location:    'Johannesburg, South Africa',
    signedInAt:  'Today at 08:22',
    isCurrent:   true,
  },
  {
    id: 'device-2',
    name:      'Samsung Galaxy S23',
    type:      'phone',
    os:        'Android 13',
    location:  'Cape Town, South Africa',
    signedInAt:'Yesterday at 19:04',
    isCurrent: false,
  },
  {
    id: 'device-3',
    name:      'iPad Air (5th Gen)',
    type:      'tablet',
    os:        'iPadOS 17',
    location:  'Durban, South Africa',
    signedInAt:'12 Jun 2026 at 14:30',
    isCurrent: false,
  },
  {
    id: 'device-4',
    name:      'ChitChat Web — Firefox',
    type:      'web',
    os:        'macOS Sonoma',
    location:  'Pretoria, South Africa',
    signedInAt:'10 Jun 2026 at 09:15',
    isCurrent: false,
  },
];

export default function LinkedDevicesScreen() {
  const navigation = useNavigation();
  const { FG }     = useForeground();
  const { fontFamily, textColor } = useTypography();
  const insets = useSafeAreaInsets();

  const [devices, setDevices]           = useState<LinkedDevice[]>(INITIAL_DEVICES);
  const [pendingDevice, setPendingDevice] = useState<LinkedDevice | null>(null);

  const logoutDevice = (id: string) => {
    setDevices((prev) => prev.filter((d) => d.id !== id));
    setPendingDevice(null);
  };

  const logoutAll = () => {
    setDevices((prev) => prev.filter((d) => d.isCurrent));
    setPendingDevice(null);
  };

  const otherDevices = devices.filter((d) => !d.isCurrent);
  const currentDevice = devices.find((d) => d.isCurrent);

  return (
    <View style={styles.root}>
      <AppBg />

      {/* Header */}
      <View style={[styles.header, { backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder, paddingTop: Platform.OS === 'web' ? 16 : insets.top + 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <AppIcon name="chevron-back" size={26} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>Linked Devices</AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* Info banner */}
        <View style={[styles.banner, { backgroundColor: 'rgba(255,255,255,0.6)' }]}>
          <AppIcon name="information-circle-outline" size={18} color={COLORS.blue} fixedColor />
          <AppText style={[styles.bannerTxt, { color: FG.secondary }]}>
            These devices are signed in with your ChitChat account. You can log out of any device remotely.
          </AppText>
        </View>

        {/* Current device */}
        <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>THIS DEVICE</AppText>
        {currentDevice && (
          <DeviceCard device={currentDevice} FG={FG} textColor={textColor} fontFamily={fontFamily} />
        )}

        {/* Other devices */}
        {otherDevices.length > 0 && (
          <>
            <View style={styles.sectionRow}>
              <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>
                OTHER DEVICES ({otherDevices.length})
              </AppText>
              <TouchableOpacity onPress={() => setPendingDevice({ id: '__all__' } as any)} activeOpacity={0.7}>
                <AppText style={[styles.logoutAll, { color: COLORS.missed }]}>Log out all</AppText>
              </TouchableOpacity>
            </View>

            {otherDevices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                FG={FG}
                textColor={textColor}
                fontFamily={fontFamily}
                onLogout={() => setPendingDevice(device)}
              />
            ))}
          </>
        )}

        {otherDevices.length === 0 && (
          <View style={styles.emptyWrap}>
            <AppIcon name="phone-portrait-outline" size={48} color={FG.secondary} />
            <AppText style={[styles.emptyTxt, { color: FG.secondary }]}>
              No other devices linked
            </AppText>
          </View>
        )}
      </ScrollView>

      {/* ── Logout confirmation modal ── */}
      <Modal
        visible={!!pendingDevice}
        transparent
        animationType="fade"
        onRequestClose={() => setPendingDevice(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: FG.glassBg, borderColor: FG.glassBorder }]}>
            <AppBg />
            <LinearGradient colors={['#e84343', '#c0392b']} style={styles.modalIcon}>
              <AppIcon name="log-out-outline" size={26} color="#fff" fixedColor />
            </LinearGradient>

            <AppText style={[styles.modalHeading, { color: textColor, fontFamily }]}>
              {pendingDevice?.id === '__all__' ? 'Log Out All Devices?' : 'Log Out Device?'}
            </AppText>

            <AppText style={[styles.modalBody, { color: FG.secondary }]}>
              {pendingDevice?.id === '__all__'
                ? 'All other devices will be signed out of your ChitChat account immediately.'
                : `"${pendingDevice?.name}" will be signed out of your ChitChat account immediately.`}
            </AppText>

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalBtn, styles.modalBtnCancel, { borderColor: FG.glassBorder }]}
                onPress={() => setPendingDevice(null)}
                activeOpacity={0.8}
              >
                <AppText style={[styles.modalBtnTxt, { color: textColor }]}>Cancel</AppText>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalBtn}
                onPress={() =>
                  pendingDevice?.id === '__all__'
                    ? logoutAll()
                    : logoutDevice(pendingDevice!.id)
                }
                activeOpacity={0.8}
              >
                <LinearGradient colors={['#e84343', '#c0392b']} style={styles.modalBtnGrad}>
                  <AppIcon name="log-out-outline" size={16} color="#fff" fixedColor />
                  <AppText fixedColor style={[styles.modalBtnTxt, { color: '#fff' }]}>
                    {pendingDevice?.id === '__all__' ? 'Log Out All' : 'Log Out'}
                  </AppText>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── Device card component ────────────────────────────────────────────────────
interface DeviceCardProps {
  device: LinkedDevice;
  FG: any;
  textColor: string;
  fontFamily: string;
  onLogout?: () => void;
}
function DeviceCard({ device, FG, textColor, fontFamily, onLogout }: DeviceCardProps) {
  const { bevel } = useGlass();
  return (
    <View style={[styles.card, bevel]}>
      {/* Icon */}
      <View style={[styles.deviceIconWrap, { backgroundColor: 'rgba(9,178,238,0.10)' }]}>
        <AppIcon name={DEVICE_ICON[device.type]} size={22} color={COLORS.blue} fixedColor />
      </View>

      {/* Info */}
      <View style={styles.deviceInfo}>
        <View style={styles.deviceNameRow}>
          <AppText style={[styles.deviceName, { color: textColor, fontFamily }]} numberOfLines={1}>
            {device.name}
          </AppText>
          {device.isCurrent && (
            <LinearGradient colors={GRADIENTS.primary} style={styles.currentBadge}>
              <AppText fixedColor style={styles.currentBadgeTxt}>This device</AppText>
            </LinearGradient>
          )}
        </View>
        <AppText style={[styles.deviceMeta, { color: FG.secondary }]} numberOfLines={1}>
          {device.os}
        </AppText>
        <View style={styles.deviceDetailRow}>
          <AppIcon name="location-outline" size={12} color={FG.secondary} />
          <AppText style={[styles.deviceDetail, { color: FG.secondary }]} numberOfLines={1}>
            {device.location}
          </AppText>
        </View>
        <View style={styles.deviceDetailRow}>
          <AppIcon name="time-outline" size={12} color={FG.secondary} />
          <AppText style={[styles.deviceDetail, { color: FG.secondary }]}>
            Signed in {device.signedInAt}
          </AppText>
        </View>
      </View>

      {/* Logout button — only on other devices */}
      {onLogout && (
        <TouchableOpacity
          style={styles.logoutBtn}
          onPress={onLogout}
          activeOpacity={0.8}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <AppIcon name="log-out-outline" size={20} color={COLORS.missed} fixedColor />
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 0, paddingBottom: 12, paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  back:  {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)',
  },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },

  scroll: { paddingHorizontal: 14, paddingTop: 16, paddingBottom: 48, gap: 8 },

  banner: {
    flexDirection: 'row', gap: 10, alignItems: 'flex-start',
    borderRadius: RADIUS.lg, borderWidth: 0,
    paddingHorizontal: 14, paddingVertical: 12,
    marginBottom: 4,
  },
  bannerTxt: { flex: 1, fontSize: 13, lineHeight: 19 },

  sectionRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingBottom: 2, paddingTop: 8 },
  sectionLabel:{ fontSize: 10, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 4, paddingBottom: 2, paddingTop: 8 },
  logoutAll:   { fontSize: 12, fontWeight: '700', color: COLORS.missed },

  card: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 14,
  },

  deviceIconWrap: {
    width: 48, height: 48, borderRadius: 14,
    borderWidth: 0, alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },

  deviceInfo:      { flex: 1, gap: 3 },
  deviceNameRow:   { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  deviceName:      { fontSize: 14, fontWeight: '700', flexShrink: 1 },
  deviceMeta:      { fontSize: 12 },
  deviceDetailRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  deviceDetail:    { fontSize: 11 },

  currentBadge: {
    paddingHorizontal: 8, paddingVertical: 2,
    borderRadius: RADIUS.full, ...SHADOW.button,
  },
  currentBadgeTxt: { fontSize: 10, fontWeight: '700', color: '#fff' },

  logoutBtn: {
    padding: 4, alignSelf: 'center',
  },

  emptyWrap: { alignItems: 'center', paddingTop: 48, gap: 12 },
  emptyTxt:  { fontSize: 14 },

  // ── Logout confirmation modal ──────────────────────────────────────────────
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.50)',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 28,
  },
  modalCard: {
    width: '100%', borderRadius: 20, borderWidth: 1,
    alignItems: 'center', padding: 28, gap: 12,
    overflow: 'hidden', ...SHADOW.glow,
  },
  modalIcon: {
    width: 60, height: 60, borderRadius: 30,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 4, ...SHADOW.button,
  },
  modalHeading: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  modalBody:    { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  modalActions: { flexDirection: 'row', gap: 12, marginTop: 8, width: '100%' },
  modalBtn:     { flex: 1, borderRadius: RADIUS.full, overflow: 'hidden' },
  modalBtnCancel: {
    borderWidth: 1, alignItems: 'center',
    justifyContent: 'center', paddingVertical: 13,
  },
  modalBtnGrad: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 6, paddingVertical: 13,
  },
  modalBtnTxt: { fontSize: 15, fontWeight: '700' },
});
