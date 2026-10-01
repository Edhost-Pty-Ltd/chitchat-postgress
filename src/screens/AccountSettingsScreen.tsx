// ─── Screen: Account Settings ────────────────────────────────────────────────
//
// On a companion device this screen is read-only: it shows a notice at the
// top explaining that account changes are managed on the primary device, and
// disables every interactive control. Reaching this screen from a companion
// only happens via deep links or stale navigation — the Settings screen no
// longer shows the Account tile in companion mode.
//
import React, { useState, useEffect } from 'react';
import { View, Switch, TouchableOpacity, StyleSheet, ScrollView, Alert, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../context/AuthContext';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList } from '../types';
import {
  BIOMETRIC_KEY, isBiometricAvailable, getBiometricLabel,
  authenticateBiometric, setBiometricEnabled as persistBiometricEnabled,
} from '../utils/biometrics';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'AccountSettings'>;

type RowProps = {
  icon: string; label: string; sub?: string;
  value?: boolean; onToggle?: (v: boolean) => void;
  onPress?: () => void; danger?: boolean; rightLabel?: string;
  disabled?: boolean;
};
function Row({ icon, label, sub, value, onToggle, onPress, danger, rightLabel, disabled }: RowProps) {
  const { FG } = useForeground();
  const { fontFamily, textColor, iconColor } = useTypography();
  const { bevel } = useGlass();

  return (
    <TouchableOpacity
      style={[styles.row, bevel, disabled && styles.rowDisabled]}
      onPress={onPress}
      activeOpacity={onPress && !disabled ? 0.75 : 1}
      disabled={disabled}
    >
      <AppIcon glass tileSize={38} name={icon as any} size={18}
        color={danger ? COLORS.missed : iconColor} fixedColor={danger} />
      <View style={styles.rowMeta}>
        <AppText style={[styles.rowLabel, { color: danger ? COLORS.missed : textColor, fontFamily },
          danger && { fontWeight: '600' }]}>{label}</AppText>
        {sub ? <AppText style={[styles.rowSub, { color: FG.secondary }]}>{sub}</AppText> : null}
      </View>
      {onToggle != null
        ? <Switch value={value} onValueChange={onToggle} disabled={disabled} trackColor={{ true: COLORS.blue }} />
        : rightLabel
          ? <AppText style={[styles.rightLabel, { color: FG.secondary }]}>{rightLabel}</AppText>
          : onPress && !disabled ? <AppIcon name="chevron-forward" size={16} color={FG.secondary} /> : null}
    </TouchableOpacity>
  );
}

export default function AccountSettingsScreen() {
  const navigation = useNavigation<NavProp>();
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();
  const { phone, displayName, signOut, isCompanion } = useAuth();
  const insets = useSafeAreaInsets();

  const [twoFA,            setTwoFA]            = useState(true);
  const [bioLoading,       setBioLoading]       = useState(false);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [biometricLabel,   setBiometricLabel]   = useState('fingerprint or face ID');

  useEffect(() => {
    AsyncStorage.getItem(BIOMETRIC_KEY).then((v) => setBiometricEnabled(v === 'true'));
    getBiometricLabel().then((label) => {
      setBiometricLabel(label === 'Biometrics' ? 'biometrics' : label);
    });
  }, []);

  const handleBiometricToggle = async (enabled: boolean) => {
    if (bioLoading || isCompanion) return;
    setBioLoading(true);
    try {
      if (enabled) {
        const available = await isBiometricAvailable();
        if (!available) {
          Alert.alert(
            'Biometrics unavailable',
            'No fingerprint or face ID is set up on this device. Add one in your device settings, then try again.',
          );
          return;
        }
        const ok = await authenticateBiometric('Confirm to enable biometric login');
        if (!ok) {
          Alert.alert('Not enabled', 'Biometric verification was cancelled or failed.');
          return;
        }
        await persistBiometricEnabled(true);
        setBiometricEnabled(true);
      } else {
        await persistBiometricEnabled(false);
        setBiometricEnabled(false);
      }
    } catch {
      Alert.alert('Error', 'Could not update biometric preference.');
    } finally {
      setBioLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <AppBg />
      <View style={[styles.header, { backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder, paddingTop: Platform.OS === 'web' ? 16 : insets.top + 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <AppIcon name="chevron-back" size={26} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>Account</AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* Companion notice — account settings are read-only on this device */}
        {isCompanion && (
          <View style={[styles.noticeCard, bevel]}>
            <LinearGradient
              colors={['#6366f1', '#8b5cf6']}
              style={styles.noticeIconWrap}
            >
              <AppIcon name="link-outline" size={20} color="#fff" fixedColor />
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <AppText style={[styles.noticeTitle, { color: textColor, fontFamily }]}>
                Managed on your primary device
              </AppText>
              <AppText style={[styles.noticeBody, { color: FG.secondary }]}>
                This is a companion device. To change your phone number, two-step
                verification, biometric login, or delete the account, open
                ChitChat on the phone you signed in with.
              </AppText>
            </View>
          </View>
        )}

        {/* Security */}
        <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>SECURITY</AppText>
        <Row
          icon="call-outline"
          label="Phone Number"
          sub={phone || 'Not set'}
          rightLabel={isCompanion ? undefined : 'Change'}
          onPress={isCompanion ? undefined : () => navigation.navigate('ChangeNumber')}
          disabled={isCompanion}
        />
        <Row
          icon="shield-checkmark-outline"
          label="Two-Step Verification"
          sub={twoFA ? 'Enabled' : 'Add an extra layer of security'}
          value={twoFA}
          onToggle={isCompanion ? undefined : setTwoFA}
          disabled={isCompanion}
        />
        <Row
          icon="finger-print"
          label="Biometric Login"
          sub={
            bioLoading
              ? 'Verifying…'
              : biometricEnabled
                ? `Enabled — ${biometricLabel} required on launch`
                : `Use ${biometricLabel} to unlock the app`
          }
          value={biometricEnabled}
          onToggle={isCompanion ? undefined : handleBiometricToggle}
          disabled={isCompanion}
        />

        {/* Account actions — delete only available on primary */}
        {!isCompanion && (
          <>
            <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>ACCOUNT</AppText>
            <Row
              icon="trash-outline"
              label="Delete Account"
              sub="Permanently delete your ChitChat account"
              danger
              onPress={() =>
                Alert.alert('Delete Account',
                  'This will permanently delete your account and all data. This action cannot be undone.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: signOut },
                  ])
              }
            />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: 0, paddingBottom: 12, paddingHorizontal: 14, borderBottomWidth: 1 },
  back:   {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)',
  },
  title:  { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  scroll: { paddingHorizontal: 14, paddingTop: 16, paddingBottom: 40, gap: 8 },
  sectionLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, paddingHorizontal: 4, paddingBottom: 2, paddingTop: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 13 },
  rowDisabled: { opacity: 0.55 },
  rowMeta:    { flex: 1 },
  rowLabel:   { fontSize: 14, fontWeight: '500' },
  rowSub:     { fontSize: 12, marginTop: 2 },
  rightLabel: { fontSize: 12, fontWeight: '600', color: COLORS.green },

  // Companion notice
  noticeCard: {
    flexDirection: 'row', gap: 14,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 16, paddingVertical: 16,
    marginBottom: 4,
  },
  noticeIconWrap: {
    width: 42, height: 42, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    ...SHADOW.button,
  },
  noticeTitle: { fontSize: 14, fontWeight: '800', marginBottom: 4 },
  noticeBody:  { fontSize: 12, lineHeight: 18 },
});