// ─── Screen: Status ──────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, FlatList, TouchableOpacity, StyleSheet, Platform,
  Animated,
} from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import { UserAvatar, StatusViewer, CreateStatusModal, ScreenLayout } from '../components';
import { endpoints } from '../api/endpoints';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { useAuth } from '../hooks/useAuth';
import { useAuth as useAuthContext } from '../context/AuthContext';
import { useStatus, type StatusGroup } from '../hooks/useStatus';
import { usePhoneBook } from '../hooks/usePhoneBook';
import { isVisibleTo } from '../hooks/usePrivacySettings';
import type { FireStatus } from '../types';
import {
  AppBg, AppText, AppIcon, useForeground, useTypography, useGlass,
} from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatTimeAgo(date: Date): string {
  const diffMs   = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs  = Math.floor(diffMs / 3600000);
  if (diffMins < 1)  return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHrs  < 24) return `${diffHrs}h ago`;
  return 'Today';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase();
}

const AVATAR_PALETTE = [
  '#f97316','#8b5cf6','#ec4899','#06b6d4',
  '#10b981','#f59e0b','#6366f1','#e11d48',
];

function stringToColor(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

// ─── StatusRow ───────────────────────────────────────────────────────────────

interface StatusRowProps {
  item: StatusGroup;
  nameForUser: (uid: string, phone: string | null) => string;
  visiblePhotoForUser: (uid: string, raw: string | null | undefined) => string | null;
  onPress: (item: StatusGroup) => void;
}

function StatusRow({ item, nameForUser, visiblePhotoForUser, onPress }: StatusRowProps) {
  const { FG }           = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { bevel }        = useGlass();

  const name         = nameForUser(item.userId, item.userPhone);
  const visiblePhoto = visiblePhotoForUser(item.userId, item.photoURL);
  const color        = stringToColor(name);
  const initials     = getInitials(name);

  const sorted   = [...item.statuses].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const latest   = sorted[0];
  const thumbUrl =
    (latest?.thumbnailUrl && /^https?:/.test(latest.thumbnailUrl) ? latest.thumbnailUrl : null) ??
    (latest?.mediaType === 'image' && latest.mediaUrl && /^https?:/.test(latest.mediaUrl)
      ? latest.mediaUrl
      : null);
  const isText   = latest?.mediaType === 'text';
  const textBg   = latest?.backgroundColor ?? color;

  return (
    <TouchableOpacity
      style={[rowStyles.card, bevel]}
      activeOpacity={0.75}
      onPress={() => onPress(item)}
    >
      {/* ── Gradient ring ────────────────────────────────────────────── */}
      <LinearGradient
        colors={item.hasUnviewed ? [color, COLORS.blue] : ['#C7C7CC', '#AEAEB2']}
        style={rowStyles.ring}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
      >
        <View style={rowStyles.ringInner}>
          {thumbUrl ? (
            <Image source={{ uri: thumbUrl }} style={rowStyles.avatar} contentFit="cover" />
          ) : isText ? (
            <View style={[rowStyles.avatar, { backgroundColor: textBg, alignItems: 'center', justifyContent: 'center' }]}>
              <AppText style={rowStyles.avatarText} numberOfLines={2}>
                {latest.caption?.slice(0, 2) ?? 'T'}
              </AppText>
            </View>
          ) : visiblePhoto ? (
            <Image source={{ uri: visiblePhoto }} style={rowStyles.avatar} contentFit="cover" />
          ) : (
            <View style={[rowStyles.avatar, { backgroundColor: color, alignItems: 'center', justifyContent: 'center' }]}>
              <AppText style={rowStyles.avatarText}>{initials}</AppText>
            </View>
          )}
        </View>
      </LinearGradient>

      {/* Small profile-photo badge bottom-right of ring */}
      {visiblePhoto && thumbUrl && (
        <View style={rowStyles.badge}>
          <Image source={{ uri: visiblePhoto }} style={rowStyles.badgeImg} contentFit="cover" />
        </View>
      )}

      {/* Text */}
      <View style={rowStyles.meta}>
        <AppText style={[rowStyles.name, { color: textColor, fontFamily }]} numberOfLines={1}>
          {name}
        </AppText>
        <AppText style={[rowStyles.time, { color: FG.secondary }]}>
          {formatTimeAgo(item.latestTimestamp)}
          {item.statuses.length > 1 ? `  ·  ${item.statuses.length} updates` : ''}
        </AppText>
      </View>

      {item.hasUnviewed && <View style={rowStyles.unreadDot} />}
    </TouchableOpacity>
  );
}

const rowStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 13,
    ...SHADOW.card,
  },
  ring: { borderRadius: 999, padding: 2.5 },
  ringInner: {
    borderRadius: 999,
    padding: 2.5,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
  },
  avatarText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#fff',
    textAlign: 'center',
  },
  badge: {
    position: 'absolute',
    left: 42,
    top: 40,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2.5,
    borderColor: COLORS.sky1,
    overflow: 'hidden',
    zIndex: 2,
  },
  badgeImg: { width: '100%', height: '100%' },
  meta: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: '700' },
  time: { fontSize: 12, marginTop: 2 },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.blue,
  },
});

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function StatusScreen() {
  const { user }        = useAuth();
  const userId          = user?.uid ?? null;
  const { isCompanion } = useAuthContext();
  const displayName     = user?.displayName || user?.email || 'Unknown';
  const photoURL        = user?.photoURL || null;

  const { FG }                        = useForeground();
  const { fontFamily, textColor }     = useTypography();
  const { bevel }                     = useGlass();
  const insets                        = useSafeAreaInsets();
  const { resolveName, contactsMap }  = usePhoneBook();

  const {
    myStatuses,
    contactStatuses,
    loading,
    error,
    createStatus,
    markAsViewed,
    deleteStatus,
    reload: reloadStatuses,
  } = useStatus(userId, isCompanion);

  useFocusEffect(useCallback(() => { reloadStatuses(); }, [reloadStatuses]));

  // ── Prefetch media ────────────────────────────────────────────────────────
  const prefetchedRef = useRef(new Set<string>());
  useEffect(() => {
    const all = [...myStatuses, ...contactStatuses.flatMap((g) => g.statuses)];
    all.forEach((s) => {
      const urls = [
        s.mediaType === 'image' ? s.mediaUrl     : null,
        s.mediaType === 'image' ? s.thumbnailUrl : null,
        s.mediaType === 'video' ? s.thumbnailUrl : null,
        s.photoURL,
      ].filter((u): u is string => !!u && !prefetchedRef.current.has(u));
      urls.forEach((url) => {
        prefetchedRef.current.add(url);
        Image.prefetch(url, { cachePolicy: 'memory-disk' }).catch(() => {});
      });
    });
  }, [myStatuses, contactStatuses]);

  // ── Phone + privacy resolution ────────────────────────────────────────────
  const [phoneMap,              setPhoneMap]              = useState(new Map<string, string>());
  const [statusPrivacyPhotoMap, setStatusPrivacyPhotoMap] = useState(new Map<string, string>());
  const [statusVisibilityMap,   setStatusVisibilityMap]   = useState(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    const all = Array.from(new Set(
      contactStatuses
        .filter((g) => !phoneMap.has(g.userId) || !statusVisibilityMap.has(g.userId))
        .map((g) => g.userId),
    ));
    if (!all.length) return;

    (async () => {
      const phones: Map<string, string> = new Map();
      const privacy: Map<string, string> = new Map();
      const vis: Map<string, string> = new Map();
      await Promise.all(all.map(async (uid) => {
        try {
          const res = await endpoints.getUser(uid);
          if (res.ok) {
            const { phoneNumber } = res.data;
            if (phoneNumber && !phoneMap.has(uid)) phones.set(uid, phoneNumber);
            privacy.set(uid, 'Contacts');
            vis.set(uid, 'Everyone');
          }
        } catch { /* ignore */ }
      }));
      if (cancelled) return;
      if (phones.size)  setPhoneMap((p)              => new Map([...p, ...phones]));
      if (privacy.size) setStatusPrivacyPhotoMap((p) => new Map([...p, ...privacy]));
      if (vis.size)     setStatusVisibilityMap((p)   => new Map([...p, ...vis]));
    })();

    return () => { cancelled = true; };
  }, [contactStatuses]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Filter visible contacts ───────────────────────────────────────────────
  const visibleContactStatuses = contactStatuses.filter((g) => {
    const phone = g.userPhone || phoneMap.get(g.userId) || null;
    if (!phone || !contactsMap.has(phone)) return false;
    const setting = statusVisibilityMap.get(g.userId) ?? 'Everyone';
    return isVisibleTo(setting as any, true);
  });

  const nameForUser = (uid: string, userPhone: string | null) => {
    const phone = userPhone || phoneMap.get(uid) || null;
    return resolveName(phone, phone ?? 'Unknown');
  };

  const visiblePhotoForUser = (uid: string, raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const setting = statusPrivacyPhotoMap.get(uid) ?? 'Contacts';
    return isVisibleTo(setting as any, true) ? raw : null;
  };

  // ── Viewer / modal state ──────────────────────────────────────────────────
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [viewerVisible,      setViewerVisible]      = useState(false);
  const [viewerStatuses,     setViewerStatuses]     = useState<FireStatus[]>([]);
  const [viewerIsOwner,      setViewerIsOwner]      = useState(false);

  const handleCreateStatus = async (
    mediaType: 'image' | 'video' | 'text',
    mediaUri: string | null,
    caption: string | null,
    backgroundColor: string | null,
    textColorArg: string | null,
    durationMs?: number,
  ) => {
    if (!userId) return;
    await createStatus(
      displayName, photoURL, mediaType, mediaUri, caption,
      backgroundColor, textColorArg, user?.phoneNumber ?? null, durationMs,
    );
  };

  const handleViewMyStatus = () => {
    if (!myStatuses.length) return;
    setViewerStatuses(myStatuses);
    setViewerIsOwner(true);
    setViewerVisible(true);
  };

  const handleViewContactStatus = (group: StatusGroup) => {
    const resolved    = nameForUser(group.userId, group.userPhone);
    const visiblePhoto = visiblePhotoForUser(group.userId, group.photoURL);
    setViewerStatuses(group.statuses.map((s) => ({ ...s, displayName: resolved, photoURL: visiblePhoto })));
    setViewerIsOwner(false);
    setViewerVisible(true);
  };

  const handleDeleteStatus = async (statusId: string) => {
    const s = myStatuses.find((x) => x.statusId === statusId);
    if (s) {
      await deleteStatus(statusId, s.mediaUrl);
      setViewerStatuses((prev) => prev.filter((x) => x.statusId !== statusId));
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  const latestMyTime = myStatuses.length
    ? myStatuses.reduce((t, s) => (s.createdAt > t ? s.createdAt : t), myStatuses[0].createdAt)
    : null;

  return (
    <ScreenLayout active="status">
      <View style={styles.root}>
        <AppBg />

        {/* ── Header ────────────────────────────────────────────────────── */}
        <View style={[styles.header, { paddingTop: Platform.OS === 'web' ? 20 : insets.top + 14 }]}>
          <View>
            <AppText style={[styles.title, { color: textColor, fontFamily }]}>Updates</AppText>
            <AppText style={[styles.subtitle, { color: FG.secondary, fontFamily }]}>
              {visibleContactStatuses.length
                ? `${visibleContactStatuses.length} contact${visibleContactStatuses.length === 1 ? '' : 's'} active`
                : 'Status from your contacts'}
            </AppText>
          </View>
          <TouchableOpacity
            style={[styles.headerBtn, { borderColor: FG.glassBorder }]}
            onPress={() => setCreateModalVisible(true)}
            activeOpacity={0.8}
          >
            <LinearGradient colors={GRADIENTS.primary} style={styles.headerBtnGrad}>
              <AppIcon name="add" size={20} color="#fff" fixedColor />
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* ── My Status card ────────────────────────────────────────────── */}
        <TouchableOpacity
          style={[styles.myCard, bevel]}
          activeOpacity={0.8}
          onPress={myStatuses.length > 0 ? handleViewMyStatus : () => setCreateModalVisible(true)}
        >
          {/* Avatar with ring when has status */}
          <View style={styles.meAvatarWrap}>
            {myStatuses.length > 0 ? (
              <LinearGradient colors={GRADIENTS.primary} style={styles.statusRing}>
                <View style={styles.statusRingInner}>
                  <UserAvatar size={50} />
                </View>
              </LinearGradient>
            ) : (
              <View style={styles.noStatusRing}>
                <UserAvatar size={50} />
              </View>
            )}
            {/* + badge */}
            <LinearGradient colors={GRADIENTS.primary} style={styles.mePlusBadge}>
              <AppIcon name="add" size={11} color="#fff" fixedColor />
            </LinearGradient>
          </View>

          <View style={styles.myCardBody}>
            <AppText style={[styles.myCardTitle, { color: textColor, fontFamily }]}>
              My Status
            </AppText>
            <AppText style={[styles.myCardSub, { color: FG.secondary, fontFamily }]}>
              {myStatuses.length > 0 && latestMyTime
                ? `${formatTimeAgo(latestMyTime)} · ${myStatuses.length} update${myStatuses.length === 1 ? '' : 's'}`
                : 'Tap to add a status update'}
            </AppText>
          </View>

          {myStatuses.length > 0 && (
            <TouchableOpacity
              onPress={() => setCreateModalVisible(true)}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              activeOpacity={0.7}
            >
              <LinearGradient colors={GRADIENTS.primary} style={styles.addMoreBtn}>
                <AppIcon name="add" size={17} color="#fff" fixedColor />
              </LinearGradient>
            </TouchableOpacity>
          )}
        </TouchableOpacity>

        {/* ── Divider + section label ───────────────────────────────────── */}
        <View style={styles.sectionRow}>
          <View style={[styles.sectionLine, { backgroundColor: FG.glassBorder }]} />
          <AppText style={[styles.sectionLabel, { color: FG.secondary, fontFamily }]}>
            {visibleContactStatuses.length > 0
              ? `RECENT  ·  ${visibleContactStatuses.length}`
              : 'RECENT UPDATES'}
          </AppText>
          <View style={[styles.sectionLine, { backgroundColor: FG.glassBorder }]} />
        </View>

        {/* ── List / empty / error ──────────────────────────────────────── */}
        {error ? (
          <View style={styles.empty}>
            <AppIcon name="alert-circle-outline" size={52} color={COLORS.sub} />
            <AppText style={[styles.emptyText, { color: FG.secondary }]}>{error}</AppText>
          </View>
        ) : visibleContactStatuses.length === 0 ? (
          <View style={styles.empty}>
            <View style={styles.emptyIconWrap}>
              <AppIcon name="aperture-outline" size={44} color={COLORS.blue} />
            </View>
            <AppText style={[styles.emptyTitle, { color: textColor, fontFamily }]}>
              {loading ? 'Loading…' : 'No updates yet'}
            </AppText>
            <AppText style={[styles.emptyText, { color: FG.secondary }]}>
              Status updates from your saved contacts appear here
            </AppText>
          </View>
        ) : (
          <FlatList
            data={visibleContactStatuses}
            keyExtractor={(item) => item.userId}
            renderItem={({ item }) => (
              <StatusRow
                item={item}
                nameForUser={nameForUser}
                visiblePhotoForUser={visiblePhotoForUser}
                onPress={handleViewContactStatus}
              />
            )}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
            removeClippedSubviews
            maxToRenderPerBatch={10}
            windowSize={8}
            initialNumToRender={12}
          />
        )}

        {/* ── Modals ────────────────────────────────────────────────────── */}
        <CreateStatusModal
          visible={createModalVisible}
          onClose={() => setCreateModalVisible(false)}
          onCreate={handleCreateStatus}
        />

        {viewerVisible && viewerStatuses.length > 0 && (
          <StatusViewer
            visible={viewerVisible}
            onClose={() => setViewerVisible(false)}
            statuses={viewerStatuses}
            initialIndex={0}
            currentUserId={userId || ''}
            onStatusViewed={markAsViewed}
            onDeleteStatus={viewerIsOwner && !isCompanion ? handleDeleteStatus : undefined}
          />
        )}
      </View>
    </ScreenLayout>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 2,
  },
  headerBtn: {
    borderRadius: RADIUS.md,
    overflow: 'hidden',
  },
  headerBtnGrad: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },

  // My status card
  myCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginHorizontal: 14,
    marginBottom: 20,
    borderRadius: RADIUS.xl,
    padding: 16,
    ...SHADOW.card,
  },
  meAvatarWrap: { position: 'relative' },
  noStatusRing: {
    borderRadius: 999,
    padding: 3,
    borderWidth: 2,
    borderColor: 'rgba(142,142,147,0.35)',
    borderStyle: 'dashed',
  },
  statusRing: { borderRadius: 999, padding: 3 },
  statusRingInner: {
    borderRadius: 999,
    padding: 2.5,
    backgroundColor: 'rgba(255,255,255,0.92)',
  },
  mePlusBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: COLORS.sky1,
    ...SHADOW.button,
  },
  myCardBody: { flex: 1, minWidth: 0 },
  myCardTitle: { fontSize: 15, fontWeight: '700' },
  myCardSub: { fontSize: 12, marginTop: 3 },
  addMoreBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },

  // Section divider
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 14,
  },
  sectionLine: {
    flex: 1,
    height: 1,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.1,
  },

  // List
  listContent: {
    paddingHorizontal: 14,
    paddingBottom: 110,
  },

  // Empty states
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 44,
  },
  emptyIconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(9,178,238,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 20,
  },
});
