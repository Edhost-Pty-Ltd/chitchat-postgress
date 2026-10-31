// ─── ChatPreviewModal ─────────────────────────────────────────────────────────
// iOS-style peek dialog: long-press a chat row to preview the recent messages
// in a 500-tall card WITHOUT opening the chat and WITHOUT marking anything read.
// Behaves like a dismissible dialog:
//   • tap the dimmed backdrop (anywhere outside)  → closes
//   • tap any message / the card body             → opens the chat instantly
// Smooth spring scale + fade on enter, quick fade-out on exit.

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Modal, Pressable, StyleSheet, ScrollView, ActivityIndicator, Text, Animated, Easing, TouchableOpacity, Dimensions, Alert,
} from 'react-native';
import { endpoints } from '../api/endpoints';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { COLORS, SHADOW } from '../types/theme';

// Bigger preview — ~65% of the screen height (capped so it never fills it)
const PREVIEW_HEIGHT = Math.min(640, Math.round(Dimensions.get('window').height * 0.65));

interface PreviewMessage {
  id: string;
  senderId: string;
  text: string;
  type: string;
  timestamp: Date | null;
}

function previewText(m: PreviewMessage): string {
  if (m.text) return m.text;
  switch (m.type) {
    case 'image': return '📷 Photo';
    case 'voice': return '🎤 Voice message';
    case 'video': return '🎥 Video';
    case 'file':  return '📎 File';
    case 'location': return '📍 Location';
    default: return '';
  }
}

