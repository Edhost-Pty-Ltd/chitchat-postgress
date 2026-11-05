// ─── Multi-agent Dashboard ───────────────────────────────────────────────────
// Replaces the previous single-user metrics dashboard. It is business-scoped:
// owners/admins can manage agents and inspect an agent dashboard; agents see
// their own company context, enrollment state, and availability. Company data
// is read from the owner by the backend and is never copied into agent profiles.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle,
  Rect,
  G,
  Text as SvgText,
  Defs,
  LinearGradient as SvgLinearGradient,
  Stop,
} from 'react-native-svg';

import { BottomNav, ScreenLayout } from '../components';
import AgentRegistrationSheet from '../components/AgentRegistrationSheet';
import AgentDashboardSheet from '../components/AgentDashboardSheet';
import { AppBg, AppIcon, AppText, useForeground, useGlass, useTypography } from '../context/ThemeContext';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import { useAuth } from '../context/AuthContext';
import { agentApi, type AgentAvailability, type TeamAgent, type TeamDashboard } from '../api/agentApi';
import { socketClient } from '../realtime/socket';

// Animated SVG primitives — react-native-svg exposes these so Animated can
// drive SVG props (stroke-dasharray, width, opacity), which is what makes the
// charts below genuinely animate instead of just appearing.
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedSvgText = Animated.createAnimatedComponent(SvgText);

type AvailabilityOption = { value: AgentAvailability | null; label: string; icon: string; color: string };
const AVAILABILITY: AvailabilityOption[] = [
  { value: 'available', label: 'Available', icon: 'checkmark-circle-outline', color: '#16A34A' },
  { value: 'busy', label: 'Busy', icon: 'remove-circle-outline', color: '#DC2626' },
  { value: 'away', label: 'Away', icon: 'time-outline', color: '#D97706' },
];

const PLAN_META: Record<'free' | 'pro' | 'enterprise', { label: string; color: string }> = {
  free: { label: 'Free plan', color: '#64748B' },
  pro: { label: 'Pro plan', color: '#7C3AED' },
  enterprise: { label: 'Enterprise', color: '#D97706' },
};

const ROLE_COLOR: Record<TeamAgent['role'], string> = {
  owner: '#D97706',
  admin: '#7C3AED',
  agent: COLORS.blue,
};

function humanize(value: string | null | undefined): string {
  if (!value) return 'Not set';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'TM';
}

