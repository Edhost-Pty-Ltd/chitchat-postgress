// ─── ChatPreviewModal ─────────────────────────────────────────────────────────
// iOS-style peek dialog: long-press a chat row to preview the recent messages
// in a 500-tall card WITHOUT opening the chat and WITHOUT marking anything read.
// Behaves like a dismissible dialog:
//   • tap the dimmed backdrop (anywhere outside)  → closes
//   • tap any message / the card body             → opens the chat instantly
// Smooth spring scale + fade on enter, quick fade-out on exit.

import React, { useEffect, useRef, useState } from 'react';
import {
  View, Modal, Pressable, StyleSheet, ScrollView, ActivityIndicator, Text, Animated, Easing,
} from 'react-native';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { LinearGradient } from 'expo-linear-gradient';

const PREVIEW_HEIGHT = 500;

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

interface Props {
  visible: boolean;
  chatId: string | null;
  currentUserId: string | null;
  displayName: string;
  onClose: () => void;
  onOpenChat: () => void;
}

export function ChatPreviewModal({
  visible, chatId, currentUserId, displayName, onClose, onOpenChat,
}: Props) {
  const { textColor } = useTypography();
  const { FG } = useForeground();
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
        const fsDb = db as ReturnType<typeof firestore>;
        const snap = await fsDb
          .collection('chats').doc(chatId).collection('messages')
          .orderBy('timestamp', 'desc')
          .limit(40)
          .get();
        if (cancelled) return;
        const msgs: PreviewMessage[] = snap.docs.map((d) => {
          const data = d.data();
          const ts = data.timestamp;
          return {
            id: d.id,
            senderId: data.senderId ?? '',
            text: data.text ?? '',
            type: data.type ?? 'text',
            timestamp: ts?.toDate ? ts.toDate() : null,
          };
        }).reverse();
        setMessages(msgs);
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
            <Pressable style={styles.cardInner} onPress={() => { onClose(); onOpenChat(); }}>
              <View style={[StyleSheet.absoluteFill, styles.cardBg, { backgroundColor: FG.glassBg, borderColor: FG.glassBorder }]}>
                <AppBg />
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

              {/* Open button */}
              <View style={styles.openBtn}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.openBtnGrad}>
                  <AppIcon name="chatbubble-ellipses-outline" size={18} color="#fff" fixedColor />
                  <AppText fixedColor style={styles.openBtnText}>Open chat</AppText>
                </LinearGradient>
              </View>
            </Pressable>
          </Animated.View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.45)' },
  centerWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: 20 },
  card: {
    height: PREVIEW_HEIGHT,
    width: '100%',
    borderRadius: 24,
    ...SHADOW.glow,
  },
  cardInner: { flex: 1, borderRadius: 24, overflow: 'hidden' },
  cardBg: { borderRadius: 24, borderWidth: 1, overflow: 'hidden' },

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

  openBtn: { margin: 12, borderRadius: RADIUS.md, overflow: 'hidden' },
  openBtnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 13,
  },
  openBtnText: { fontSize: 15, fontWeight: '700', color: '#fff' },
});
