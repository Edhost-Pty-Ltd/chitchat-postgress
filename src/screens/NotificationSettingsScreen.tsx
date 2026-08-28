// ─── Screen: Notification Settings ──────────────────────────────────────────
import React, { useState } from 'react';
import { View, Switch, TouchableOpacity, StyleSheet, ScrollView, Alert, Platform } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS } from '../types/theme';
import { RootStackParamList } from '../types';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'NotificationSettings'>;

function Row({ icon, label, sub, value, onToggle, onPress, rightLabel }: {
  icon: string; label: string; sub?: string;
  value?: boolean; onToggle?: (v: boolean) => void;
  onPress?: () => void; rightLabel?: string;
}) {
  const { FG } = useForeground();
  const { fontFamily, textColor, iconColor } = useTypography();
  const { bevel } = useGlass();
  return (
    <TouchableOpacity
      style={[styles.row, bevel]}
      onPress={onPress} activeOpacity={onPress ? 0.75 : 1}
    >
      <AppIcon glass tileSize={38} name={icon as any} size={18} color={iconColor} />
      <View style={styles.rowMeta}>
        <AppText style={[styles.rowLabel, { color: textColor, fontFamily }]}>{label}</AppText>
        {sub ? <AppText style={[styles.rowSub, { color: FG.secondary }]}>{sub}</AppText> : null}
      </View>
      {onToggle != null
        ? <Switch value={value} onValueChange={onToggle} trackColor={{ true: COLORS.blue }} />
        : rightLabel
          ? <AppText style={[styles.rightLabel, { color: FG.secondary }]}>{rightLabel}</AppText>
          : onPress ? <AppIcon name="chevron-forward" size={16} color={FG.secondary} /> : null}
    </TouchableOpacity>
  );
}

export default function NotificationSettingsScreen() {
  const navigation = useNavigation<NavProp>();
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const insets = useSafeAreaInsets();

  // Messages
  const [msgNotifs,    setMsgNotifs]    = useState(true);
  const [msgVibrate,   setMsgVibrate]   = useState(true);
  const [msgSound,     setMsgSound]     = useState(true);

  // Groups
  const [groupNotifs,  setGroupNotifs]  = useState(true);
  const [groupVibrate, setGroupVibrate] = useState(false);

  // Calls
  const [callNotifs,   setCallNotifs]   = useState(true);
  const [ringtoneSel,  setRingtoneSel]  = useState('Default');

  return (
    <View style={styles.root}>
      <AppBg />
      <View style={[styles.header, { backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder, paddingTop: Platform.OS === 'web' ? 16 : insets.top + 12 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <AppIcon name="chevron-back" size={26} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>Notifications</AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* ── Messages ─────────────────────────────────────────────── */}
        <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>MESSAGES</AppText>
        <Row
          icon="chatbubble-outline"
          label="Message Notifications"
          sub={msgNotifs ? 'Enabled' : 'Disabled'}
          value={msgNotifs}
          onToggle={setMsgNotifs}
        />
        {msgNotifs && (
          <>
            <Row
              icon="volume-high-outline"
              label="Notification Sound"
              sub={msgSound ? 'Default' : 'Silent'}
              value={msgSound}
              onToggle={setMsgSound}
            />
            <Row
              icon="phone-portrait-outline"
              label="Vibrate"
              sub={msgVibrate ? 'Vibrate with notification' : 'No vibration'}
              value={msgVibrate}
              onToggle={setMsgVibrate}
            />
          </>
        )}

        {/* ── Groups ───────────────────────────────────────────────── */}
        <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>GROUPS</AppText>
        <Row
          icon="people-outline"
          label="Group Notifications"
          sub={groupNotifs ? 'Enabled' : 'Disabled'}
          value={groupNotifs}
          onToggle={setGroupNotifs}
        />
        {groupNotifs && (
          <Row
            icon="phone-portrait-outline"
            label="Vibrate"
            value={groupVibrate}
            onToggle={setGroupVibrate}
          />
        )}

        {/* ── Calls ────────────────────────────────────────────────── */}
        <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>CALLS</AppText>
        <Row
          icon="call-outline"
          label="Incoming Calls"
          sub={callNotifs ? 'Ringtone & notification' : 'Silent'}
          value={callNotifs}
          onToggle={setCallNotifs}
        />
        <Row
          icon="musical-notes-outline"
          label="Ringtone"
          sub={ringtoneSel}
          onPress={() => Alert.alert('Ringtone', 'Choose a ringtone from system sounds.')}
        />

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 0,
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
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    paddingHorizontal: 4,
    paddingBottom: 2,
    paddingTop: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  rowMeta:    { flex: 1 },
  rowLabel:   { fontSize: 14, fontWeight: '500' },
  rowSub:     { fontSize: 12, marginTop: 2 },
  rightLabel: { fontSize: 12, fontWeight: '600' },
});
