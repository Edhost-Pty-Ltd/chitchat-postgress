// ─── Agent dashboard sheet ───────────────────────────────────────────────────
// Owners/admins use this to inspect a team member; agents see the same company
// context in the main dashboard but never get manager-only controls or other
// staff phone numbers.

import React from 'react';
import { Modal, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppBg, AppIcon, AppText, useForeground, useGlass, useTypography } from '../context/ThemeContext';
import { COLORS, RADIUS } from '../types/theme';
import type { TeamAgent, TeamDashboard } from '../api/agentApi';

interface Props {
  visible: boolean;
  agent: TeamAgent | null;
  dashboard: TeamDashboard | null;
  canManage: boolean;
  onClose: () => void;
  onFinishFaceEnrollment?: (agent: TeamAgent) => void;
}

function humanize(value: string | null | undefined): string {
  if (!value) return 'Not set';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default function AgentDashboardSheet({
  visible,
  agent,
  dashboard,
  canManage,
  onClose,
  onFinishFaceEnrollment,
}: Props) {
  const { FG } = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { bevel } = useGlass();
  if (!agent || !dashboard) return null;

  const company = dashboard.company;
  const facePending = agent.faceEnrollmentStatus !== 'enrolled';

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.root}>
        <AppBg />
        <View style={[styles.header, { backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder }]}>
          <TouchableOpacity style={styles.close} onPress={onClose}>
            <AppIcon name="close" size={22} color={COLORS.blue} />
          </TouchableOpacity>
          <AppText style={[styles.title, { color: textColor, fontFamily }]}>Agent dashboard</AppText>
          <View style={styles.close} />
        </View>

        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={[styles.hero, bevel]}>
            <View style={styles.avatar}>
              <AppText fixedColor style={styles.initials}>{agent.displayName.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()}</AppText>
            </View>
            <View style={styles.heroCopy}>
              <AppText style={[styles.name, { color: textColor, fontFamily }]}>{agent.displayName}</AppText>
              <AppText style={[styles.role, { color: FG.secondary }]}>{humanize(agent.role)} · {humanize(agent.membershipStatus)}</AppText>
              {agent.phoneNumber ? <AppText style={[styles.phone, { color: FG.secondary }]}>{agent.phoneNumber}</AppText> : null}
            </View>
          </View>

          <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>AGENT STATUS</AppText>
          <View style={[styles.statusGrid, bevel]}>
            <StatusItem icon="pulse-outline" label="Availability" value={humanize(agent.agentStatus)} color={COLORS.blue} />
            <StatusItem
              icon={facePending ? 'time-outline' : 'shield-checkmark-outline'}
              label="Face enrollment"
              value={facePending ? 'Pending' : 'Encrypted'}
              color={facePending ? '#D97706' : '#16A34A'}
            />
            <StatusItem icon="person-outline" label="Company role" value={humanize(agent.role)} color="#8B5CF6" />
            <StatusItem icon="calendar-outline" label="Added" value={new Date(agent.addedAt).toLocaleDateString()} color="#0891B2" />
            <StatusItem
              icon="chatbubbles-outline"
              label="Client conversations"
              value={`${agent.clientCount} active`}
              color={COLORS.blue}
            />
          </View>

          {canManage && facePending && onFinishFaceEnrollment ? (
            <TouchableOpacity style={[styles.finishButton, bevel]} onPress={() => onFinishFaceEnrollment(agent)}>
              <AppIcon name="scan-outline" size={20} color="#fff" fixedColor />
              <AppText fixedColor style={styles.finishText}>Finish encrypted face enrollment</AppText>
            </TouchableOpacity>
          ) : null}

          <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>INHERITED COMPANY DETAILS</AppText>
          <View style={[styles.companyCard, bevel]}>
            <InfoRow icon="business-outline" label="Company" value={company.businessName} />
            {company.industry ? <InfoRow icon="briefcase-outline" label="Industry" value={company.industry} /> : null}
            {company.email ? <InfoRow icon="mail-outline" label="Email" value={company.email} /> : null}
            {company.website ? <InfoRow icon="globe-outline" label="Website" value={company.website} /> : null}
            {company.operationalHours ? <InfoRow icon="time-outline" label="Hours" value={company.operationalHours} /> : null}
            {company.about ? <InfoRow icon="information-circle-outline" label="About" value={company.about} /> : null}
          </View>
          <AppText style={[styles.note, { color: FG.secondary }]}>Company details come from the business owner’s profile. They are not copied into the agent account, so company changes remain consistent for the whole team.</AppText>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function StatusItem({ icon, label, value, color }: { icon: any; label: string; value: string; color: string }) {
  const { FG } = useForeground();
  const { textColor } = useTypography();
  return (
    <View style={styles.statusItem}>
      <AppIcon name={icon} size={19} color={color} />
      <AppText style={[styles.statusLabel, { color: FG.secondary }]}>{label}</AppText>
      <AppText style={[styles.statusValue, { color: textColor }]} numberOfLines={1}>{value}</AppText>
    </View>
  );
}

function InfoRow({ icon, label, value }: { icon: any; label: string; value: string }) {
  const { FG } = useForeground();
  const { textColor } = useTypography();
  return (
    <View style={styles.infoRow}>
      <AppIcon name={icon} size={17} color={COLORS.blue} />
      <View style={styles.heroCopy}>
        <AppText style={[styles.infoLabel, { color: FG.secondary }]}>{label}</AppText>
        <AppText style={[styles.infoValue, { color: textColor }]}>{value}</AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderBottomWidth: 1 },
  close: { width: 38, height: 38, justifyContent: 'center', alignItems: 'center' },
  title: { flex: 1, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  scroll: { padding: 16, gap: 10, paddingBottom: 38 },
  hero: { flexDirection: 'row', gap: 14, alignItems: 'center', padding: 16, borderRadius: RADIUS.lg },
  avatar: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.blue },
  initials: { color: '#fff', fontSize: 22, fontWeight: '800' },
  heroCopy: { flex: 1 },
  name: { fontSize: 19, fontWeight: '800' },
  role: { fontSize: 13, marginTop: 3 },
  phone: { fontSize: 12.5, marginTop: 3 },
  sectionLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, marginTop: 8, paddingHorizontal: 3 },
  statusGrid: { flexDirection: 'row', flexWrap: 'wrap', borderRadius: RADIUS.lg, padding: 8 },
  statusItem: { width: '50%', minHeight: 88, padding: 10, gap: 4 },
  statusLabel: { fontSize: 11.5 },
  statusValue: { fontSize: 13.5, fontWeight: '700' },
  finishButton: { marginTop: 6, backgroundColor: COLORS.blue, minHeight: 52, borderRadius: RADIUS.md, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  finishText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  companyCard: { borderRadius: RADIUS.lg, padding: 15, gap: 14 },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  infoLabel: { fontSize: 11.5, marginBottom: 2 },
  infoValue: { fontSize: 13.5, lineHeight: 19 },
  note: { fontSize: 12, lineHeight: 18, paddingHorizontal: 3 },
});
