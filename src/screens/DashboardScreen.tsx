// ─── Screen: Dashboard ───────────────────────────────────────────────────────
//
// Live business analytics. Subscribes to users/{ownerUid} in real-time so
// counters (profile views, message stats, catalog counts) update the moment
// they change on the server. Chat-based metrics (total chats, unread, direct
// vs group split) are derived live from the existing useChats stream.
//
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  View, ScrollView, StyleSheet, TouchableOpacity, Image,
  RefreshControl, Dimensions, Animated, Easing,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Circle, Rect, G, Text as SvgText, Defs,
  LinearGradient as SvgLinearGradient, Stop,
} from 'react-native-svg';
import { endpoints } from '../api/endpoints';
import { useAuth } from '../context/AuthContext';
import { useChats } from '../hooks/useChats';
import { BottomNav } from '../components';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList } from '../types';
import {
  AppBg, AppText, AppIcon, useForeground, useTypography, useGlass,
} from '../context/ThemeContext';
import { useMessageAnalytics, deliveryRate, readRate } from '../hooks/useMessageAnalytics';
import { INDUSTRY_CATEGORIES } from '../types';
import IdentityVerificationBadge from '../components/IdentityVerificationBadge';
import { socketClient } from '../realtime/socket';

type NavProp = NativeStackNavigationProp<RootStackParamList>;

// Animated SVG primitives — react-native-svg exposes these so we can drive
// SVG props (heights, stroke dashes, opacities) with Animated values.
const AnimatedRect   = Animated.createAnimatedComponent(Rect);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedSvgText = Animated.createAnimatedComponent(SvgText);

interface UserProfile {
  displayName?:    string;
  email?:          string;
  website?:        string;
  phone?:          string;
  photoURL?:       string;
  catalog?:        any[];
  collections?:    any[];
  workSchedule?:   Record<string, { open: string; close: string }>;
  profileViews?:       number;
  profileViewsToday?:  number;
  profileViewsResetAt?: any;
  identityVerified?: boolean;
  identityVerifiedAt?: string | null;
  // Enhanced profile fields
  industry?:       string;
  description?:    string;
  address?: {
    street?: string; city?: string; province?: string;
    postalCode?: string; country?: string;
  };
  stats?: {
    messagesReceived?: number;
    profileViews?:     number;
  };
}

// ─── Chart day cell ──────────────────────────────────────────────────────────
interface DayCell {
  label: string;   // single-letter weekday label
  count: number;   // active chats that day
  date:  Date;     // start-of-day
}