function fmtTime(d: Date | null): string {
  if (!d) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export interface PreviewAction {
  key: string;
  label: string;
  icon: string;
  destructive?: boolean;
  /** Optional one-line explanation shown when the (i) icon is tapped / row long-pressed. */
  hint?: string;
  onPress: () => void;
}

interface Props {
  visible: boolean;
  chatId: string | null;
  currentUserId: string | null;
  displayName: string;
  actions?: PreviewAction[];
  onClose: () => void;
  onOpenChat: () => void;
}

export function ChatPreviewModal({
  visible, chatId, currentUserId, displayName, actions = [], onClose, onOpenChat,
}: Props) {
  const { textColor } = useTypography();
  const { FG, isDark } = useForeground();
  const { bevel } = useGlass();

  const [messages, setMessages] = useState<PreviewMessage[]>([]);
  const [loading, setLoading] = useState(true);
  // Keep the Modal mounted through the exit animation
  const [mounted, setMounted] = useState(false);

  const anim = useRef(new Animated.Value(0)).current; // 0 = hidden, 1 = shown

  // Enter / exit animation driver
  useEffect(() => {
    if (visible) {
      setMounted(true);
      Animated.spring(anim, {
        toValue: 1,
        useNativeDriver: true,
        friction: 8,
        tension: 90,
      }).start();
    } else if (mounted) {
      Animated.timing(anim, {
        toValue: 0,
        duration: 160,
        easing: Easing.in(Easing.ease),
        useNativeDriver: true,
      }).start(() => setMounted(false));
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read-only one-time fetch — never touches readBy/deliveredTo
  useEffect(() => {
    if (!visible || !chatId) return;
    let cancelled = false;
    setLoading(true);
    setMessages([]);
    (async () => {
      try {
        // Read-only page fetch — the REST read endpoint never records receipts,
        // so previewing cannot mark anything delivered/read.
        const res = await endpoints.listMessages(chatId, { limit: 40 });
        if (cancelled) return;
        if (res.ok) {
          // listMessages returns newest-first; reverse to show oldest→newest.
          const msgs: PreviewMessage[] = res.data.messages
            .map((m) => ({
              id: m.id,
              senderId: m.senderId ?? '',
              text: m.text ?? '',
              type: m.type ?? 'text',
              timestamp: m.createdAt ? new Date(m.createdAt) : null,
            }))
            .reverse();
          setMessages(msgs);
        }
      } catch (err) {
        console.warn('[ChatPreviewModal] fetch failed:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, chatId]);

  if (!mounted) return null;

  const backdropOpacity = anim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });
  const cardScale = anim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] });
  const cardOpacity = anim.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] });
  const cardTranslate = anim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      {/* Backdrop — tap anywhere outside the card to dismiss */}
      <Pressable style={styles.fill} onPress={onClose}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]} />

        <View style={styles.centerWrap} pointerEvents="box-none">
          {/* Card — tapping it (or any message) opens the chat */}
          <Animated.View
            style={[
              styles.card,
              {
                opacity: cardOpacity,
                transform: [{ scale: cardScale }, { translateY: cardTranslate }],
              },
            ]}
          >
            <Pressable style={[styles.cardInner, actions.length > 0 && styles.cardInnerWithActions]} onPress={() => { onClose(); onOpenChat(); }}>
              <View style={[StyleSheet.absoluteFill, styles.cardBg, { borderColor: FG.glassBorder }]}>
                <AppBg />
                <View style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: isDark ? 'rgba(28,32,40,0.86)' : 'rgba(255,255,255,0.80)' },
                ]} />
              </View>

              {/* Header */}
              <View style={styles.header}>
                <AppText style={[styles.title, { color: textColor }]} numberOfLines={1}>{displayName}</AppText>
                <AppText style={[styles.subtitle, { color: FG.secondary }]}>Tap to open · long-press preview</AppText>
              </View>

              {/* Messages */}
              {loading ? (
                <View style={styles.center}>
                  <ActivityIndicator size="small" color={COLORS.blue} />
                </View>
              ) : messages.length === 0 ? (
                <View style={styles.center}>
                  <AppIcon name="chatbubbles-outline" size={40} color={FG.secondary} />
                  <AppText style={[styles.empty, { color: FG.secondary }]}>No messages yet</AppText>
                </View>
              ) : (
                <ScrollView
                  style={{ flex: 1 }}
                  contentContainerStyle={{ padding: 12, gap: 8 }}
                  showsVerticalScrollIndicator={false}
                >
                  {messages.map((m) => {
                    const isOut = m.senderId === currentUserId;
                    const body = previewText(m);
                    if (!body) return null;
                    return (
                      <View key={m.id} style={[styles.row, isOut ? styles.rowOut : styles.rowIn]}>
                        {isOut ? (
                          <View style={[styles.bubble, styles.bubbleOut]}>
                            <Text style={styles.bubbleTextOut}>{body}</Text>
                            <Text style={styles.timeOut}>{fmtTime(m.timestamp)}</Text>
                          </View>
                        ) : (
                          <View style={[styles.bubble, styles.bubbleIn, bevel]}>
                            <Text style={[styles.bubbleTextIn, { color: textColor }]}>{body}</Text>
                            <Text style={[styles.timeIn, { color: FG.secondary }]}>{fmtTime(m.timestamp)}</Text>
                          </View>
                        )}
                      </View>
                    );
                  })}
                </ScrollView>
              )}

            </Pressable>

            {/* Actions — a separate card below the preview (not inside the
                tap-to-open Pressable, so these taps run their own handlers) */}
            {actions.length > 0 && (
              <View style={[styles.actionsCard, { borderColor: FG.glassBorder }]}>
                {/* Opaque background layer so the rows are clearly visible */}
                <View style={StyleSheet.absoluteFill}>
                  <AppBg />
                  <View style={[
                    styles.actionsScrim,
                    { backgroundColor: isDark ? 'rgba(28,32,40,0.86)' : 'rgba(255,255,255,0.80)' },
                  ]} />
                </View>
                {actions.map((a, i) => (
                  <TouchableOpacity
                    key={a.key}
                    style={[styles.actionRow, i < actions.length - 1 && styles.actionRowBorder]}
                    activeOpacity={0.7}
                    onPress={a.onPress}
                    onLongPress={() => a.hint && Alert.alert(a.label, a.hint)}
                    delayLongPress={300}
                  >
                    <AppIcon
                      name={a.icon as any}
                      size={20}
                      color={a.destructive ? COLORS.missed : COLORS.blue}
                      fixedColor
                    />
                    <AppText style={[styles.actionLabel, { color: a.destructive ? COLORS.missed : textColor }]}>
                      {a.label}
                    </AppText>
                    {a.hint ? (
                      <TouchableOpacity
                        style={styles.actionInfo}
                        hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                        onPress={() => Alert.alert(a.label, a.hint!)}
                      >
                        <AppIcon name="information-circle-outline" size={18} color={FG.secondary} />
                      </TouchableOpacity>
                    ) : null}
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </Animated.View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.45)' },
  centerWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 24 },
  card: {
    width: '100%',
    maxHeight: '100%',
    borderRadius: 24,
  },
  cardInner: { height: PREVIEW_HEIGHT, borderRadius: 24, overflow: 'hidden', ...SHADOW.glow },
  // When actions are shown, let the preview take the remaining space and shrink
  // gracefully so both the (scrollable) messages and the actions fit on screen.
  cardInnerWithActions: { height: undefined, flex: 1, minHeight: 260 },
  cardBg: { borderRadius: 24, borderWidth: 1, overflow: 'hidden' },

  actionsCard: {
    marginTop: 12,
    borderRadius: 18,
    borderWidth: 1,
    overflow: 'hidden',
    ...SHADOW.glow,
  },
  // Scrim over AppBg so the action rows are clearly readable (color set inline per theme)
  actionsScrim: {
    ...StyleSheet.absoluteFill,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 18,
  },
  actionRowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(150,150,160,0.15)',
  },
  actionLabel: { fontSize: 15, fontWeight: '600' },
  actionInfo: { marginLeft: 'auto', padding: 2 },

  header: {
    paddingHorizontal: 18, paddingTop: 16, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(150,150,160,0.18)',
  },
  title: { fontSize: 17, fontWeight: '700' },
  subtitle: { fontSize: 12, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  empty: { fontSize: 14 },

  row: { flexDirection: 'row' },
  rowIn: { justifyContent: 'flex-start' },
  rowOut: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '78%', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleIn: { borderTopLeftRadius: 4 },
  bubbleOut: { backgroundColor: COLORS.blue, borderTopRightRadius: 4 },
  bubbleTextIn: { fontSize: 14, lineHeight: 19 },
  bubbleTextOut: { fontSize: 14, lineHeight: 19, color: '#fff' },
  timeIn: { fontSize: 10, marginTop: 3, alignSelf: 'flex-end' },
  timeOut: { fontSize: 10, marginTop: 3, alignSelf: 'flex-end', color: 'rgba(255,255,255,0.75)' },
});
