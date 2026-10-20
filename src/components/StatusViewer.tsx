// ─── Component: StatusViewer ──────────────────────────────────────────────────
// Full-screen WhatsApp-style story viewer with progress bars, tap navigation,
// video playback support, and auto-advance timer.

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Pressable,
  ActivityIndicator,
  StatusBar,
  Animated,
  ScrollView,
  GestureResponderEvent,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEventListener } from 'expo';
import { endpoints } from '../api/endpoints';
import { resolveNotificationName } from '../utils/resolveNotificationName';
import type { FireStatus } from '../types';
import { COLORS, SHADOW } from '../types/theme';

// Shape of a resolved viewer row in the "Viewed by" sheet
interface ViewerInfo {
  userId: string;
  name: string;
  photoURL: string | null;
}

// Vertical distance (px) a swipe must travel upward to open the viewers sheet
const SWIPE_UP_THRESHOLD = 60;

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface StatusViewerProps {
  visible: boolean;
  onClose: () => void;
  statuses: FireStatus[];
  initialIndex?: number;
  currentUserId: string;
  onStatusViewed: (statusId: string) => void;
  onDeleteStatus?: (statusId: string) => void;
}

// ─── Helper Functions ─────────────────────────────────────────────────────────

function formatTimeAgo(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── Component ────────────────────────────────────────────────────────────────

export function StatusViewer({
  visible,
  onClose,
  statuses,
  initialIndex = 0,
  currentUserId,
  onStatusViewed,
  onDeleteStatus,
}: StatusViewerProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [isPaused,     setIsPaused]     = useState(false);
  const [loading,      setLoading]      = useState(true);   // true until media is ready
  const [showOptions,  setShowOptions]  = useState(false);
  const [progress,     setProgress]     = useState(0);
  // mediaReady: flips to true when image onLoadEnd fires (or immediately for text).
  // The timer only starts once this is true — prevents the progress bar racing
  // ahead of a slow image load and showing a black screen mid-bar.
  const [mediaReady,   setMediaReady]   = useState(false);

  const timerRef          = useRef<ReturnType<typeof setInterval> | null>(null);
  const shouldAdvanceRef  = useRef(false);

  // ── Viewers sheet (owner only) ──────────────────────────────────────────
  const [viewersOpen,    setViewersOpen]    = useState(false);
  const [viewers,        setViewers]        = useState<ViewerInfo[]>([]);
  const [viewersLoading, setViewersLoading] = useState(false);
  const viewersAnim = useRef(new Animated.Value(0)).current;

  const currentStatus = statuses[currentIndex];
  const isOwner    = currentStatus?.userId === currentUserId;
  const isExcluded = currentStatus?.excludedUsers?.includes(currentUserId) || false;
  // Exclude the owner's own view from the count — you don't "view" your own status.
  const viewCount  = (currentStatus?.viewedBy || []).filter((id) => id !== currentUserId).length;
  const isVideo    = currentStatus?.mediaType === 'video';
  const isText     = currentStatus?.mediaType === 'text';

  // Image/text display duration: 7 s.
  const IMAGE_DURATION = 7000;

  // ── Video player ────────────────────────────────────────────────────────────
  // Pass the initial URL directly so the player starts buffering immediately —
  // no null→replace cycle on first render.
  const initialVideoUrl = (isVideo && currentStatus?.mediaUrl) ? currentStatus.mediaUrl : null;
  const player = useVideoPlayer(initialVideoUrl, (p) => {
    p.loop = false;
    p.timeUpdateEventInterval = 0.1;
  });
  const videoReadyRef = useRef(false);

  const goNext = useCallback(() => {
    if (currentIndex < statuses.length - 1) {
      setCurrentIndex(currentIndex + 1);
      setProgress(0);
    } else {
      onClose();
    }
  }, [currentIndex, statuses.length, onClose]);

  // ── Open the "Viewed by" sheet — pauses the status & loads viewer info ────
  const openViewers = useCallback(async () => {
    if (!isOwner || !currentStatus) return;
    setIsPaused(true);
    setViewersOpen(true);
    Animated.spring(viewersAnim, {
      toValue: 1, useNativeDriver: true, friction: 9, tension: 65,
    }).start();

    // Exclude the owner — you shouldn't appear in your own viewers list.
    const ids = (currentStatus.viewedBy || []).filter((id) => id !== currentUserId);
    if (ids.length === 0) { setViewers([]); return; }

    setViewersLoading(true);
    try {
      const rows = await Promise.all(
        ids.map(async (uid): Promise<ViewerInfo> => {
          try {
            const res = await endpoints.getUser(uid);
            if (res.ok) {
              const name = res.data.displayName
                ?? (res.data.phoneNumber ? await resolveNotificationName(res.data.phoneNumber) : 'Unknown');
              return { userId: uid, name, photoURL: res.data.avatarObjectKey ?? null };
            }
            return { userId: uid, name: 'Unknown', photoURL: null };
          } catch {
            return { userId: uid, name: 'Unknown', photoURL: null };
          }
        }),
      );
      setViewers(rows);
    } finally {
      setViewersLoading(false);
    }
  }, [isOwner, currentStatus, currentUserId, viewersAnim]);

  const closeViewers = useCallback(() => {
    Animated.timing(viewersAnim, {
      toValue: 0, duration: 180, useNativeDriver: true,
    }).start(() => {
      setViewersOpen(false);
      setIsPaused(false);
    });
  }, [viewersAnim]);

  // ── Load video when current item changes ───────────────────────────────────
  useEffect(() => {
    if (!visible || !currentStatus) return;
    if (isVideo && currentStatus.mediaUrl) {
      videoReadyRef.current = false;
      setLoading(true);
      setMediaReady(false);
      // replace unconditionally — expo-video deduplicates internally if URL is same
        player.replace(currentStatus.mediaUrl);
      if (!isPaused) player.play();
    } else {
      try { player.pause(); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStatus?.statusId, visible, isVideo]);

  // Video: progress from timeUpdate; hide loading once first frame arrives
  useEventListener(player, 'timeUpdate', ({ currentTime }: { currentTime: number }) => {
    if (!isVideo) return;
    if (currentTime > 0) {
      videoReadyRef.current = true;
      setLoading(false);
      setMediaReady(true);
    }
    const dur = player.duration && player.duration > 0 ? player.duration : 30;
    setProgress(Math.min(currentTime / dur, 1));
  });

  // Advance on playToEnd only once video has genuinely played
  useEventListener(player, 'playToEnd', () => {
    if (isVideo && videoReadyRef.current) goNext();
  });

  // Pause / resume video on long-press
  useEffect(() => {
    if (!isVideo) return;
    if (isPaused) { try { player.pause(); } catch {} }
    else          { try { player.play();  } catch {} }
  }, [isPaused, isVideo]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset mediaReady when item changes (images/text) ──────────────────────
  // For images: check if the URL is already in the RN disk/memory cache.
  // If it is, skip the loading overlay entirely — image renders in one frame.
  useEffect(() => {
    if (isVideo) return; // video handles its own ready state above
    setProgress(0);
    shouldAdvanceRef.current = false;

    if (isText) {
      // Text has no network load
      setLoading(false);
      setMediaReady(true);
      return;
    }

    const url = currentStatus?.mediaUrl;
    if (!url) {
      setLoading(false);
      setMediaReady(true);
      return;
    }

    // queryCache returns a map of url → cache type ('memory'|'disk'|'disk/memory')
    // If the entry exists, the image is already decoded — skip the loading state.
    // Guard: queryCache may be undefined on older RN bridge versions.
    const qc = Image.queryCache;
    if (!qc) {
      setLoading(true);
      setMediaReady(false);
      return;
    }
    qc([url]).then((result) => {
      if (result[url]) {
        // Already cached — show image immediately, no loading overlay
        setLoading(false);
        setMediaReady(true);
      } else {
        // Not cached yet — show gradient overlay until onLoadEnd fires
        setLoading(true);
        setMediaReady(false);
      }
    }).catch(() => {
      // queryCache not supported (Android) — fall back to showing loader
      setLoading(true);
      setMediaReady(false);
    });
  }, [currentIndex, isVideo, isText, currentStatus?.mediaUrl]);

  // ── Image / text timer — starts only after mediaReady ─────────────────────
  useEffect(() => {
    if (!visible || isPaused || !currentStatus || isVideo || !mediaReady) return;

    // Mark as viewed
    if (!currentStatus.viewedBy.includes(currentUserId)) {
      onStatusViewed(currentStatus.statusId);
    }

    const interval  = 50;
    const increment = interval / IMAGE_DURATION;

    timerRef.current = setInterval(() => {
      setProgress((prev) => {
        const next = prev + increment;
        if (next >= 1) {
          shouldAdvanceRef.current = true;
          return 1;
        }
        return next;
      });
    }, interval);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [visible, currentIndex, isPaused, isVideo, mediaReady, currentStatus, currentUserId, onStatusViewed, goNext]);

  // Mark video statuses viewed immediately on open
  useEffect(() => {
    if (!visible || !currentStatus || !isVideo) return;
    if (!currentStatus.viewedBy.includes(currentUserId)) {
      onStatusViewed(currentStatus.statusId);
    }
  }, [visible, currentIndex, isVideo, currentStatus, currentUserId, onStatusViewed]);

  // Advance after timer completes
  useEffect(() => {
    if (progress >= 1 && shouldAdvanceRef.current) {
      shouldAdvanceRef.current = false;
      goNext();
    }
  }, [progress, goNext]);

  // ── Reset state when modal opens ────────────────────────────────────────────
  useEffect(() => {
    if (visible) {
      setCurrentIndex(initialIndex);
      setProgress(0);
      setShowOptions(false);
    } else {
      // Stop video when closing
      try { player.pause(); } catch {}
    }
  }, [visible, initialIndex]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Navigation handlers ────────────────────────────────────────────────────
  const handleTapLeft = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
      setProgress(0);
    } else {
      onClose();
    }
  }, [currentIndex, onClose]);

  const handleTapRight = useCallback(() => {
    goNext();
  }, [goNext]);

  // ── Gesture handling via responder system ──────────────────────────────────
  // Pressable/TouchableOpacity don't work reliably over VideoView (native SurfaceView)
  // on Android. The responder system fires at the JS bridge level BEFORE native views
  // consume the touch, making it work regardless of what's underneath.
  const touchStartXRef    = useRef(0);
  const touchStartYRef    = useRef(0);
  const touchStartTimeRef = useRef(0);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleTouchStart = useCallback((e: GestureResponderEvent) => {
    touchStartXRef.current    = e.nativeEvent.locationX;
    touchStartYRef.current    = e.nativeEvent.pageY;
    touchStartTimeRef.current = Date.now();
    longPressTimerRef.current = setTimeout(() => {
      setIsPaused(true);
    }, 200);
  }, []);

  const handleTouchEnd = useCallback((e: GestureResponderEvent) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    // Swipe-up → open the viewers sheet (owner only). Checked before tap logic.
    const dy = touchStartYRef.current - e.nativeEvent.pageY; // positive = upward
    if (isOwner && dy >= SWIPE_UP_THRESHOLD) {
      openViewers();
      return;
    }

    const elapsed = Date.now() - touchStartTimeRef.current;
    if (isPaused && elapsed >= 200) {
      setIsPaused(false);
      return;
    }
    if (elapsed > 400) return;
    const tapX = e.nativeEvent.locationX;
    if (tapX < SCREEN_WIDTH / 3) {
      handleTapLeft();
    } else {
      handleTapRight();
    }
  }, [isPaused, isOwner, openViewers, handleTapLeft, handleTapRight]);

  const handleDelete = () => {
    if (onDeleteStatus && currentStatus) {
      onDeleteStatus(currentStatus.statusId);
      if (statuses.length > 1) {
        if (currentIndex === statuses.length - 1) {
          setCurrentIndex(currentIndex - 1);
        }
      } else {
        onClose();
      }
    }
  };

  if (!visible || !currentStatus) return null;

  // Show "Me" when viewing your own status; otherwise the resolved name.
  const displayName = isOwner ? 'Me' : (currentStatus.displayName || 'Unknown');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <StatusBar hidden />
      <View
        style={styles.container}
        // Stop capturing touches while the viewers sheet is open so its own
        // buttons / scroll receive the gestures instead of the story area.
        onStartShouldSetResponder={() => !viewersOpen}
        onResponderGrant={handleTouchStart}
        onResponderRelease={handleTouchEnd}
      >
        {/* Layer 1: media background */}
        <View style={styles.background}>
          {isExcluded ? (
            /* Blocked message */
            <View style={styles.blockedContainer}>
              <Ionicons name="ban-outline" size={64} color="rgba(255,255,255,0.6)" />
              <Text style={styles.blockedTitle}>Status Hidden</Text>
              <Text style={styles.blockedMessage}>
                {currentStatus.displayName} blocked you from seeing this status
              </Text>
            </View>
          ) : currentStatus.mediaType === 'image' && currentStatus.mediaUrl ? (
            <Image
              source={{ uri: currentStatus.mediaUrl }}
              style={styles.media}
              resizeMode="contain"
              onLoadStart={() => { /* loading state managed by queryCache check */ }}
              onLoadEnd={() => {
                setLoading(false);
                // Only set mediaReady if not already set by queryCache — avoids
                // restarting the timer on a redundant onLoadEnd from cached images
                setMediaReady((prev) => prev ? prev : true);
              }}
            />
          ) : currentStatus.mediaType === 'video' && currentStatus.mediaUrl ? (
            /* pointerEvents="none" lets touches pass through to the tapZones above */
            <View style={styles.media} pointerEvents="none">
              <VideoView
                player={player}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                nativeControls={false}
              />
            </View>
          ) : currentStatus.mediaType === 'text' ? (
            <LinearGradient
              colors={[currentStatus.backgroundColor || '#1a7fe8', '#0a5bb8']}
              style={styles.textBackground}
            >
              <Text style={[styles.textContent, { color: currentStatus.textColor || '#ffffff' }]}>
                {currentStatus.caption}
              </Text>
            </LinearGradient>
          ) : (
            <View style={styles.textBackground}>
              <Ionicons name="image-outline" size={64} color="rgba(255,255,255,0.4)" />
              <Text style={styles.missingText}>This status can't be displayed</Text>
            </View>
          )}
        </View>

        {/* Layer 2: decorative gradients — never capture touches */}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(0,0,0,0.6)', 'transparent']}
          style={styles.topGradient}
        />
        {(currentStatus.caption || isOwner) && (
          <LinearGradient
            pointerEvents="none"
            colors={['transparent', 'rgba(0,0,0,0.6)']}
            style={styles.bottomGradient}
          />
        )}

        {/* Loading overlay — gradient placeholder so the viewer never shows pure black.
            Shown while the image is fetching or the video hasn't sent its first frame. */}
        {loading && (
          <View style={styles.loadingOverlay} pointerEvents="none">
            <LinearGradient
              colors={['#0a1628', '#1a3a5c', '#0d2137']}
              style={StyleSheet.absoluteFill}
            />
            <ActivityIndicator size="large" color="rgba(255,255,255,0.85)" />
          </View>
        )}

        {/* Layer 4: top controls (progress bars + header) — above tap zones */}
        <View style={styles.topControls} pointerEvents="box-none">
          {/* Progress bars */}
          <View style={styles.progressContainer}>
            {statuses.map((_, index) => (
              <View key={index} style={styles.progressBarBg}>
                <View
                  style={[
                    styles.progressBarFill,
                    {
                      width:
                        index < currentIndex
                          ? '100%'
                          : index === currentIndex
                          ? `${Math.round(progress * 100)}%`
                          : '0%',
                    },
                  ]}
                />
              </View>
            ))}
          </View>

          {/* Header */}
          <View style={styles.header}>
            <View style={styles.userInfo}>
              <View style={styles.avatar}>
                {currentStatus.photoURL ? (
                  <Image source={{ uri: currentStatus.photoURL }} style={styles.avatarImage} />
                ) : (
                  <View style={[styles.avatarPlaceholder, { backgroundColor: COLORS.blue }]}>
                    <Text style={styles.avatarText}>
                      {displayName.charAt(0).toUpperCase()}
                    </Text>
                  </View>
                )}
              </View>
              <View style={styles.userMeta}>
                <Text style={styles.userName}>{displayName}</Text>
                <Text style={styles.timestamp}>{formatTimeAgo(currentStatus.createdAt)}</Text>
              </View>
            </View>

            <View style={styles.headerActions}>
              {isOwner && (
                <TouchableOpacity
                  onPress={() => setShowOptions(!showOptions)}
                  style={styles.iconButton}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <Ionicons name="ellipsis-vertical" size={22} color="#ffffff" />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={onClose}
                style={styles.iconButton}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="close" size={28} color="#ffffff" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Options menu */}
          {showOptions && isOwner && (
            <View style={styles.optionsMenu}>
              <TouchableOpacity style={styles.optionItem} onPress={handleDelete}>
                <Ionicons name="trash-outline" size={20} color="#ff4444" />
                <Text style={styles.optionText}>Delete</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Layer 5: bottom info (caption + view count) */}
        {(currentStatus.caption || isOwner) && (
          <View style={styles.bottomInfo} pointerEvents="box-none">
            {currentStatus.caption && currentStatus.mediaType !== 'text' && (
              <Text style={[styles.caption, { textAlign: 'center' }]}>{currentStatus.caption}</Text>
            )}
            {isOwner && (
              <TouchableOpacity
                style={styles.viewsContainer}
                onPress={openViewers}
                activeOpacity={0.7}
              >
                <Ionicons name="chevron-up" size={18} color="#ffffff" />
                <View style={styles.viewsCountRow}>
                  <Ionicons name="eye-outline" size={16} color="#ffffff" />
                  <Text style={styles.viewsText}>
                    {viewCount} {viewCount === 1 ? 'view' : 'views'}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Viewers bottom sheet (owner only) ── */}
        {viewersOpen && (
          <>
            <Pressable style={styles.viewersBackdrop} onPress={closeViewers} />
            <Animated.View
              style={[
                styles.viewersSheet,
                {
                  transform: [{
                    translateY: viewersAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [SCREEN_HEIGHT * 0.55, 0],
                    }),
                  }],
                },
              ]}
            >
              <View style={styles.viewersHandle} />
              <View style={styles.viewersHeader}>
                <Ionicons name="eye-outline" size={18} color="#fff" />
                <Text style={styles.viewersTitle}>
                  Viewed by {viewCount}
                </Text>
                <TouchableOpacity onPress={closeViewers} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={22} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
              </View>

              {viewersLoading ? (
                <View style={styles.viewersEmpty}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              ) : viewers.length === 0 ? (
                <View style={styles.viewersEmpty}>
                  <Ionicons name="eye-off-outline" size={36} color="rgba(255,255,255,0.4)" />
                  <Text style={styles.viewersEmptyText}>No views yet</Text>
                </View>
              ) : (
                <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: SCREEN_HEIGHT * 0.42 }}>
                  {viewers.map((v) => (
                    <View key={v.userId} style={styles.viewerRow}>
                      {v.photoURL ? (
                        <Image source={{ uri: v.photoURL }} style={styles.viewerAvatar} />
                      ) : (
                        <View style={[styles.viewerAvatar, styles.viewerAvatarFallback]}>
                          <Text style={styles.viewerAvatarInitial}>
                            {v.name.charAt(0).toUpperCase()}
                          </Text>
                        </View>
                      )}
                      <Text style={styles.viewerName} numberOfLines={1}>{v.name}</Text>
                    </View>
                  ))}
                </ScrollView>
              )}
            </Animated.View>
          </>
        )}
      </View>
    </Modal>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  background: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
  },
  media: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
  },
  textBackground: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  textContent: {
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 42,
  },
  blockedContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  blockedTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    marginTop: 20,
    marginBottom: 12,
  },
  blockedMessage: {
    fontSize: 16,
    color: 'rgba(255,255,255,0.8)',
    textAlign: 'center',
    lineHeight: 22,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  topGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 160,
  },
  topControls: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 50,
    paddingBottom: 20,
  },
  progressContainer: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 8,
    marginBottom: 12,
  },
  progressBarBg: {
    flex: 1,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    borderRadius: 1,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
  },
  userInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    overflow: 'hidden',
    ...SHADOW.card,
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarPlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
  },
  userMeta: {
    flex: 1,
  },
  userName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
  },
  timestamp: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 2,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  optionsMenu: {
    position: 'absolute',
    top: 100,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.9)',
    borderRadius: 12,
    padding: 8,
    minWidth: 150,
    ...SHADOW.card,
  },
  optionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  optionText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
  },
  bottomGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 140,
  },
  bottomInfo: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 16,
    paddingTop: 40,
    paddingBottom: 30,
    alignItems: 'center',
  },
  missingText: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.7)',
    marginTop: 12,
    textAlign: 'center',
  },
  caption: {
    fontSize: 15,
    color: '#ffffff',
    marginBottom: 12,
    lineHeight: 20,
  },
  viewsContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    alignSelf: 'center',
  },
  viewsCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  viewsText: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
  },
  tapZones: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
  },
  tapLeft: {
    flex: 1,
  },
  tapRight: {
    flex: 1,
  },

  // ── Viewers sheet ──────────────────────────────────────────────────────────
  viewersBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  viewersSheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: SCREEN_HEIGHT * 0.55,
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 8,
    paddingBottom: 34,
    paddingHorizontal: 16,
  },
  viewersHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)',
    alignSelf: 'center',
    marginBottom: 12,
  },
  viewersHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingBottom: 12,
    marginBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.12)',
  },
  viewersTitle: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
  },
  viewersEmpty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 36,
    gap: 10,
  },
  viewersEmptyText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.5)',
  },
  viewerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  viewerAvatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  viewerAvatarFallback: {
    backgroundColor: COLORS.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerAvatarInitial: {
    fontSize: 17,
    fontWeight: '700',
    color: '#ffffff',
  },
  viewerName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: '#ffffff',
  },
});
