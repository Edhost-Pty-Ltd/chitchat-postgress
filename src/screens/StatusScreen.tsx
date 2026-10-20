// ─── Screen: Status ──────────────────────────────────────────────────────────
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, FlatList, TouchableOpacity, StyleSheet, Platform, ActivityIndicator, Image } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from '@react-navigation/native';
import { UserAvatar, StatusViewer, CreateStatusModal, BottomNav } from '../components';
import { endpoints } from '../api/endpoints';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { useAuth } from '../hooks/useAuth';
import { useAuth as useAuthContext } from '../context/AuthContext';
import { useStatus, type StatusGroup } from '../hooks/useStatus';
import { usePhoneBook } from '../hooks/usePhoneBook';
import { isVisibleTo } from '../hooks/usePrivacySettings';
import type { FireStatus } from '../types';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// ─── Helper Functions ─────────────────────────────────────────────────────────

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return 'Today';
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function stringToColor(str: string): string {
  const colors = ['#f97316','#8b5cf6','#ec4899','#06b6d4','#10b981','#f59e0b','#6366f1','#e11d48'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function StatusScreen() {
  const { user } = useAuth();
  const userId = user?.uid ?? null;
  // On a companion, auth.uid is the owner's uid, so statuses are the owner's.
  // isCompanion gates the owner-only actions (mark viewed, delete).
  const { isCompanion } = useAuthContext();
  const displayName = user?.displayName || user?.email || 'Unknown';
  const photoURL = user?.photoURL || null;

  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();
  const insets = useSafeAreaInsets();
  const { resolveName, contactsMap } = usePhoneBook();

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

  // Reload whenever this tab comes into focus so the status list is always fresh.
  useFocusEffect(
    useCallback(() => {
      reloadStatuses();
    }, [reloadStatuses]),
  );

  // ── Prefetch media so the viewer opens without a black frame ─────────────
  // Fire-and-forget: start downloading image URLs into the RN image cache as
  // soon as the status list arrives. By the time the user taps a row the image
  // is already local, so the viewer renders it instantly.
  const prefetchedRef = useRef(new Set<string>());
  useEffect(() => {
    const allStatuses = [
      ...myStatuses,
      ...contactStatuses.flatMap((g) => g.statuses),
    ];
    allStatuses.forEach((s) => {
      // Prefetch the main media URL for images, and the thumbnail for videos
      const urls = [
        s.mediaType === 'image'  ? s.mediaUrl       : null,
        s.mediaType === 'video'  ? s.thumbnailUrl   : null,
        s.photoURL,                                          // avatar
      ].filter((u): u is string => !!u && !prefetchedRef.current.has(u));

      urls.forEach((url) => {
        prefetchedRef.current.add(url);
        Image.prefetch(url).catch(() => {}); // silent — cache is best-effort
      });
    });
  }, [myStatuses, contactStatuses]);

  // ── Resolve poster names via phone book ─────────────────────────────────────
  // Status docs store a denormalized displayName (often "Unknown" for phone-auth
  // users). Per the app's contact-name rule we instead show the saved phone-book
  // contact name, else the phone number. We need each poster's phone: it's on
  // newer status docs (userPhone); for older docs we look it up from `users`.
  const [phoneMap, setPhoneMap] = useState<Map<string, string>>(new Map());
  // Cache of each poster's privacyProfilePhoto setting ('Everyone'|'Contacts'|'Nobody')
  const [statusPrivacyPhotoMap, setStatusPrivacyPhotoMap] = useState<Map<string, string>>(new Map());
  // Cache of each poster's privacyStatus setting (who can see their status updates)
  const [statusVisibilityMap, setStatusVisibilityMap] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const missing = contactStatuses
      .filter((g) => !g.userPhone && !phoneMap.has(g.userId))
      .map((g) => g.userId);
    // Also fetch privacy for any posters we don't have yet
    const missingPrivacy = contactStatuses
      .filter((g) => !statusPrivacyPhotoMap.has(g.userId) || !statusVisibilityMap.has(g.userId))
      .map((g) => g.userId);
    const allMissing = Array.from(new Set([...missing, ...missingPrivacy]));
    if (allMissing.length === 0) return;

    (async () => {
      const phoneUpdates      = new Map<string, string>();
      const privacyUpdates    = new Map<string, string>();
      const visibilityUpdates = new Map<string, string>();
      await Promise.all(
        allMissing.map(async (uid) => {
          try {
            const res = await endpoints.getUser(uid);
            if (res.ok) {
              const { phoneNumber, avatarObjectKey: _photo } = res.data;
              if (phoneNumber && !phoneMap.has(uid)) phoneUpdates.set(uid, phoneNumber);
              // Privacy fields aren't on the public profile — default to permissive
              // values so status posters' photos show unless explicitly hidden
              privacyUpdates.set(uid, 'Contacts');
              visibilityUpdates.set(uid, 'Everyone');
            }
          } catch { /* ignore */ }
        })
      );
      if (!cancelled) {
        if (phoneUpdates.size > 0) setPhoneMap((prev) => new Map([...prev, ...phoneUpdates]));
        if (privacyUpdates.size > 0) setStatusPrivacyPhotoMap((prev) => new Map([...prev, ...privacyUpdates]));
        if (visibilityUpdates.size > 0) setStatusVisibilityMap((prev) => new Map([...prev, ...visibilityUpdates]));
      }
    })();

    return () => { cancelled = true; };
  }, [contactStatuses]); // eslint-disable-line react-hooks/exhaustive-deps

  // Only show statuses from posters who are:
  //   1. Saved in the viewer's phone book (WhatsApp-style — you only see updates from contacts)
  //   2. Whose privacyStatus setting allows this viewer to see their updates
  // Posters whose phone hasn't loaded yet are withheld until we can verify (not optimistic).
  const visibleContactStatuses = contactStatuses.filter((g) => {
    // Must be a saved device contact.
    const phone = g.userPhone || phoneMap.get(g.userId) || null;
    if (!phone || !contactsMap.has(phone)) return false;

    // Must allow the viewer per their privacy setting.
    const setting = statusVisibilityMap.get(g.userId) ?? 'Everyone';
    return isVisibleTo(setting as any, true);
  });

  // Resolve the name to show for a poster: saved contact name → phone number.
  const nameForUser = (uid: string, userPhone: string | null): string => {
    const phone = userPhone || phoneMap.get(uid) || null;
    return resolveName(phone, phone ?? 'Unknown');
  };

  /** Return the poster's photoURL only if their privacyProfilePhoto allows it. */
  const visiblePhotoForUser = (uid: string, rawPhoto: string | null | undefined): string | null => {
    if (!rawPhoto) return null;
    const setting = statusPrivacyPhotoMap.get(uid) ?? 'Contacts';
    // All status viewers are contacts of the poster (they share statuses with contacts)
    if (!isVisibleTo(setting as any, true)) return null;
    return rawPhoto;
  };

  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [viewerVisible, setViewerVisible]           = useState(false);
  // Store the statuses to show in the viewer at open-time so they don't
  // change mid-view when viewingMyStatus/viewingStatuses state is cleared.
  const [viewerStatuses, setViewerStatuses]         = useState<FireStatus[]>([]);
  const [viewerIsOwner, setViewerIsOwner]           = useState(false);

  // ── Handle create status ────────────────────────────────────────────────────
  const handleCreateStatus = async (
    mediaType: 'image' | 'video' | 'text',
    mediaUri: string | null,
    caption: string | null,
    backgroundColor: string | null,
    textColor: string | null,
    durationMs?: number
  ) => {
    if (!userId) return;
    await createStatus(
      displayName, photoURL, mediaType, mediaUri, caption, backgroundColor, textColor,
      user?.phoneNumber ?? null,
      durationMs,
    );
  };

  // ── Handle view status ──────────────────────────────────────────────────────
  const handleViewMyStatus = () => {
    if (myStatuses.length === 0) return;
    setViewerStatuses(myStatuses);
    setViewerIsOwner(true);
    setViewerVisible(true);
  };

  const handleViewContactStatus = (group: StatusGroup) => {
    // Inject the phone-book-resolved name and privacy-filtered photo so the
    // viewer header shows the right name and hides photos that aren't allowed.
    const resolved = nameForUser(group.userId, group.userPhone);
    const visiblePhoto = visiblePhotoForUser(group.userId, group.photoURL);
    setViewerStatuses(group.statuses.map((s) => ({
      ...s,
      displayName: resolved,
      photoURL: visiblePhoto,
    })));
    setViewerIsOwner(false);
    setViewerVisible(true);
  };

  const handleCloseViewer = () => {
    setViewerVisible(false);
  };

  const handleDeleteStatus = async (statusId: string) => {
    const status = myStatuses.find((s) => s.statusId === statusId);
    if (status) {
      await deleteStatus(statusId, status.mediaUrl);
      // Remove from the viewer's local copy so it updates immediately
      setViewerStatuses((prev) => prev.filter((s) => s.statusId !== statusId));
    }
  };

  // ── Render status row ───────────────────────────────────────────────────────
  const renderStatus = ({ item }: { item: StatusGroup }) => {
    const name = nameForUser(item.userId, item.userPhone);
    const visiblePhoto = visiblePhotoForUser(item.userId, item.photoURL);
    const color = stringToColor(name);
    const initials = getInitials(name);

    return (
      <TouchableOpacity
        style={[styles.statusCard, bevel]}
        activeOpacity={0.75}
        onPress={() => handleViewContactStatus(item)}
      >
        {/* Avatar with gradient ring */}
        <LinearGradient
          colors={item.hasUnviewed ? [color, COLORS.blue] : ['#888888', '#666666']}
          style={styles.ring}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        >
          <View style={styles.ringInner}>
            {visiblePhoto ? (
              <Image source={{ uri: visiblePhoto }} style={styles.avatarImage} />
            ) : (
              <View style={[styles.avatarCircle, { backgroundColor: color }]}>
                <AppText style={styles.avatarText}>{initials}</AppText>
              </View>
            )}
          </View>
        </LinearGradient>

        <View style={styles.statusMeta}>
          <AppText style={[styles.statusName, { color: textColor, fontFamily }]}>
            {name}
          </AppText>
          <AppText style={[styles.statusTime, { color: FG.secondary }]}>
            {formatTimeAgo(item.latestTimestamp)}
          </AppText>
        </View>

        {item.hasUnviewed && (
          <View style={styles.unreadDot} />
        )}
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.root}>
      <AppBg />

      <View style={[styles.header, { backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder, borderBottomWidth: 1, paddingTop: Platform.OS === 'web' ? 16 : insets.top + 14 }]}>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>Updates</AppText>
      </View>

      {/* My Status glass card */}
      <TouchableOpacity
        style={[styles.myCard, bevel]}
        activeOpacity={0.8}
        onPress={myStatuses.length > 0 ? handleViewMyStatus : () => setCreateModalVisible(true)}
      >
        <View style={styles.meAvatarWrap}>
          {myStatuses.length > 0 ? (
            <LinearGradient colors={GRADIENTS.primary} style={styles.statusRing}>
              <View style={styles.statusRingInner}>
                <UserAvatar size={52} />
              </View>
            </LinearGradient>
          ) : (
            <UserAvatar size={52} />
          )}
          {myStatuses.length === 0 && (
            <LinearGradient colors={GRADIENTS.primary} style={styles.mePlusBadge}>
              <AppIcon name="add" size={12} color="#fff" fixedColor />
            </LinearGradient>
          )}
        </View>
        <View style={styles.myCardText}>
          <AppText style={[styles.myCardTitle, { color: FG.primary }]}>My Status</AppText>
          <AppText style={[styles.myCardSub, { color: FG.secondary }]}>
            {myStatuses.length > 0
              ? `${formatTimeAgo(myStatuses[0].createdAt)} • Tap to view`
              : 'Tap to add status update'}
          </AppText>
        </View>
        {myStatuses.length > 0 && (
          <TouchableOpacity
            onPress={() => setCreateModalVisible(true)}
            style={styles.addMoreBtn}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <AppIcon name="add-circle" size={28} color={COLORS.blue} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>

      {/* Loading / Error / Empty states */}
      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={COLORS.blue} />
          <AppText style={[styles.emptyText, { color: FG.secondary }]}>Loading statuses...</AppText>
        </View>
      ) : error ? (
        <View style={styles.centerContainer}>
          <AppIcon name="alert-circle-outline" size={52} color={COLORS.sub} />
          <AppText style={[styles.emptyText, { color: FG.secondary }]}>{error}</AppText>
        </View>
      ) : visibleContactStatuses.length === 0 ? (
        <>
          <AppText style={[styles.sectionText, { color: FG.secondary }]}>RECENT UPDATES</AppText>
          <View style={styles.centerContainer}>
            <AppIcon name="radio-button-off-outline" size={52} color={COLORS.sub} />
            <AppText style={[styles.emptyText, { color: FG.secondary }]}>
              No status updates yet
            </AppText>
            <AppText style={[styles.emptySubText, { color: FG.secondary }]}>
              Status updates from your contacts will appear here
            </AppText>
          </View>
        </>
      ) : (
        <>
          <AppText style={[styles.sectionText, { color: FG.secondary }]}>
            RECENT UPDATES ({visibleContactStatuses.length})
          </AppText>

          <FlatList
            data={visibleContactStatuses}
            keyExtractor={(item) => item.userId}
            renderItem={renderStatus}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          />
        </>
      )}



      {/* Create Status Modal */}
      <CreateStatusModal
        visible={createModalVisible}
        onClose={() => setCreateModalVisible(false)}
        onCreate={handleCreateStatus}
      />

      {/* Status Viewer */}
      {viewerVisible && viewerStatuses.length > 0 && (
        <StatusViewer
          visible={viewerVisible}
          onClose={handleCloseViewer}
          statuses={viewerStatuses}
          initialIndex={0}
          currentUserId={userId || ''}
          onStatusViewed={markAsViewed}
          // Companions can post and view but not delete — deleting a status
          // is owner-only on the backend.
          onDeleteStatus={viewerIsOwner && !isCompanion ? handleDeleteStatus : undefined}
        />
      )}

               <BottomNav active='status'/>
    </View>
    
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 0, paddingBottom: 14,
  },
  title:  { fontSize: 26, fontWeight: '800', color: COLORS.text },

  // My status — glass card
  myCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    marginHorizontal: 14, marginBottom: 18, marginTop: 10,
    borderRadius: RADIUS.lg, padding: 14,
  },
  meAvatarWrap: { position: 'relative' },
  statusRing: {
    borderRadius: 999,
    padding: 3,
  },
  statusRingInner: {
    borderRadius: 999,
    padding: 2,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  mePlusBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: COLORS.sky1,
  },
  myCardText:  { flex: 1 },
  myCardTitle: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  myCardSub:   { fontSize: 12, color: COLORS.sub, marginTop: 2 },
  addMoreBtn: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },

  sectionText: {
    fontSize: 10, fontWeight: '700', color: COLORS.sub,
    letterSpacing: 1.2, paddingHorizontal: 20, paddingBottom: 10,
  },

  listContent: { paddingHorizontal: 14, paddingBottom: 100 },

  // Glass card per status row
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  ring:       { borderRadius: 999, padding: 2.5 },
  ringInner:  { borderRadius: 999, padding: 2, backgroundColor: 'rgba(255,255,255,0.9)' },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  avatarText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
  },
  statusMeta: { flex: 1 },
  statusName: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  statusTime: { fontSize: 12, color: COLORS.sub, marginTop: 2 },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: COLORS.blue,
  },

  // Empty states
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.sub,
    textAlign: 'center',
  },
  emptySubText: {
    fontSize: 13,
    color: COLORS.sub,
    textAlign: 'center',
    marginTop: -6,
  },
});