// ─── FadeSlideIn ─────────────────────────────────────────────────────────────
// Small wrapper that fades a section in and slides it up gently on mount.
// `delay` lets us stagger sections so the page builds top-to-bottom.
function FadeSlideIn({
  children, delay = 0, style,
}: {
  children: React.ReactNode;
  delay?: number;
  style?: any;
}) {
  const opacity    = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(14)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 550,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(translateY, {
        toValue: 0,
        duration: 550,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [delay, opacity, translateY]);

  return (
    <Animated.View style={[style, { opacity, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

export default function DashboardScreen() {
  const navigation = useNavigation<NavProp>();
  const insets     = useSafeAreaInsets();

  const { userId, phone, displayName, avatarUri } = useAuth();
  const { chats } = useChats(userId);

  const { FG }                    = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel }                 = useGlass();

  const [profile,    setProfile]    = useState<UserProfile | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // ── Message analytics (server-computed) ───────────────────────────────────
  const { stats: msgStats, refreshStats } = useMessageAnalytics(userId);

  // ── Load the owner's business profile + profile-view counters ─────────────
  // Replaces the Firestore users/{uid} snapshot. /me carries the business
  // profile as first-class fields (catalogItems, catalogCollections, industry,
  // address, workSchedule; `about` is the business description). Profile-view
  // counters come from /me/profile-views.
  const loadProfile = useCallback(async () => {
    if (!userId) { return; }
    try {
      const [meRes, viewsRes] = await Promise.all([
        endpoints.getMe(),
        endpoints.getProfileViews(),
      ]);
      if (meRes.ok) {
        const me = meRes.data;
        setProfile({
          displayName:  me.displayName ?? undefined,
          email:        me.email ?? undefined,
          website:      me.website ?? undefined,
          phone:        me.phoneNumber ?? undefined,
          catalog:      me.catalogItems ?? [],
          collections:  me.catalogCollections ?? [],
          industry:     me.industry ?? undefined,
          description:  me.about ?? undefined,
          address:      me.address ?? undefined,
          workSchedule: me.workSchedule ?? undefined,
          identityVerified: me.identityVerified,
          identityVerifiedAt: me.identityVerifiedAt,
          profileViews: viewsRes.ok ? viewsRes.data.profileViews : 0,
          profileViewsToday: viewsRes.ok ? viewsRes.data.profileViewsToday : 0,
        });
      } else {
        setProfile(null);
      }
    } catch (err) {
      console.warn('[Dashboard] profile load error:', err);
    }
  }, [userId]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (!userId) return;
    return socketClient.subscribe('user:identity-status', (raw) => {
      const payload = raw as { userId?: string; identityVerified?: boolean; verifiedAt?: string | null } | null;
      if (payload?.userId !== userId || typeof payload.identityVerified !== 'boolean') return;
      setProfile((current) => current
        ? {
            ...current,
            identityVerified: payload.identityVerified!,
            identityVerifiedAt: payload.verifiedAt ?? null,
          }
        : current);
    });
  }, [userId]);

  // ── Chat-based live analytics ─────────────────────────────────────────────
  const analytics = useMemo(() => {
    const totalChats = chats.length;
    let totalUnread  = 0;
    let directChats  = 0;
    let groupChats   = 0;
    let totalMessages = 0;

    chats.forEach((c) => {
      totalUnread += c.unreadCount || 0;
      if (c.type === 'group') groupChats++; else directChats++;
      const mc = (c as any).messageCount;
      if (typeof mc === 'number') totalMessages += mc;
    });

    return { totalChats, totalUnread, directChats, groupChats, totalMessages };
  }, [chats]);

  // ── Weekly activity — real data from each chat's last-message timestamp ───
  // Groups chats whose last activity fell on each of the last 7 days.
  const weeklyActivity = useMemo((): DayCell[] => {
    const WEEK_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const days: DayCell[] = [];
    const now = new Date();

    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      d.setHours(0, 0, 0, 0);
      days.push({
        label: WEEK_LABELS[d.getDay()],
        count: 0,
        date:  d,
      });
    }

    chats.forEach((c) => {
      if (!c.timestamp) return;
      const t = c.timestamp instanceof Date ? c.timestamp : new Date(c.timestamp);
      if (isNaN(t.getTime())) return;
      const dayStart = new Date(t);
      dayStart.setHours(0, 0, 0, 0);
      const idx = days.findIndex((d) => d.date.getTime() === dayStart.getTime());
      if (idx >= 0) days[idx].count++;
    });

    return days;
  }, [chats]);

  const weekTotal = useMemo(
    () => weeklyActivity.reduce((sum, d) => sum + d.count, 0),
    [weeklyActivity],
  );

  // ── Counters stored on the user doc ───────────────────────────────────────
  const catalogCount        = Array.isArray(profile?.catalog)     ? profile!.catalog!.length     : 0;
  const collectionsCount    = Array.isArray(profile?.collections) ? profile!.collections!.length : 0;
  const hasWorkHours        = !!(profile?.workSchedule && Object.keys(profile.workSchedule).length > 0);

  // ── Profile completeness score (0–100) ────────────────────────────────────
  const completenessItems = [
    { label: 'Business name',   done: !!profile?.displayName },
    { label: 'Profile photo',   done: !!avatarUri },
    { label: 'Email',           done: !!profile?.email },
    { label: 'Industry',        done: !!profile?.industry },
    { label: 'Description',     done: !!profile?.description },
    { label: 'Work hours',      done: hasWorkHours },
    { label: 'Physical address',done: !!(profile?.address?.city) },
    { label: 'Catalog item',    done: catalogCount > 0 },
  ];
  const completedCount  = completenessItems.filter((i) => i.done).length;
  const completenessScore = Math.round((completedCount / completenessItems.length) * 100);

  // Industry label for display
  const industryLabel = profile?.industry
    ? (INDUSTRY_CATEGORIES.find((c) => c.id === profile.industry) ?? null)
    : null;

  // Derived percentages for the progress bars
  const catalogCoverage = catalogCount > 0
    ? Math.min(100, Math.round(((catalogCount - (catalogCount % Math.max(collectionsCount, 1))) / catalogCount) * 100))
    : 0;

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    // Refresh server-computed message stats + profile in the background.
    void Promise.all([refreshStats(), loadProfile()]).catch(() => {});
    setTimeout(() => setRefreshing(false), 600);
  }, [refreshStats, loadProfile]);

  const initials = (displayName || 'You')
    .split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);

  return (
    <View style={styles.root}>
      <AppBg />

      {/* ── Header ── */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>
          Dashboard
        </AppText>
        <TouchableOpacity
          style={styles.refreshBtn}
          onPress={onRefresh}
          activeOpacity={0.8}
        >
          <AppIcon name="refresh-outline" size={20} color={COLORS.blue} />
        </TouchableOpacity>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 170 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={COLORS.blue}
          />
        }
      >
          {/* ── Business card ── */}
          <FadeSlideIn delay={0}>
            <View style={[styles.bizCard, bevel]}>
              <View style={styles.bizRow}>
                {avatarUri ? (
                  <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
                ) : (
                  <LinearGradient colors={[COLORS.blue, COLORS.blueDark]} style={styles.avatarFallback}>
                    <AppText fixedColor style={styles.avatarText}>{initials}</AppText>
                  </LinearGradient>
                )}
                <View style={{ flex: 1, marginLeft: 14 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <AppText style={[styles.bizName, { color: textColor, fontFamily }]} numberOfLines={1}>
                      {displayName || 'Business'}
                    </AppText>
                    <IdentityVerificationBadge
                      verified={profile?.identityVerified === true}
                      compact
                    />
                  </View>
                  <AppText style={[styles.bizSub, { color: FG.secondary }]} numberOfLines={1}>
                    {profile?.phone || phone || 'Business account'}
                  </AppText>
                </View>
              </View>

              {(profile?.email || profile?.website) ? (
                <View style={styles.contactStrip}>
                  {profile?.email ? (
                    <View style={styles.contactItem}>
                      <AppIcon name="mail-outline" size={14} color={COLORS.blue} fixedColor />
                      <AppText style={[styles.contactText, { color: textColor }]} numberOfLines={1}>
                        {profile.email}
                      </AppText>
                    </View>
                  ) : null}
                  {profile?.website ? (
                    <View style={styles.contactItem}>
                      <AppIcon name="globe-outline" size={14} color={COLORS.blue} fixedColor />
                      <AppText style={[styles.contactText, { color: textColor }]} numberOfLines={1}>
                        {profile.website}
                      </AppText>
                    </View>
                  ) : null}
                </View>
              ) : null}

              {/* Industry badge + description */}
              {(industryLabel || profile?.description) ? (
                <View style={styles.bizExtra}>
                  {industryLabel ? (
                    <View style={styles.industryBadge}>
                      <AppText style={styles.industryBadgeEmoji}>{industryLabel.emoji}</AppText>
                      <AppText style={[styles.industryBadgeLabel, { color: COLORS.blue }]}>
                        {industryLabel.label}
                      </AppText>
                    </View>
                  ) : null}
                  {profile?.description ? (
                    <AppText style={[styles.bizDescription, { color: FG.secondary }]} numberOfLines={2}>
                      {profile.description}
                    </AppText>
                  ) : null}
                </View>
              ) : null}

              {/* Address line */}
              {profile?.address?.city ? (
                <View style={styles.addressRow}>
                  <AppIcon name="location-outline" size={13} color={COLORS.sub} />
                  <AppText style={[styles.addressText, { color: FG.secondary }]} numberOfLines={1}>
                    {[profile.address.street, profile.address.city, profile.address.province, profile.address.country]
                      .filter(Boolean).join(', ')}
                  </AppText>
                </View>
              ) : null}
            </View>
          </FadeSlideIn>

          {/* ── Weekly activity chart ── */}
          <FadeSlideIn delay={120}>
            <WeeklyActivityChart
              days={weeklyActivity}
              total={weekTotal}
              textColor={textColor}
              fgSecondary={FG.secondary}
              bevel={bevel}
            />
          </FadeSlideIn>

          {/* ── Chat split + key metrics ── */}
          <FadeSlideIn delay={260}>
            <View style={styles.splitRow}>
              <ChatSplitRing
                direct={analytics.directChats}
                group={analytics.groupChats}
                textColor={textColor}
                fgSecondary={FG.secondary}
                bevel={bevel}
              />

              <View style={styles.metricsCol}>
                <SmallMetric
                  label="Unread"
                  value={analytics.totalUnread}
                  sub={analytics.totalUnread > 0 ? 'Needs attention' : 'All caught up'}
                  icon="mail-unread-outline"
                  accent={analytics.totalUnread > 0 ? '#ef4444' : '#94a3b8'}
                  textColor={textColor}
                  fgSecondary={FG.secondary}
                  bevel={bevel}
                />
              </View>
            </View>
          </FadeSlideIn>

          {/* ── Analytics grid ── */}
          <FadeSlideIn delay={400}>
            <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>ANALYTICS</AppText>
          </FadeSlideIn>
          <View style={styles.statsGrid}>
            
            <FadeSlideIn delay={560} style={{ width: STAT_CARD_W }}>
              <StatCard
                label="Total chats"
                value={analytics.totalChats}
                sub={`${analytics.directChats} direct · ${analytics.groupChats} groups`}
                icon="chatbubbles-outline"
                accent="#10b981"
                textColor={textColor}
                fgSecondary={FG.secondary}
                bevel={bevel}
              />
            </FadeSlideIn>
            
            <FadeSlideIn delay={660} style={{ width: STAT_CARD_W }}>
              <StatCard
                label="Catalog items"
                value={catalogCount}
                sub={collectionsCount > 0
                  ? `${collectionsCount} collection${collectionsCount === 1 ? '' : 's'}`
                  : 'No collections yet'}
                icon="storefront-outline"
                accent="#f59e0b"
                textColor={textColor}
                fgSecondary={FG.secondary}
                bevel={bevel}
              />
            </FadeSlideIn>
            <FadeSlideIn delay={710} style={{ width: STAT_CARD_W }}>
              <StatCard
                label="Working hours"
                value={hasWorkHours ? 'Set' : 'Not set'}
                sub={hasWorkHours ? 'Tap below to edit' : 'Open profile →'}
                icon="time-outline"
                accent="#06b6d4"
                textColor={textColor}
                fgSecondary={FG.secondary}
                bevel={bevel}
              />
            </FadeSlideIn>
          </View>

          {/* ── Catalog health (progress bars) ── */}
          <FadeSlideIn delay={800}>
            <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>HEALTH</AppText>
          </FadeSlideIn>

          {/* ── Message delivery analytics ── */}
          <FadeSlideIn delay={780}>
            <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>MESSAGE ANALYTICS</AppText>
          </FadeSlideIn>
          <FadeSlideIn delay={820}>
            <MessageAnalyticsCard
              stats={msgStats}
              textColor={textColor}
              fgSecondary={FG.secondary}
              bevel={bevel}
            />
          </FadeSlideIn>

          {/* ── Profile completeness ── */}
          <FadeSlideIn delay={860}>
            <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>PROFILE COMPLETENESS</AppText>
          </FadeSlideIn>
          <FadeSlideIn delay={900}>
            <ProfileCompletenessCard
              score={completenessScore}
              items={completenessItems}
              textColor={textColor}
              fgSecondary={FG.secondary}
              bevel={bevel}
              onFix={() => navigation.navigate('Profile')}
            />
          </FadeSlideIn>
          <FadeSlideIn delay={840}>
            <View style={[styles.progressCard, bevel]}>
              <ProgressBar
                label="Catalog in collections"
                current={catalogCoverage}
                total={100}
                suffix="%"
                accent="#f59e0b"
                textColor={textColor}
                fgSecondary={FG.secondary}
                delay={1000}
              />
              <ProgressBar
                label="Unread resolution"
                current={Math.max(analytics.totalChats - analytics.totalUnread, 0)}
                total={Math.max(analytics.totalChats, 1)}
                accent="#10b981"
                textColor={textColor}
                fgSecondary={FG.secondary}
                delay={1100}
                isLast
              />
            </View>
          </FadeSlideIn>

          {/* ── Quick actions ── */}
          <FadeSlideIn delay={1200}>
            <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>QUICK ACTIONS</AppText>
          </FadeSlideIn>
          <FadeSlideIn delay={1240}>
            <View style={[styles.actionsCard, bevel]}>
              <ActionRow
                icon="person-circle-outline"
                label="Edit business profile"
                onPress={() => navigation.navigate('Profile')}
                textColor={textColor}
                fgSecondary={FG.secondary}
              />
              <ActionRow
                icon="storefront-outline"
                label="Manage catalog"
                onPress={() => navigation.navigate('Profile', { scrollTo: 'catalog' } as never)}
                textColor={textColor}
                fgSecondary={FG.secondary}
              />
              <ActionRow
                icon="people-outline"
                label="Linked devices"
                onPress={() => navigation.navigate('LinkedDevices')}
                textColor={textColor}
                fgSecondary={FG.secondary}
              />
              <ActionRow
                icon="settings-outline"
                label="Account settings"
                onPress={() => navigation.navigate('AccountSettings')}
                textColor={textColor}
                fgSecondary={FG.secondary}
                isLast
              />
            </View>
          </FadeSlideIn>

          <FadeSlideIn delay={1340}>
            <AppText style={[styles.footnote, { color: FG.secondary }]}>
              Metrics update live as activity happens.
            </AppText>
          </FadeSlideIn>
        </ScrollView>

      <BottomNav active="dashboard" />
    </View>
  );
}

// ─── WeeklyActivityChart ─────────────────────────────────────────────────────
// Bar chart of the last 7 days. Each bar grows up from the baseline with a
// stagger on mount, and its value label fades in once the bar has risen.
function WeeklyActivityChart({
  days, total, textColor, fgSecondary, bevel,
}: {
  days: DayCell[];
  total: number;
  textColor: string;
  fgSecondary: string;
  bevel: any;
}) {
  const chartWidth = Dimensions.get('window').width - 28 - 28; // screen − horizontal padding − card padding
  const chartHeight = 150;
  const padTop = 18;
  const padBottom = 24;
  const innerH = chartHeight - padTop - padBottom;

  const maxValue = Math.max(...days.map((d) => d.count), 1);
  const slotW = chartWidth / days.length;
  const barW = slotW * 0.52;

  // One animated value per bar — 0 → 1, staggered.
  const barAnims = useRef(days.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    // Reset if the number of days ever changed.
    if (barAnims.length !== days.length) {
      barAnims.length = 0;
      days.forEach(() => barAnims.push(new Animated.Value(0)));
    }

    const anims = barAnims.map((v) =>
      Animated.timing(v, {
        toValue: 1,
        duration: 620,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false, // SVG props aren't natively drivable
      }),
    );

    Animated.stagger(70, anims).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length]);

  return (
    <View style={[styles.chartCard, bevel]}>
      <View style={styles.chartHeaderRow}>
        <View style={{ flex: 1 }}>
          <AppText style={[styles.chartTitle, { color: textColor }]}>
            Weekly Activity
          </AppText>
          <AppText style={[styles.chartSub, { color: fgSecondary }]}>
            {total} active chat{total === 1 ? '' : 's'} in the last 7 days
          </AppText>
        </View>
        <View style={styles.chartLegendPill}>
          <View style={[styles.legendDot, { backgroundColor: COLORS.blue }]} />
          <AppText style={[styles.legendLabel, { color: fgSecondary }]}>Chats</AppText>
        </View>
      </View>

      <Svg width={chartWidth} height={chartHeight}>
        <Defs>
          <SvgLinearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={COLORS.blue} stopOpacity="1" />
            <Stop offset="1" stopColor={COLORS.blue} stopOpacity="0.55" />
          </SvgLinearGradient>
        </Defs>

        {days.map((d, i) => {
          const targetH = maxValue > 0 ? (d.count / maxValue) * innerH : 0;
          const x = i * slotW + (slotW - barW) / 2;

          // Animated height — grows from 0 to targetH.
          const animatedH = barAnims[i].interpolate({
            inputRange: [0, 1],
            outputRange: [0, targetH],
          });
          // Animated y — the top edge moves up so the bar grows from the base.
          const animatedY = barAnims[i].interpolate({
            inputRange: [0, 1],
            outputRange: [padTop + innerH, padTop + innerH - targetH],
          });
          // Number fades in once the bar has risen.
          const numberOpacity = barAnims[i].interpolate({
            inputRange: [0, 0.6, 1],
            outputRange: [0, 0, 1],
          });

          return (
            <G key={i}>
              {/* Track */}
              <Rect
                x={x}
                y={padTop}
                width={barW}
                height={innerH}
                rx={barW / 2}
                fill="rgba(30,156,240,0.08)"
              />
              {/* Value bar — animated height + top edge */}
              {d.count > 0 && (
                <AnimatedRect
                  x={x}
                  y={animatedY}
                  width={barW}
                  height={animatedH}
                  rx={barW / 2}
                  fill="url(#barGrad)"
                />
              )}
              {/* Value label above bar — fades in after the bar */}
              {d.count > 0 && (
                <AnimatedSvgText
                  x={x + barW / 2}
                  y={padTop + innerH - targetH - 6}
                  fontSize="11"
                  fontWeight="700"
                  fill={textColor}
                  textAnchor="middle"
                  opacity={numberOpacity}
                >
                  {String(d.count)}
                </AnimatedSvgText>
              )}
              {/* Weekday label */}
              <SvgText
                x={x + barW / 2}
                y={chartHeight - 4}
                fontSize="11"
                fill={fgSecondary}
                textAnchor="middle"
              >
                {d.label}
              </SvgText>
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

// ─── ChatSplitRing ───────────────────────────────────────────────────────────
// Two-segment donut. Draws direct segment first, then group, so the ring
// "wraps" into place on mount. Center count fades in at the end.
function ChatSplitRing({
  direct, group, textColor, fgSecondary, bevel,
}: {
  direct: number;
  group: number;
  textColor: string;
  fgSecondary: string;
  bevel: any;
}) {
  const size = 140;
  const strokeWidth = 16;
  const r = (size - strokeWidth) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;

  const total = direct + group;
  const directPct = total > 0 ? direct / total : 0;
  const groupPct  = total > 0 ? group / total : 0;

  // Two-phase draw: direct arc then group arc.
  const directAnim = useRef(new Animated.Value(0)).current;
  const groupAnim  = useRef(new Animated.Value(0)).current;
  const centerAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    directAnim.setValue(0);
    groupAnim.setValue(0);
    centerAnim.setValue(0);

    Animated.sequence([
      Animated.timing(directAnim, {
        toValue: 1,
        duration: 700,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(groupAnim, {
        toValue: 1,
        duration: 550,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(centerAnim, {
        toValue: 1,
        duration: 350,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direct, group]);

  const directDash = directAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [`0 ${C}`, `${C * directPct} ${C}`],
  });
  const groupDash = groupAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [`0 ${C}`, `${C * groupPct} ${C}`],
  });

  return (
    <View style={[styles.splitCard, bevel]}>
      <AppText style={[styles.chartTitle, { color: textColor }]}>
        Chat Split
      </AppText>
      <AppText style={[styles.chartSub, { color: fgSecondary }]}>
        {total} total
      </AppText>

      <View style={{ alignItems: 'center', marginTop: 10 }}>
        <Svg width={size} height={size}>
          {/* Track */}
          <Circle
            cx={cx} cy={cy} r={r}
            stroke="rgba(30,156,240,0.08)"
            strokeWidth={strokeWidth}
            fill="none"
          />

          <G rotation="-90" origin={`${cx}, ${cy}`}>
            {/* Direct segment — animated dash length */}
            <AnimatedCircle
              cx={cx} cy={cy} r={r}
              stroke={COLORS.blue}
              strokeWidth={strokeWidth}
              fill="none"
              strokeDasharray={directDash}
              strokeLinecap="butt"
            />
            {/* Group segment — starts after direct finishes */}
            <AnimatedCircle
              cx={cx} cy={cy} r={r}
              stroke="#8b5cf6"
              strokeWidth={strokeWidth}
              fill="none"
              strokeDasharray={groupDash}
              strokeDashoffset={-C * directPct}
              strokeLinecap="butt"
            />
          </G>

          {/* Center count + label fade in last */}
          <AnimatedSvgText
            x={cx}
            y={cy + 2}
            fontSize="24"
            fontWeight="800"
            fill={textColor}
            textAnchor="middle"
            opacity={centerAnim}
          >
            {String(total)}
          </AnimatedSvgText>
          <AnimatedSvgText
            x={cx}
            y={cy + 20}
            fontSize="10"
            fill={fgSecondary}
            textAnchor="middle"
            opacity={centerAnim}
          >
            chats
          </AnimatedSvgText>
        </Svg>

        {/* Legend */}
        <View style={styles.donutLegend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: COLORS.blue }]} />
            <AppText style={[styles.legendLabel, { color: fgSecondary }]}>
              Direct {Math.round(directPct * 100)}%
            </AppText>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#8b5cf6' }]} />
            <AppText style={[styles.legendLabel, { color: fgSecondary }]}>
              Groups {Math.round(groupPct * 100)}%
            </AppText>
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── SmallMetric ─────────────────────────────────────────────────────────────
// Compact metric card used in the two-column row next to the ChatSplitRing.
function SmallMetric({
  label, value, sub, icon, accent, textColor, fgSecondary, bevel,
}: {
  label: string;
  value: number | string;
  sub: string;
  icon: string;
  accent: string;
  textColor: string;
  fgSecondary: string;
  bevel: any;
}) {
  return (
    <View style={[styles.smallMetric, bevel]}>
      <View style={[styles.smallMetricIcon, { backgroundColor: `${accent}22` }]}>
        <AppIcon name={icon as any} size={14} color={accent} fixedColor />
      </View>
      <AppText style={[styles.smallMetricValue, { color: textColor }]} numberOfLines={1}>
        {String(value)}
      </AppText>
      <AppText style={[styles.smallMetricLabel, { color: textColor }]} numberOfLines={1}>
        {label}
      </AppText>
      <AppText style={[styles.smallMetricSub, { color: fgSecondary }]} numberOfLines={1}>
        {sub}
      </AppText>
    </View>
  );
}

// ─── ProgressBar ─────────────────────────────────────────────────────────────
// Simple progress bar whose fill animates from 0% to its target on mount.
// `delay` lets the three bars in the Health card cascade in one after another.
function ProgressBar({
  label, current, total, accent, textColor, fgSecondary, suffix, isLast, delay = 0,
}: {
  label: string;
  current: number;
  total: number;
  accent: string;
  textColor: string;
  fgSecondary: string;
  suffix?: string;
  isLast?: boolean;
  delay?: number;
}) {
  const pct = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
  const displayPct = suffix === '%' ? current : Math.round(pct * 100);

  const widthAnim = useRef(new Animated.Value(0)).current;
  const labelAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    widthAnim.setValue(0);
    labelAnim.setValue(0);
    Animated.parallel([
      Animated.timing(widthAnim, {
        toValue: 1,
        duration: 750,
        delay,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }),
      Animated.timing(labelAnim, {
        toValue: 1,
        duration: 500,
        delay: delay + 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pct, delay]);

  const animatedWidth = widthAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', `${pct * 100}%`],
  });

  return (
    <View style={[styles.progressRow, !isLast && styles.progressRowBorder]}>
      <View style={styles.progressHeader}>
        <AppText style={[styles.progressLabel, { color: textColor }]} numberOfLines={1}>
          {label}
        </AppText>
        <Animated.View style={{ opacity: labelAnim }}>
          <AppText style={[styles.progressValue, { color: accent }]}>
            {displayPct}%
          </AppText>
        </Animated.View>
      </View>
      <View style={styles.progressTrack}>
        <Animated.View
          style={[
            styles.progressFill,
            { width: animatedWidth, backgroundColor: accent },
          ]}
        />
      </View>
    </View>
  );
}

// ─── MessageAnalyticsCard ────────────────────────────────────────────────────
// Shows sent / delivered / read counters with animated fill bars and
// derived delivery + read-through rates.
function MessageAnalyticsCard({
  stats, textColor, fgSecondary, bevel,
}: {
  stats: { sent: number; delivered: number; read: number };
  textColor: string;
  fgSecondary: string;
  bevel: any;
}) {
  const dRate = stats.sent > 0 ? Math.round((stats.delivered / stats.sent) * 100) : 0;
  const rRate = stats.sent > 0 ? Math.round((stats.read      / stats.sent) * 100) : 0;

  const metrics = [
    { label: 'Sent',      value: stats.sent,      accent: COLORS.blue,   icon: 'paper-plane-outline'    },
    { label: 'Delivered', value: stats.delivered, accent: '#8b5cf6',     icon: 'checkmark-done-outline' },
    { label: 'Read',      value: stats.read,      accent: '#10b981',     icon: 'eye-outline'            },
  ];

  return (
    <View style={[analyticsStyles.card, bevel]}>
      {/* Metric pills */}
      <View style={analyticsStyles.pillRow}>
        {metrics.map((m) => (
          <View key={m.label} style={[analyticsStyles.pill, { backgroundColor: `${m.accent}14` }]}>
            <View style={[analyticsStyles.pillIcon, { backgroundColor: `${m.accent}22` }]}>
              <AppIcon name={m.icon as any} size={16} color={m.accent} fixedColor />
            </View>
            <AppText style={[analyticsStyles.pillValue, { color: textColor }]}>
              {m.value.toLocaleString()}
            </AppText>
            <AppText style={[analyticsStyles.pillLabel, { color: fgSecondary }]}>
              {m.label}
            </AppText>
          </View>
        ))}
      </View>

      {/* Rate bars */}
      <View style={analyticsStyles.rateSection}>
        <RateBar label="Delivery rate" pct={dRate} accent="#8b5cf6" textColor={textColor} fgSecondary={fgSecondary} />
        <RateBar label="Read-through rate" pct={rRate} accent="#10b981" textColor={textColor} fgSecondary={fgSecondary} isLast />
      </View>

      {stats.sent === 0 && (
        <AppText style={[analyticsStyles.emptyHint, { color: fgSecondary }]}>
          Send your first message to start tracking analytics. Pull to refresh after sending.
        </AppText>
      )}
    </View>
  );
}

function RateBar({
  label, pct, accent, textColor, fgSecondary, isLast,
}: {
  label: string; pct: number; accent: string;
  textColor: string; fgSecondary: string; isLast?: boolean;
}) {
  const widthAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: pct / 100,
      duration: 900,
      delay: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [pct]);

  const TRACK_W = Dimensions.get('window').width - 28 - 28 - 32;

  return (
    <View style={[analyticsStyles.rateRow, !isLast && analyticsStyles.rateRowBorder]}>
      <View style={analyticsStyles.rateLabelRow}>
        <AppText style={[analyticsStyles.rateLabel, { color: textColor }]}>{label}</AppText>
        <AppText style={[analyticsStyles.ratePct, { color: accent }]}>{pct}%</AppText>
      </View>
      <View style={[analyticsStyles.track, { width: TRACK_W }]}>
        <Animated.View style={[analyticsStyles.fill, {
          backgroundColor: accent,
          width: widthAnim.interpolate({ inputRange: [0, 1], outputRange: [0, TRACK_W] }),
        }]} />
      </View>
    </View>
  );
}

const analyticsStyles = StyleSheet.create({
  card:       { borderRadius: RADIUS.lg, marginHorizontal: 14, padding: 16, marginBottom: 0 },
  pillRow:    { flexDirection: 'row', gap: 8, marginBottom: 16 },
  pill:       { flex: 1, borderRadius: RADIUS.md, paddingVertical: 14, paddingHorizontal: 10, alignItems: 'center', gap: 4 },
  pillIcon:   { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginBottom: 2 },
  pillValue:  { fontSize: 20, fontWeight: '800' },
  pillLabel:  { fontSize: 11, fontWeight: '600' },
  rateSection:{ gap: 10 },
  rateRow:    { paddingBottom: 10 },
  rateRowBorder: { borderBottomWidth: 1, borderBottomColor: 'rgba(30,156,240,0.10)', marginBottom: 10 },
  rateLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  rateLabel:  { fontSize: 13, fontWeight: '500' },
  ratePct:    { fontSize: 13, fontWeight: '700' },
  track:      { height: 6, borderRadius: 3, backgroundColor: 'rgba(30,156,240,0.10)', overflow: 'hidden' },
  fill:       { height: 6, borderRadius: 3 },
  emptyHint:  { fontSize: 12, textAlign: 'center', lineHeight: 18, marginTop: 8, opacity: 0.8 },
});

// ─── ProfileCompletenessCard ──────────────────────────────────────────────────
function ProfileCompletenessCard({
  score, items, textColor, fgSecondary, bevel, onFix,
}: {
  score: number;
  items: { label: string; done: boolean }[];
  textColor: string;
  fgSecondary: string;
  bevel: any;
  onFix: () => void;
}) {
  const incomplete = items.filter((i) => !i.done);

  const accent = score >= 90 ? '#10b981' : score >= 60 ? COLORS.blue : '#f59e0b';

  const widthAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(widthAnim, {
      toValue: score / 100,
      duration: 1000,
      delay: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [score]);

  const TRACK_W = Dimensions.get('window').width - 28 - 28 - 32;

  return (
    <View style={[completenessStyles.card, bevel]}>
      <View style={completenessStyles.scoreRow}>
        <View style={{ flex: 1 }}>
          <AppText style={[completenessStyles.scoreTitle, { color: textColor }]}>
            {score}% complete
          </AppText>
          <AppText style={[completenessStyles.scoreSub, { color: fgSecondary }]}>
            {incomplete.length === 0
              ? 'Your profile is fully set up!'
              : `${incomplete.length} item${incomplete.length > 1 ? 's' : ''} remaining`}
          </AppText>
        </View>
        <View style={[completenessStyles.scoreCircle, { borderColor: accent }]}>
          <AppText style={[completenessStyles.scoreNum, { color: accent }]}>{score}</AppText>
          <AppText style={[completenessStyles.scorePctLabel, { color: fgSecondary }]}>%</AppText>
        </View>
      </View>

      {/* Progress bar */}
      <View style={[completenessStyles.track, { width: TRACK_W }]}>
        <Animated.View style={[completenessStyles.fill, {
          backgroundColor: accent,
          width: widthAnim.interpolate({ inputRange: [0, 1], outputRange: [0, TRACK_W] }),
        }]} />
      </View>

      {/* Checklist */}
      <View style={completenessStyles.checklist}>
        {items.map((item) => (
          <View key={item.label} style={completenessStyles.checkItem}>
            <AppIcon
              name={item.done ? 'checkmark-circle' : 'ellipse-outline'}
              size={16}
              color={item.done ? '#10b981' : COLORS.sub}
              fixedColor
            />
            <AppText style={[completenessStyles.checkLabel, {
              color: item.done ? textColor : fgSecondary,
              textDecorationLine: item.done ? 'none' : 'none',
            }]}>
              {item.label}
            </AppText>
          </View>
        ))}
      </View>

      {incomplete.length > 0 && (
        <TouchableOpacity style={completenessStyles.fixBtn} onPress={onFix} activeOpacity={0.85}>
          <LinearGradient colors={GRADIENTS.primary} style={completenessStyles.fixGrad}>
            <AppIcon name="create-outline" size={15} color="#fff" fixedColor />
            <AppText style={completenessStyles.fixText} fixedColor>Complete your profile</AppText>
          </LinearGradient>
        </TouchableOpacity>
      )}

    </View>
  );
}

const completenessStyles = StyleSheet.create({
  card:        { borderRadius: RADIUS.lg, marginHorizontal: 14, padding: 16, marginBottom: 0 },
  scoreRow:    { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  scoreTitle:  { fontSize: 18, fontWeight: '800', marginBottom: 2 },
  scoreSub:    { fontSize: 13 },
  scoreCircle: { width: 52, height: 52, borderRadius: 26, borderWidth: 3, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  scoreNum:    { fontSize: 16, fontWeight: '800' },
  scorePctLabel: { fontSize: 9, fontWeight: '600', marginTop: -2 },
  track:       { height: 6, borderRadius: 3, backgroundColor: 'rgba(30,156,240,0.10)', overflow: 'hidden', marginBottom: 14 },
  fill:        { height: 6, borderRadius: 3 },
  checklist:   { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  checkItem:   { flexDirection: 'row', alignItems: 'center', gap: 5, width: '47%' },
  checkLabel:  { fontSize: 12, fontWeight: '500', flexShrink: 1 },
  fixBtn:      { borderRadius: RADIUS.full, overflow: 'hidden' },
  fixGrad:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: RADIUS.full, ...SHADOW.button },
  fixText:     { fontSize: 14, fontWeight: '700', color: '#fff' },
});

// ─── StatCard ────────────────────────────────────────────────────────────────
function StatCard({
  label, value, sub, icon, accent, textColor, fgSecondary, bevel,
}: {
  label: string;
  value: number | string;
  sub: string;
  icon: string;
  accent: string;
  textColor: string;
  fgSecondary: string;
  bevel: any;
}) {
  return (
    <View style={[styles.statCard, bevel]}>
      <View style={[styles.statIconWrap, { backgroundColor: `${accent}22` }]}>
        <AppIcon name={icon as any} size={18} color={accent} fixedColor />
      </View>
      <AppText style={[styles.statValue, { color: textColor }]} numberOfLines={1}>
        {String(value)}
      </AppText>
      <AppText style={[styles.statLabel, { color: textColor }]} numberOfLines={2}>
        {label}
      </AppText>
      <AppText style={[styles.statSub, { color: fgSecondary }]} numberOfLines={2}>
        {sub}
      </AppText>
    </View>
  );
}

// ─── ActionRow ───────────────────────────────────────────────────────────────
function ActionRow({
  icon, label, onPress, textColor, fgSecondary, isLast,
}: {
  icon: string;
  label: string;
  onPress: () => void;
  textColor: string;
  fgSecondary: string;
  isLast?: boolean;
}) {
  return (
    <TouchableOpacity
      style={[styles.actionRow, !isLast && styles.actionRowBorder]}
      activeOpacity={0.75}
      onPress={onPress}
    >
      <View style={styles.actionIconWrap}>
        <AppIcon name={icon as any} size={18} color={COLORS.blue} fixedColor />
      </View>
      <AppText style={[styles.actionLabel, { color: textColor }]}>{label}</AppText>
      <AppIcon name="chevron-forward" size={16} color={fgSecondary} />

    </TouchableOpacity>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const STAT_CARD_W  = (Dimensions.get('window').width - 28 - 10) / 2;
const SPLIT_CARD_W = (Dimensions.get('window').width - 28 - 10) * 0.52;
const METRIC_COL_W = (Dimensions.get('window').width - 28 - 10) * 0.44;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.sky1 },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingBottom: 10,
  },
  title: { fontSize: 22, fontWeight: '800' },
  refreshBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
  },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  scroll: { paddingHorizontal: 14, paddingTop: 4, gap: 14 },

  // Business card
  bizCard: {
    borderRadius: RADIUS.lg,
    padding: 16,
    marginBottom: 4,
  },
  bizRow: { flexDirection: 'row', alignItems: 'center' },
  avatarImg: {
    width: 60, height: 60, borderRadius: 30,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)',
  },
  avatarFallback: {
    width: 60, height: 60, borderRadius: 30,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 22, fontWeight: '800', color: '#fff' },
  bizName: { fontSize: 17, fontWeight: '800' },
  bizSub:  { fontSize: 12, marginTop: 3 },
  verifiedBadge: {
    width: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  contactStrip: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.05)',
    gap: 8,
  },
  contactItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  contactText: { fontSize: 13, fontWeight: '500', flex: 1 },

  // Enhanced biz card fields
  bizExtra: { marginTop: 10, gap: 6 },
  industryBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(30,156,240,0.10)',
    borderRadius: RADIUS.full,
    paddingHorizontal: 10, paddingVertical: 4,
  },
  industryBadgeEmoji: { fontSize: 14 },
  industryBadgeLabel: { fontSize: 12, fontWeight: '700', color: COLORS.blue },
  bizDescription: { fontSize: 13, lineHeight: 18 },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  addressText: { fontSize: 12, flex: 1 },

  sectionLabel: {
    fontSize: 11, fontWeight: '700', letterSpacing: 0.8,
    paddingHorizontal: 4, marginTop: 6,
  },

  // ── Chart card shell ────────────────────────────────────────────────────
  chartCard: {
    borderRadius: RADIUS.lg,
    padding: 14,
    gap: 8,
  },
  chartHeaderRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  chartTitle: {
    fontSize: 15,
    fontWeight: '800',
  },
  chartSub: {
    fontSize: 11,
    marginTop: 2,
  },
  chartLegendPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(30,156,240,0.08)',
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 11,
    fontWeight: '600',
  },

  // ── Split row (donut + small metrics) ──────────────────────────────────
  splitRow: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'stretch',
  },
  splitCard: {
    width: SPLIT_CARD_W,
    borderRadius: RADIUS.lg,
    padding: 14,
  },
  donutLegend: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 10,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  metricsCol: {
    width: METRIC_COL_W,
    gap: 10,
  },
  smallMetric: {
    flex: 1,
    borderRadius: RADIUS.lg,
    padding: 12,
    gap: 4,
    justifyContent: 'center',
  },
  smallMetricIcon: {
    width: 28,
    height: 28,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  smallMetricValue: { fontSize: 20, fontWeight: '800' },
  smallMetricLabel: { fontSize: 11, fontWeight: '700' },
  smallMetricSub:   { fontSize: 10 },

  // ── Stats grid ────────────────────────────────────────────────────────
  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  statCard: {
    borderRadius: RADIUS.lg,
    padding: 14,
    gap: 6,
  },
  statIconWrap: {
    width: 34, height: 34, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 2,
  },
  statValue: { fontSize: 22, fontWeight: '800' },
  statLabel: { fontSize: 12, fontWeight: '700' },
  statSub:   { fontSize: 11 },

  // ── Progress / health card ─────────────────────────────────────────────
  progressCard: {
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  progressRow: {
    paddingVertical: 12,
  },
  progressRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  progressHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  progressLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  progressValue: {
    fontSize: 12,
    fontWeight: '800',
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(0,0,0,0.06)',
    overflow: 'hidden',
  },
  progressFill: {
    height: 8,
    borderRadius: 4,
  },

  // ── Actions ────────────────────────────────────────────────────────────
  actionsCard: {
    borderRadius: RADIUS.lg,
    overflow: 'hidden',
  },
  actionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 14,
  },
  actionRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  actionIconWrap: {
    width: 34, height: 34, borderRadius: 12,
    backgroundColor: 'rgba(30,156,240,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  actionLabel: { flex: 1, fontSize: 14, fontWeight: '600' },

  footnote: {
    fontSize: 11,
    textAlign: 'center',
    marginTop: 4,
    opacity: 0.7,
  },
});