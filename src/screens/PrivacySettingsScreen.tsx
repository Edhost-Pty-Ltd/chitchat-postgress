// ─── Screen: Privacy Settings ────────────────────────────────────────────────
//
// COMPANION NOTE
//   Privacy settings live on the owner's user doc. Companions can read them
//   but cannot write — the rules require request.auth.uid == userId for
//   users/{userId} updates, and a companion's auth.uid is anon, not the
//   owner. So on a companion:
//
//     • Every control is disabled
//     • A notice banner explains where to change them
//     • ownerUid is used to load the correct privacy settings
//
import React from 'react';
import {
  View, Switch, TouchableOpacity, StyleSheet,
  ScrollView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { COLORS, RADIUS, SHADOW } from '../types/theme';
import { RootStackParamList } from '../types';
import { useAuth } from '../context/AuthContext';
import {
  usePrivacySettings,
  Visibility,
  DEFAULT_PRIVACY,
} from '../hooks/usePrivacySettings';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'PrivacySettings'>;

// ─── Shared row component ─────────────────────────────────────────────────────
function Row({
  icon, label, sub, value, onToggle, onPress, rightLabel, disabled,
}: {
  icon: string; label: string; sub?: string;
  value?: boolean; onToggle?: (v: boolean) => void;
  onPress?: () => void; rightLabel?: string;
  disabled?: boolean;
}) {
  const { FG } = useForeground();
  const { fontFamily, textColor, iconColor } = useTypography();
  const { bevel } = useGlass();
  return (
    <TouchableOpacity
      style={[styles.row, bevel, disabled && styles.disabled]}
      onPress={onPress}
      activeOpacity={onPress && !disabled ? 0.75 : 1}
      disabled={disabled}
    >
      <AppIcon glass tileSize={38} name={icon as any} size={18} color={iconColor} />
      <View style={styles.rowMeta}>
        <AppText style={[styles.rowLabel, { color: textColor, fontFamily }]}>{label}</AppText>
        {sub ? <AppText style={[styles.rowSub, { color: FG.secondary }]}>{sub}</AppText> : null}
      </View>
      {onToggle != null
        ? <Switch value={value} onValueChange={onToggle} disabled={disabled} trackColor={{ true: COLORS.blue }} />
        : rightLabel != null
          ? <AppText style={[styles.rightLabel, { color: FG.secondary }]}>{rightLabel}</AppText>
          : onPress && !disabled
            ? <AppIcon name="chevron-forward" size={16} color={FG.secondary} />
            : null}
    </TouchableOpacity>
  );
}

// ─── Inline 3-option visibility picker ───────────────────────────────────────
function VisibilityPicker({
  icon, label, value, onChange, disabled,
}: {
  icon: string; label: string;
  value: Visibility; onChange: (v: Visibility) => void;
  disabled?: boolean;
}) {
  const { FG } = useForeground();
  const { fontFamily, textColor, iconColor } = useTypography();
  const { bevel } = useGlass();
  const options: Visibility[] = ['Everyone', 'Contacts', 'Nobody'];
  return (
    <View style={[styles.row, bevel, disabled && styles.disabled]}>
      <AppIcon glass tileSize={38} name={icon as any} size={18} color={iconColor} />
      <AppText style={[styles.rowLabel, { color: textColor, fontFamily, flex: 1 }]}>
        {label}
      </AppText>
      <View style={styles.visRow}>
        {options.map((o) => (
          <TouchableOpacity
            key={o}
            onPress={() => !disabled && onChange(o)}
            style={[styles.visBtn, value === o && styles.visBtnActive]}
            activeOpacity={disabled ? 1 : 0.75}
            disabled={disabled}
          >
            <AppText
              style={[styles.visTxt, { color: value === o ? '#fff' : FG.secondary }]}
              fixedColor={value === o}
            >
              {o}
            </AppText>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function PrivacySettingsScreen() {
  const navigation = useNavigation<NavProp>();
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();

  // Use ownerUid so a companion loads the OWNER's privacy settings.
  // `isCompanion` gates every write — see the note at the top of the file.
  const { userId: ownerUid, isCompanion } = useAuth();

  const { settings, loading, saving, updateSetting } = usePrivacySettings(ownerUid);

  // When the user is a companion, every mutation goes through this wrapper
  // which silently ignores the change and shows a notice instead. Centralised
  // here so the picker/row components stay dumb.
  const guardedUpdate = <K extends keyof typeof DEFAULT_PRIVACY>(key: K, value: (typeof DEFAULT_PRIVACY)[K]) => {
    if (isCompanion) {
      Alert.alert(
        'Managed on your primary device',
        'Privacy settings belong to the account owner. Open ChitChat on the phone you signed in with to change them.',
      );
      return;
    }
    updateSetting(key as any, value as any);
  };

  if (loading) {
    return (
      <View style={[styles.root, styles.center]}>
        <AppBg />
        <ActivityIndicator size="large" color={COLORS.blue} />
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <AppBg />

      {/* Header */}
      <View style={[styles.header, {
        backgroundColor: FG.glassBg,
        borderBottomColor: FG.glassBorder,
      }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <AppIcon name="chevron-back" size={26} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>Privacy</AppText>
        <View style={styles.back}>
          {saving && <ActivityIndicator size="small" color={COLORS.blue} />}
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {/* Companion notice — settings are visible but read-only */}
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
                Read-only on this device
              </AppText>
              <AppText style={[styles.noticeBody, { color: FG.secondary }]}>
                You can view these settings, but changing them requires the
                primary device.
              </AppText>
            </View>
          </View>
        )}

        {/* ── Who can see ──────────────────────────────────────────── */}
        <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>
          WHO CAN SEE
        </AppText>

        <VisibilityPicker
          icon="time-outline"
          label="Last Seen"
          value={settings.lastSeen}
          onChange={(v) => guardedUpdate('lastSeen', v)}
          disabled={isCompanion}
        />
        <VisibilityPicker
          icon="person-circle-outline"
          label="Profile Photo"
          value={settings.profilePhoto}
          onChange={(v) => guardedUpdate('profilePhoto', v)}
          disabled={isCompanion}
        />
        <VisibilityPicker
          icon="radio-button-on-outline"
          label="Status Updates"
          value={settings.statusVisibility}
          onChange={(v) => guardedUpdate('statusVisibility', v)}
          disabled={isCompanion}
        />
        <VisibilityPicker
          icon="people-outline"
          label="Add Me to Groups"
          value={settings.groups}
          onChange={(v) => guardedUpdate('groups', v)}
          disabled={isCompanion}
        />
        <VisibilityPicker
          icon="call-outline"
          label="Can Call Me"
          value={settings.calls}
          onChange={(v) => guardedUpdate('calls', v)}
          disabled={isCompanion}
        />

        {/* ── Messages ──────────────────────────────────────────────── */}
        <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>
          MESSAGES
        </AppText>

        <Row
          icon="checkmark-done-outline"
          label="Read Receipts"
          sub={
            settings.readReceipts
              ? "On \u2014 contacts see when you've read their messages"
              : "Off \u2014 read ticks won't be sent or received"
          }
          value={settings.readReceipts}
          disabled={isCompanion}
          onToggle={(v) => {
            if (isCompanion) {
              Alert.alert(
                'Managed on your primary device',
                'Read receipts belong to the account owner. Open ChitChat on the phone you signed in with to change them.',
              );
              return;
            }
            if (!v) {
              Alert.alert(
                'Turn off read receipts?',
                "You also won\u2019t be able to see when others have read your messages.",
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Turn Off', onPress: () => updateSetting('readReceipts', false) },
                ],
              );
            } else {
              updateSetting('readReceipts', true);
            }
          }}
        />

        <Row
          icon="timer-outline"
          label="Disappearing Messages"
          sub={
            settings.disappearingMessages
              ? 'On — messages delete after 72 hours'
              : 'Off — messages are kept indefinitely'
          }
          value={settings.disappearingMessages}
          disabled={isCompanion}
          onToggle={(v) => guardedUpdate('disappearingMessages', v)}
        />

        {/* ── Advanced ──────────────────────────────────────────────── */}
        <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>
          ADVANCED
        </AppText>

        {/* Blocked Contacts is a write-oriented screen; on a companion the
            item is hidden entirely so the user can't reach a dead-end. */}
        {!isCompanion && (
          <Row
            icon="ban-outline"
            label="Blocked Contacts"
            sub="Manage who can't contact you"
            onPress={() => navigation.navigate('BlockedContacts')}
          />
        )}

        <Row
          icon="phone-portrait-outline"
          label="Silence Unknown Callers"
          sub="Calls from unknown numbers are silenced automatically"
          disabled={isCompanion}
          onPress={() =>
            Alert.alert(
              'Silence Unknown Callers',
              'This feature requires a native build. It will be available in a future update.',
            )
          }
        />
      </ScrollView>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: Platform.OS === 'web' ? 16 : 52,
    paddingBottom: 12,
    paddingHorizontal: 14,
    borderBottomWidth: 1,
  },
  back:  {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)',
  },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },

  scroll: { paddingHorizontal: 14, paddingTop: 16, paddingBottom: 40, gap: 8 },

  sectionLabel: {
    fontSize: 10, fontWeight: '700', letterSpacing: 1.2,
    paddingHorizontal: 4, paddingBottom: 2, paddingTop: 8,
  },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: RADIUS.lg, paddingHorizontal: 14, paddingVertical: 13,
  },
  rowMeta:    { flex: 1 },
  rowLabel:   { fontSize: 14, fontWeight: '500' },
  rowSub:     { fontSize: 12, marginTop: 2 },
  rightLabel: { fontSize: 12, fontWeight: '600' },
  disabled:   { opacity: 0.45 },

  visRow: { flexDirection: 'row', gap: 4 },
  visBtn: {
    paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(90,127,160,0.15)',
  },
  visBtnActive: { backgroundColor: COLORS.blue },
  visTxt:       { fontSize: 11, fontWeight: '600' },

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