/** Compact "3d ago" / "2mo ago" relative-time label for tenure/enrollment timestamps. */
function formatRelative(iso: string | null | undefined): string {
  if (!iso) return 'Not yet';
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const day = 86_400_000;
  if (diffMs < day) return 'Today';
  if (diffMs < 2 * day) return 'Yesterday';
  const days = Math.floor(diffMs / day);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function formatMonthYear(iso: string | null | undefined): string {
  if (!iso) return 'recently';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function formatAddress(address: Record<string, string> | null): string | null {
  if (!address) return null;
  const parts = Object.values(address).map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function formatScheduleSummary(schedule: Record<string, { open: string; close: string }> | null): string | null {
  if (!schedule) return null;
  const days = Object.keys(schedule).length;
  return days > 0 ? `Set for ${days} day${days === 1 ? '' : 's'} a week` : null;
}

export default function MultiAgentDashboardScreen() {
  const insets = useSafeAreaInsets();
  const { isCompanion, userId } = useAuth();
  const { FG } = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { bevel } = useGlass();

  const [dashboard, setDashboard] = useState<TeamDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<TeamAgent | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [faceRetryAgent, setFaceRetryAgent] = useState<TeamAgent | null>(null);
  const [updatingAvailability, setUpdatingAvailability] = useState(false);

  const load = useCallback(async () => {
    const result = await agentApi.getDashboard();
    if (!result.ok) {
      setError(result.error.message || 'Could not load your team dashboard.');
      return;
    }
    setDashboard(result.data.dashboard);
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void load().finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      void load();
      return undefined;
    }, [load]),
  );

  useEffect(() => {
    const unsubscribe = socketClient.subscribe('business:agents-updated', (raw) => {
      const payload = raw as { businessId?: string } | null;
      if (!payload?.businessId || payload.businessId === dashboard?.business.businessId) void load();
    });
    return unsubscribe;
  }, [dashboard?.business.businessId, load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  const updateAvailability = useCallback(async (status: AgentAvailability | null) => {
    if (!dashboard || updatingAvailability) return;
    setUpdatingAvailability(true);
    try {
      const result = await agentApi.setMyAvailability(dashboard.business.businessId, status);
      if (!result.ok) throw new Error(result.error.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update your availability.');
    } finally {
      setUpdatingAvailability(false);
    }
  }, [dashboard, load, updatingAvailability]);

  const canManage = !!dashboard?.viewer.canManageAgents && !isCompanion;
  const viewerAgent = dashboard?.agents.find((agent) => agent.agentId === userId) ?? null;
  const viewerIsActive = dashboard?.viewer.membershipStatus === 'active';
  const planMeta = PLAN_META[dashboard?.business.plan ?? 'free'];
  const addressSummary = dashboard ? formatAddress(dashboard.company.address) : null;
  const scheduleSummary = dashboard ? formatScheduleSummary(dashboard.company.workSchedule) : null;

  return (
    <ScreenLayout active="dashboard">
    <View style={styles.root}>
      <AppBg />
      <View style={[styles.header, { paddingTop: insets.top + 10, backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder }]}>
        <View style={styles.headerCopy}>
          <AppText style={[styles.title, { color: textColor, fontFamily }]}>Team dashboard</AppText>
          <AppText style={[styles.subtitle, { color: FG.secondary }]}>{dashboard?.company.businessName ?? 'Your business'}</AppText>
        </View>
        <TouchableOpacity style={styles.refreshButton} onPress={refresh} disabled={refreshing}>
          <AppIcon name="refresh-outline" size={20} color={COLORS.blue} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={COLORS.blue} /></View>
      ) : error && !dashboard ? (
        <View style={styles.center}>
          <AppIcon name="cloud-offline-outline" size={44} color={COLORS.blue} />
          <AppText style={[styles.errorTitle, { color: textColor }]}>Could not load team data</AppText>
          <AppText style={[styles.errorCopy, { color: FG.secondary }]}>{error}</AppText>
          <TouchableOpacity style={styles.retry} onPress={refresh}><AppText style={styles.retryText}>Retry</AppText></TouchableOpacity>
        </View>
      ) : dashboard ? (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={COLORS.blue} />}
          showsVerticalScrollIndicator={false}
        >
          {error ? <AppText style={styles.inlineError}>{error}</AppText> : null}

          <View style={[styles.companyHero, bevel]}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.companyMark}>
              <AppIcon name="business" size={27} color="#fff" fixedColor />
            </LinearGradient>
            <View style={styles.flex}>
              <View style={styles.companyNameLine}>
                <AppText style={[styles.companyName, { color: textColor, fontFamily }]} numberOfLines={1}>{dashboard.company.businessName}</AppText>
                <View style={[styles.planPill, { backgroundColor: `${planMeta.color}18` }]}>
                  <AppText style={[styles.planPillText, { color: planMeta.color }]}>{planMeta.label}</AppText>
                </View>
              </View>
              <AppText style={[styles.companyOwner, { color: FG.secondary }]}>
                Managed by {dashboard.company.ownerDisplayName ?? 'Business owner'} · since {formatMonthYear(dashboard.business.createdAt)}
              </AppText>
              <View style={styles.quickFactsRow}>
                {dashboard.company.industry ? (
                  <View style={styles.industryPill}><AppText style={styles.industryText}>{dashboard.company.industry}</AppText></View>
                ) : null}
                <View style={styles.quickFact}>
                  <AppIcon name="pricetags-outline" size={11} color={FG.secondary} />
                  <AppText style={[styles.quickFactText, { color: FG.secondary }]}>
                    {dashboard.company.catalogItemCount} item{dashboard.company.catalogItemCount === 1 ? '' : 's'}
                  </AppText>
                </View>
                <View style={styles.quickFact}>
                  <AppIcon name="git-network-outline" size={11} color={FG.secondary} />
                  <AppText style={[styles.quickFactText, { color: FG.secondary }]}>{humanize(dashboard.business.settings.routingStrategy)}</AppText>
                </View>
              </View>
            </View>
          </View>

          <View style={[styles.myWorkspace, bevel]}>
            <View style={styles.workspaceHeader}>
              <View>
                <AppText style={[styles.sectionTitle, { color: textColor }]}>My agent workspace</AppText>
                <AppText style={[styles.sectionSub, { color: FG.secondary }]}>{humanize(dashboard.viewer.role)} · {humanize(dashboard.viewer.membershipStatus)}</AppText>
              </View>
              <View style={[styles.faceState, viewerAgent?.faceEnrollmentStatus === 'enrolled' ? styles.faceStateGood : styles.faceStatePending]}>
                <AppIcon name={viewerAgent?.faceEnrollmentStatus === 'enrolled' ? 'shield-checkmark-outline' : 'time-outline'} size={16} color={viewerAgent?.faceEnrollmentStatus === 'enrolled' ? '#15803D' : '#B45309'} />
                <AppText style={[styles.faceStateText, { color: viewerAgent?.faceEnrollmentStatus === 'enrolled' ? '#15803D' : '#92400E' }]}>{viewerAgent?.faceEnrollmentStatus === 'enrolled' ? 'Face enrolled' : 'Face pending'}</AppText>
              </View>
            </View>
            {viewerAgent ? (
              <View style={styles.selfClientChip}>
                <AppIcon name="chatbubbles-outline" size={13} color={COLORS.blue} />
                <AppText style={[styles.selfClientText, { color: FG.secondary }]}>
                  Assisting {viewerAgent.clientCount} client conversation{viewerAgent.clientCount === 1 ? '' : 's'} right now
                </AppText>
              </View>
            ) : null}
            <AppText style={[styles.statusPrompt, { color: FG.secondary }]}>Set your availability for your team.</AppText>
            <View style={styles.availabilityRow}>
              {AVAILABILITY.map((option) => {
                const selected = dashboard.viewer.agentStatus === option.value;
                return (
                  <TouchableOpacity
                    key={option.value}
                    style={[styles.availability, selected && { borderColor: option.color, backgroundColor: `${option.color}14` }]}
                    onPress={() => updateAvailability(option.value)}
                    disabled={updatingAvailability || isCompanion || !viewerIsActive}
                  >
                    <AppIcon name={option.icon as any} size={17} color={option.color} />
                    <AppText style={[styles.availabilityText, { color: selected ? option.color : FG.secondary }]}>{option.label}</AppText>
                  </TouchableOpacity>
                );
              })}
            </View>
            {isCompanion ? <AppText style={[styles.companionNote, { color: FG.secondary }]}>Availability is managed on the agent’s primary device.</AppText> : !viewerIsActive ? <AppText style={[styles.companionNote, { color: '#92400E' }]}>Your manager must finish encrypted face enrollment before your agent access becomes active.</AppText> : null}
          </View>

          {canManage ? (
            <>
              <ClientConversationsHero total={dashboard.summary.totalClientConversations} />

              <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>TEAM OVERVIEW</AppText>
              <View style={styles.chartsRow}>
                <EnrollmentRing
                  enrolled={dashboard.summary.enrolledAgents}
                  total={dashboard.summary.totalAgents}
                  textColor={textColor}
                  fgSecondary={FG.secondary}
                  bevel={bevel}
                />
                <StatusDonut
                  agents={dashboard.agents}
                  textColor={textColor}
                  fgSecondary={FG.secondary}
                  bevel={bevel}
                />
              </View>
              <TeamBarsChart
                items={[
                  { label: 'Total', value: dashboard.summary.totalAgents, color: '#8B5CF6' },
                  { label: 'Active', value: dashboard.summary.activeAgents, color: '#16A34A' },
                  { label: 'Available', value: dashboard.summary.availableAgents, color: '#0891B2' },
                  { label: 'Enrolled', value: dashboard.summary.enrolledAgents, color: '#D97706' },
                ]}
                textColor={textColor}
                fgSecondary={FG.secondary}
                bevel={bevel}
              />

              <View style={styles.teamHeading}>
                <View>
                  <AppText style={[styles.sectionTitle, { color: textColor }]}>Your team</AppText>
                  <AppText style={[styles.sectionSub, { color: FG.secondary }]}>Tap a member to view their agent dashboard.</AppText>
                </View>
                <TouchableOpacity style={styles.addAgent} onPress={() => setRegistrationOpen(true)}>
                  <AppIcon name="person-add-outline" size={18} color="#fff" fixedColor />
                  <AppText fixedColor style={styles.addAgentText}>Add agent</AppText>
                </TouchableOpacity>
              </View>

              <View style={[styles.roster, bevel]}>
                {dashboard.agents.map((agent, index) => (
                  <AgentRosterCard
                    key={agent.agentId}
                    agent={agent}
                    isLast={index === dashboard.agents.length - 1}
                    onPress={() => setSelectedAgent(agent)}
                    textColor={textColor}
                    fgSecondary={FG.secondary}
                    glassBorder={FG.glassBorder}
                  />
                ))}
              </View>
            </>
          ) : (
            <View style={[styles.agentOnlyCard, bevel]}>
              <AppIcon name="briefcase-outline" size={21} color={COLORS.blue} />
              <View style={styles.flex}>
                <AppText style={[styles.inheritTitle, { color: textColor }]}>Your personal agent dashboard</AppText>
                <AppText style={[styles.inheritCopy, { color: FG.secondary }]}>You can see company context and update your own availability. Team roster and management information are visible only to business owners and admins.</AppText>
              </View>
            </View>
          )}

          <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>BUSINESS PROFILE</AppText>
          <View style={[styles.profileCard, bevel]}>
            <InfoLine icon="briefcase-outline" label="Industry" value={dashboard.company.industry ?? 'Not set'} textColor={textColor} fgSecondary={FG.secondary} />
            <InfoLine icon="mail-outline" label="Email" value={dashboard.company.email ?? 'Not set'} textColor={textColor} fgSecondary={FG.secondary} />
            <InfoLine icon="globe-outline" label="Website" value={dashboard.company.website ?? 'Not set'} textColor={textColor} fgSecondary={FG.secondary} />
            <InfoLine icon="time-outline" label="Hours" value={dashboard.company.operationalHours ?? scheduleSummary ?? 'Not set'} textColor={textColor} fgSecondary={FG.secondary} />
            {addressSummary ? <InfoLine icon="location-outline" label="Address" value={addressSummary} textColor={textColor} fgSecondary={FG.secondary} /> : null}
            <InfoLine
              icon="pricetags-outline"
              label="Catalog"
              value={`${dashboard.company.catalogItemCount} item${dashboard.company.catalogItemCount === 1 ? '' : 's'} · ${dashboard.company.catalogCollectionCount} collection${dashboard.company.catalogCollectionCount === 1 ? '' : 's'}`}
              textColor={textColor}
              fgSecondary={FG.secondary}
            />
            <InfoLine
              icon="git-network-outline"
              label="Chat routing"
              value={`${humanize(dashboard.business.settings.routingStrategy)}${dashboard.business.settings.autoAssign ? ' · auto-assign on' : ''}`}
              textColor={textColor}
              fgSecondary={FG.secondary}
            />
            {dashboard.company.about ? <InfoLine icon="information-circle-outline" label="About" value={dashboard.company.about} textColor={textColor} fgSecondary={FG.secondary} /> : null}
          </View>
          <AppText style={[styles.note, { color: FG.secondary }]}>Company details come from the business owner’s profile and stay consistent for every agent.</AppText>
        </ScrollView>
      ) : null}

      <AgentDashboardSheet
        visible={!!selectedAgent}
        agent={selectedAgent}
        dashboard={dashboard}
        canManage={canManage}
        onClose={() => setSelectedAgent(null)}
        onFinishFaceEnrollment={(agent) => {
          setSelectedAgent(null);
          setFaceRetryAgent(agent);
          setRegistrationOpen(true);
        }}
      />
      <AgentRegistrationSheet
        visible={registrationOpen}
        businessId={dashboard?.business.businessId ?? ''}
        existingAgent={faceRetryAgent}
        onClose={() => {
          setRegistrationOpen(false);
          setFaceRetryAgent(null);
        }}
        onSaved={() => {
          setRegistrationOpen(false);
          setFaceRetryAgent(null);
          void load();
        }}
      />
    </View>
    </ScreenLayout>
  );
}

// ─── ClientConversationsHero ────────────────────────────────────────────────
// The one genuinely new, team-wide number this dashboard surfaces: how many
// distinct client chats the team is actively assisting with, derived from
// real internal-note activity (see server getBusinessClientConversationTotal)
// rather than any placeholder figure. Styled as a gradient hero stat so the
// headline metric the owner actually asked for ("how many clients are they
// working on") reads as premium, not another grey tile.
function ClientConversationsHero({ total }: { total: number }) {
  const anim = useRef(new Animated.Value(0)).current;
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    anim.setValue(0);
    const id = anim.addListener(({ value }) => setDisplay(Math.round(value * total)));
    Animated.timing(anim, {
      toValue: 1,
      duration: 800,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    return () => anim.removeListener(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  return (
    <View style={[styles.clientHero, SHADOW.glow]}>
      <LinearGradient colors={GRADIENTS.primary} style={StyleSheet.absoluteFill} />
      <View style={styles.clientHeroIconWrap}>
        <AppIcon name="chatbubbles-outline" size={24} color="#fff" fixedColor />
      </View>
      <View style={styles.flex}>
        <AppText fixedColor style={styles.clientHeroValue}>{display}</AppText>
        <AppText fixedColor style={styles.clientHeroLabel}>
          {total === 1 ? 'Active client conversation' : 'Active client conversations'}
        </AppText>
        <AppText fixedColor style={styles.clientHeroSub}>Chats your team is actively assisting, business-wide</AppText>
      </View>
    </View>
  );
}

// ─── AgentRosterCard ─────────────────────────────────────────────────────────
// Each row now carries the detail the roster used to hide entirely: a role
// badge, live availability, how many clients this person is assisting, and
// how long they've been on the team — instead of a single "role · status" line.
function AgentRosterCard({
  agent, isLast, onPress, textColor, fgSecondary, glassBorder,
}: {
  agent: TeamAgent;
  isLast: boolean;
  onPress: () => void;
  textColor: string;
  fgSecondary: string;
  glassBorder: string;
}) {
  const statusMeta = AVAILABILITY.find((option) => option.value === agent.agentStatus);
  const roleColor = ROLE_COLOR[agent.role];

  return (
    <TouchableOpacity
      style={[styles.agentRow, !isLast && { borderBottomWidth: 1, borderBottomColor: glassBorder }]}
      onPress={onPress}
      activeOpacity={0.75}
    >
      <View style={[styles.agentAvatar, { backgroundColor: roleColor }]}>
        <AppText fixedColor style={styles.agentInitials}>{initials(agent.displayName)}</AppText>
      </View>
      <View style={styles.flex}>
        <View style={styles.agentNameLine}>
          <AppText style={[styles.agentName, { color: textColor }]} numberOfLines={1}>{agent.displayName}</AppText>
          <View style={[styles.rolePill, { backgroundColor: `${roleColor}18` }]}>
            <AppText style={[styles.rolePillText, { color: roleColor }]}>{humanize(agent.role)}</AppText>
          </View>
        </View>
        <View style={styles.agentMetaRow}>
          <View style={styles.metaChip}>
            <View style={[styles.metaDot, { backgroundColor: statusMeta?.color ?? '#94A3B8' }]} />
            <AppText style={[styles.agentMeta, { color: fgSecondary }]}>{statusMeta?.label ?? 'Not set'}</AppText>
          </View>
          <View style={styles.metaChip}>
            <AppIcon name="chatbubbles-outline" size={11} color={fgSecondary} />
            <AppText style={[styles.agentMeta, { color: fgSecondary }]}>{agent.clientCount} client{agent.clientCount === 1 ? '' : 's'}</AppText>
          </View>
          <View style={styles.metaChip}>
            <AppIcon name="calendar-outline" size={11} color={fgSecondary} />
            <AppText style={[styles.agentMeta, { color: fgSecondary }]}>{formatRelative(agent.addedAt)}</AppText>
          </View>
        </View>
      </View>
      <View style={[styles.enrollmentDot, agent.faceEnrollmentStatus === 'enrolled' ? styles.enrolledDot : styles.pendingDot]} />
      <AppIcon name="chevron-forward" size={18} color={fgSecondary} />
    </TouchableOpacity>
  );
}

// ─── InfoLine ────────────────────────────────────────────────────────────────
// A single icon + label + value row for the business-profile card below.
function InfoLine({
  icon, label, value, textColor, fgSecondary,
}: {
  icon: any;
  label: string;
  value: string;
  textColor: string;
  fgSecondary: string;
}) {
  return (
    <View style={styles.infoLine}>
      <AppIcon name={icon} size={16} color={COLORS.blue} />
      <View style={styles.flex}>
        <AppText style={[styles.infoLineLabel, { color: fgSecondary }]}>{label}</AppText>
        <AppText style={[styles.infoLineValue, { color: textColor }]}>{value}</AppText>
      </View>
    </View>
  );
}

// ─── EnrollmentRing ──────────────────────────────────────────────────────────
// Single-arc animated progress ring: the share of the team that has completed
// encrypted face enrollment. The arc draws in and the center percentage counts
// up in sync, rather than showing a flat "N enrolled" number.
function EnrollmentRing({
  enrolled, total, textColor, fgSecondary, bevel,
}: {
  enrolled: number;
  total: number;
  textColor: string;
  fgSecondary: string;
  bevel: any;
}) {
  const size = 128;
  const strokeWidth = 14;
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const pct = total > 0 ? enrolled / total : 0;
  const pctLabel = Math.round(pct * 100);
  const color = pct >= 0.75 ? '#16A34A' : pct >= 0.4 ? '#D97706' : '#DC2626';

  const anim = useRef(new Animated.Value(0)).current;
  const [displayPct, setDisplayPct] = useState(0);

  useEffect(() => {
    anim.setValue(0);
    const id = anim.addListener(({ value }) => setDisplayPct(Math.round(value * pctLabel)));
    Animated.timing(anim, {
      toValue: 1,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    return () => anim.removeListener(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enrolled, total]);

  const dash = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [`0 ${circumference}`, `${circumference * pct} ${circumference}`],
  });

  return (
    <View style={[styles.ringCard, bevel]}>
      <AppText style={[styles.chartTitle, { color: textColor }]}>Face enrollment</AppText>
      <AppText style={[styles.chartSub, { color: fgSecondary }]}>Ready for secure recovery</AppText>
      <View style={styles.ringBody}>
        <Svg width={size} height={size}>
          <Circle cx={cx} cy={cy} r={r} stroke="rgba(148,163,184,0.18)" strokeWidth={strokeWidth} fill="none" />
          <G rotation="-90" origin={`${cx}, ${cy}`}>
            <AnimatedCircle
              cx={cx} cy={cy} r={r}
              stroke={color}
              strokeWidth={strokeWidth}
              strokeDasharray={dash}
              strokeLinecap="round"
              fill="none"
            />
          </G>
          <SvgText x={cx} y={cy + 7} fontSize="23" fontWeight="800" fill={textColor} textAnchor="middle">
            {`${displayPct}%`}
          </SvgText>
        </Svg>
        <AppText style={[styles.ringFootnote, { color: fgSecondary }]}>
          {enrolled} of {total} agent{total === 1 ? '' : 's'}
        </AppText>
      </View>
    </View>
  );
}

// ─── StatusDonut ─────────────────────────────────────────────────────────────
// Multi-segment donut breaking the roster down by live availability. Segments
// draw in sequence on mount so the ring visibly fills rather than popping in.
function StatusDonut({
  agents, textColor, fgSecondary, bevel,
}: {
  agents: TeamAgent[];
  textColor: string;
  fgSecondary: string;
  bevel: any;
}) {
  const size = 128;
  const strokeWidth = 14;
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * r;
  const total = agents.length;

  const segments = useMemo(() => {
    const buckets = [
      { key: 'available', label: 'Available', color: '#16A34A', count: 0 },
      { key: 'busy', label: 'Busy', color: '#DC2626', count: 0 },
      { key: 'away', label: 'Away', color: '#D97706', count: 0 },
      { key: 'unset', label: 'Not set', color: '#94A3B8', count: 0 },
    ];
    agents.forEach((a) => {
      const bucket = buckets.find((b) => b.key === (a.agentStatus ?? 'unset'));
      if (bucket) bucket.count++;
    });
    return buckets.filter((b) => b.count > 0);
  }, [agents]);

  const anims = useRef(segments.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (anims.length !== segments.length) {
      anims.length = 0;
      segments.forEach(() => anims.push(new Animated.Value(0)));
    }
    Animated.stagger(
      150,
      anims.map((v) =>
        Animated.timing(v, {
          toValue: 1,
          duration: 520,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ),
    ).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments.length, total]);

  let cumulativePct = 0;
  const arcs = segments.map((seg, i) => {
    const pct = total > 0 ? seg.count / total : 0;
    const offsetDeg = cumulativePct * 360;
    cumulativePct += pct;
    const dash = anims[i].interpolate({
      inputRange: [0, 1],
      outputRange: [`0 ${circumference}`, `${circumference * pct} ${circumference}`],
    });
    return { seg, dash, offsetDeg };
  });

  return (
    <View style={[styles.ringCard, bevel]}>
      <AppText style={[styles.chartTitle, { color: textColor }]}>Team status</AppText>
      <AppText style={[styles.chartSub, { color: fgSecondary }]}>Right now</AppText>
      <View style={styles.ringBody}>
        <Svg width={size} height={size}>
          <Circle cx={cx} cy={cy} r={r} stroke="rgba(148,163,184,0.18)" strokeWidth={strokeWidth} fill="none" />
          {arcs.map(({ seg, dash, offsetDeg }) => (
            <G key={seg.key} rotation={offsetDeg - 90} origin={`${cx}, ${cy}`}>
              <AnimatedCircle
                cx={cx} cy={cy} r={r}
                stroke={seg.color}
                strokeWidth={strokeWidth}
                strokeDasharray={dash}
                fill="none"
              />
            </G>
          ))}
          <SvgText x={cx} y={cy + 6} fontSize="21" fontWeight="800" fill={textColor} textAnchor="middle">
            {String(total)}
          </SvgText>
        </Svg>
        <View style={styles.legendWrap}>
          {segments.map((seg) => (
            <View key={seg.key} style={styles.legendItem}>
              <View style={[styles.legendDotSm, { backgroundColor: seg.color }]} />
              <AppText style={[styles.legendText, { color: fgSecondary }]}>{seg.label} · {seg.count}</AppText>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// ─── TeamBarsChart ───────────────────────────────────────────────────────────
// Horizontal animated bar chart. Turns the four roster counters into a
// comparative, proportional visual instead of a flat number grid — each bar
// grows in and its value fades in once the bar has finished growing.
function TeamBarsChart({
  items, textColor, fgSecondary, bevel,
}: {
  items: { label: string; value: number; color: string }[];
  textColor: string;
  fgSecondary: string;
  bevel: any;
}) {
  const svgWidth = Dimensions.get('window').width - 32 - 30; // scroll padding + card padding
  const labelW = 78;
  const valueW = 36;
  const trackW = Math.max(svgWidth - labelW - valueW, 40);
  const barHeight = 10;
  const rowH = 30;
  const maxValue = Math.max(...items.map((i) => i.value), 1);

  const anims = useRef(items.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (anims.length !== items.length) {
      anims.length = 0;
      items.forEach(() => anims.push(new Animated.Value(0)));
    }
    Animated.stagger(
      90,
      anims.map((v) =>
        Animated.timing(v, {
          toValue: 1,
          duration: 650,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ),
    ).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((i) => i.value).join(',')]);

  return (
    <View style={[styles.barsCard, bevel]}>
      <AppText style={[styles.chartTitle, { color: textColor }]}>Roster breakdown</AppText>
      <AppText style={[styles.chartSub, { color: fgSecondary, marginBottom: 10 }]}>Compared side by side</AppText>
      <Svg width={svgWidth} height={items.length * rowH}>
        <Defs>
          {items.map((item, i) => (
            <SvgLinearGradient key={item.label} id={`teamBarGrad${i}`} x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={item.color} stopOpacity="0.5" />
              <Stop offset="1" stopColor={item.color} stopOpacity="1" />
            </SvgLinearGradient>
          ))}
        </Defs>
        {items.map((item, i) => {
          const y = i * rowH;
          const targetW = item.value > 0 ? Math.max((item.value / maxValue) * trackW, 6) : 0;
          const animatedW = anims[i].interpolate({ inputRange: [0, 1], outputRange: [0, targetW] });
          const numOpacity = anims[i].interpolate({ inputRange: [0, 0.55, 1], outputRange: [0, 0, 1] });
          return (
            <G key={item.label}>
              <SvgText x={0} y={y + barHeight + 1} fontSize="11.5" fontWeight="700" fill={fgSecondary}>
                {item.label}
              </SvgText>
              <Rect x={labelW} y={y} width={trackW} height={barHeight} rx={barHeight / 2} fill="rgba(148,163,184,0.16)" />
              {item.value > 0 && (
                <AnimatedRect
                  x={labelW}
                  y={y}
                  width={animatedW}
                  height={barHeight}
                  rx={barHeight / 2}
                  fill={`url(#teamBarGrad${i})`}
                />
              )}
              <AnimatedSvgText
                x={labelW + trackW + 10}
                y={y + barHeight}
                fontSize="12.5"
                fontWeight="800"
                fill={textColor}
                opacity={numOpacity}
              >
                {String(item.value)}
              </AnimatedSvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  header: { minHeight: 66, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, borderBottomWidth: 1 },
  headerCopy: { flex: 1 },
  title: { fontSize: 22, fontWeight: '800' },
  subtitle: { marginTop: 2, fontSize: 12.5 },
  refreshButton: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 20, backgroundColor: 'rgba(9,178,238,0.10)' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 12 },
  errorTitle: { fontSize: 18, fontWeight: '800' },
  errorCopy: { textAlign: 'center', fontSize: 13.5, lineHeight: 20 },
  retry: { marginTop: 8, backgroundColor: COLORS.blue, borderRadius: RADIUS.md, paddingHorizontal: 22, paddingVertical: 12 },
  retryText: { color: '#fff', fontWeight: '800' },
  scroll: { padding: 16, gap: 13 },
  inlineError: { color: '#B91C1C', backgroundColor: '#FEE2E2', borderRadius: RADIUS.sm, padding: 10, fontSize: 12.5 },
  companyHero: { flexDirection: 'row', alignItems: 'center', gap: 13, borderRadius: RADIUS.lg, padding: 16 },
  companyMark: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  companyNameLine: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  companyName: { fontSize: 18, fontWeight: '800', flexShrink: 1 },
  companyOwner: { fontSize: 12.5, marginTop: 3 },
  planPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.full },
  planPillText: { fontSize: 10, fontWeight: '800' },
  quickFactsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 8 },
  industryPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.full, backgroundColor: 'rgba(9,178,238,0.12)' },
  industryText: { color: COLORS.blue, fontSize: 10.5, fontWeight: '800' },
  quickFact: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  quickFactText: { fontSize: 10.5, fontWeight: '700' },
  myWorkspace: { borderRadius: RADIUS.lg, padding: 15 },
  workspaceHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  sectionTitle: { fontSize: 16, fontWeight: '800' },
  sectionSub: { fontSize: 12, marginTop: 3 },
  faceState: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: RADIUS.full, paddingHorizontal: 7, paddingVertical: 4 },
  faceStateGood: { backgroundColor: '#DCFCE7' },
  faceStatePending: { backgroundColor: '#FEF3C7' },
  faceStateText: { fontSize: 10.5, fontWeight: '800' },
  selfClientChip: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  selfClientText: { fontSize: 12, fontWeight: '600' },
  statusPrompt: { fontSize: 12.5, marginTop: 12, marginBottom: 9 },
  availabilityRow: { flexDirection: 'row', gap: 7 },
  availability: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', gap: 3, borderWidth: 1, borderColor: 'rgba(148,163,184,0.36)', borderRadius: RADIUS.md },
  availabilityText: { fontSize: 10.5, fontWeight: '700' },
  companionNote: { fontSize: 11.5, marginTop: 9 },
  sectionLabel: { fontSize: 10.5, fontWeight: '800', letterSpacing: 1, marginTop: 4, paddingHorizontal: 3 },
  clientHero: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: RADIUS.lg, padding: 18, overflow: 'hidden' },
  clientHeroIconWrap: { width: 46, height: 46, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.22)' },
  clientHeroValue: { fontSize: 30, fontWeight: '800', color: '#fff' },
  clientHeroLabel: { fontSize: 13, fontWeight: '800', color: '#fff', marginTop: 1 },
  clientHeroSub: { fontSize: 11, color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  chartsRow: { flexDirection: 'row', gap: 9 },
  ringCard: { flex: 1, borderRadius: RADIUS.lg, padding: 14 },
  chartTitle: { fontSize: 13.5, fontWeight: '800' },
  chartSub: { fontSize: 11, marginTop: 2 },
  ringBody: { alignItems: 'center', marginTop: 8 },
  ringFootnote: { fontSize: 11, fontWeight: '700', marginTop: 8 },
  legendWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 10, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDotSm: { width: 7, height: 7, borderRadius: 3.5 },
  legendText: { fontSize: 10, fontWeight: '600' },
  barsCard: { borderRadius: RADIUS.lg, padding: 15, marginTop: 2 },
  teamHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  addAgent: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: RADIUS.md, backgroundColor: COLORS.blue, paddingHorizontal: 12, paddingVertical: 10, ...SHADOW.button },
  addAgentText: { color: '#fff', fontSize: 12.5, fontWeight: '800' },
  roster: { borderRadius: RADIUS.lg, overflow: 'hidden' },
  agentRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 13, paddingVertical: 11 },
  agentAvatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  agentInitials: { color: '#fff', fontWeight: '800', fontSize: 13 },
  agentNameLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  agentName: { fontSize: 14.5, fontWeight: '800', maxWidth: 140 },
  rolePill: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: RADIUS.full },
  rolePillText: { fontSize: 9.5, fontWeight: '800' },
  agentMetaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 5 },
  metaChip: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaDot: { width: 7, height: 7, borderRadius: 3.5 },
  agentMeta: { fontSize: 11.5 },
  enrollmentDot: { width: 9, height: 9, borderRadius: 4.5 },
  enrolledDot: { backgroundColor: '#16A34A' },
  pendingDot: { backgroundColor: '#D97706' },
  profileCard: { borderRadius: RADIUS.lg, padding: 15, gap: 14 },
  infoLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  infoLineLabel: { fontSize: 11.5, marginBottom: 2 },
  infoLineValue: { fontSize: 13.5, lineHeight: 19 },
  note: { fontSize: 12, lineHeight: 18, paddingHorizontal: 3 },
  inheritTitle: { fontSize: 14, fontWeight: '800', marginBottom: 4 },
  inheritCopy: { fontSize: 12.5, lineHeight: 18 },
  agentOnlyCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, borderRadius: RADIUS.lg, padding: 15, marginTop: 3 },
});
