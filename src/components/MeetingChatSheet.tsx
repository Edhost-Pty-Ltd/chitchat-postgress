// ─── MeetingChatSheet ────────────────────────────────────────────────────────
// Small chat sheet used inside a meeting. Messages broadcast to all joined
// participants via meetings/{meetingId}/messages. System messages (recaps,
// auto-generated minutes) also flow through the same collection.

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, FlatList, TouchableOpacity, StyleSheet, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator, Modal,
  Animated, Easing,
} from 'react-native';
import firestore from '@react-native-firebase/firestore';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';

interface Props {
  visible: boolean;
  meetingId: string;
  userId: string;
  userDisplayName: string;
  onClose: () => void;
}

interface ChatMsg {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: any;
  isSystem?: boolean;
}

const fmtTime = (ts: any) => {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function MeetingChatSheet({ visible, meetingId, userId, userDisplayName, onClose }: Props) {
  const { textColor } = useTypography();
  const { FG }        = useForeground();
  const { bevel }     = useGlass();

  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loading, setLoading]   = useState(true);
  const [input, setInput]       = useState('');
  const [sending, setSending]   = useState(false);
  const listRef = useRef<FlatList<ChatMsg>>(null);
  const slide   = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    const unsub = firestore()
      .collection('meetings').doc(meetingId).collection('messages')
      .orderBy('timestamp', 'asc')
      .onSnapshot(
        snap => {
          setMessages(
            snap.docs.map(d => {
              const data = d.data();
              return {
                id: d.id,
                senderId: data.senderId ?? '',
                senderName: data.senderName ?? 'Unknown',
                text: data.text ?? '',
                timestamp: data.timestamp,
                isSystem: !!data.isSystem,
              };
            })
          );
          setLoading(false);
          requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
        },
        err => {
          console.error('[MeetingChatSheet] snapshot error:', err);
          setLoading(false);
        }
      );
    return () => unsub();
  }, [visible, meetingId]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !userId) return;
    setInput('');
    setSending(true);
    try {
      await firestore()
        .collection('meetings').doc(meetingId).collection('messages')
        .add({
          senderId: userId,
          senderName: userDisplayName,
          text,
          timestamp: firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) {
      console.error('[MeetingChatSheet] send failed:', e);
    } finally {
      setSending(false);
    }
  }, [input, userId, userDisplayName, meetingId]);

  if (!visible) return null;

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.overlay, { opacity: slide }]}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />

        <Animated.View
          style={[
            styles.panel,
            { backgroundColor: FG.glassBg, borderColor: FG.glassBorder },
            { transform: [{ translateY }] },
          ]}
        >
          <AppBg />
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} style={styles.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="chevron-down" size={22} color={COLORS.sub} />
            </TouchableOpacity>
            <View style={{ flex: 1, alignItems: 'center' }}>
              <AppText style={[styles.headerTitle, { color: textColor }]}>Meeting chat</AppText>
              <AppText style={[styles.headerSub, { color: FG.secondary }]}>
                Visible to all participants
              </AppText>
            </View>
            <View style={styles.headerBtn} />
          </View>

          {loading ? (
            <View style={styles.centerPad}>
              <ActivityIndicator size="small" color={COLORS.blue} />
            </View>
          ) : (
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              {messages.length === 0 ? (
                <View style={styles.centerPad}>
                  <AppIcon name="chatbubbles-outline" size={40} color={COLORS.sub} />
                  <AppText style={{ color: FG.secondary, marginTop: 10, fontSize: 13 }}>
                    No messages yet — say hi to the room.
                  </AppText>
                </View>
              ) : (
                <FlatList
                  ref={listRef}
                  data={messages}
                  keyExtractor={m => m.id}
                  contentContainerStyle={styles.listContent}
                  showsVerticalScrollIndicator={false}
                  onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
                  renderItem={({ item }) => {
                    const mine = item.senderId === userId;
                    const isSystem = !!item.isSystem || item.senderId === 'system';

                    if (isSystem) {
                      return (
                        <View style={styles.systemRow}>
                          <View style={styles.systemCard}>
                            <View style={styles.systemHeader}>
                              <AppIcon name="sparkles-outline" size={13} color={COLORS.blue} />
                              <AppText style={styles.systemName}>{item.senderName}</AppText>
                              <AppText style={styles.systemTime}>{fmtTime(item.timestamp)}</AppText>
                            </View>
                            <AppText style={styles.systemText}>{item.text}</AppText>
                          </View>
                        </View>
                      );
                    }

                    return (
                      <View style={[styles.row, mine ? styles.rowMine : styles.rowOther]}>
                        {!mine && (
                          <AppText style={[styles.senderName, { color: COLORS.blue }]} numberOfLines={1}>
                            {item.senderName}
                          </AppText>
                        )}
                        <View style={[
                          styles.bubble,
                          mine ? styles.bubbleMine : styles.bubbleOther,
                        ]}>
                          <AppText style={[styles.bubbleText, { color: mine ? '#fff' : textColor }]}>
                            {item.text}
                          </AppText>
                          <AppText style={[
                            styles.bubbleTime,
                            { color: mine ? 'rgba(255,255,255,0.75)' : FG.secondary },
                          ]}>
                            {fmtTime(item.timestamp)}
                          </AppText>
                        </View>
                      </View>
                    );
                  }}
                />
              )}
              <View style={[styles.inputRow, { borderTopColor: FG.glassBorder }]}>
                <View style={[styles.inputWrap, bevel, { borderColor: FG.glassBorder }]}>
                  <TextInput
                    style={[styles.input, { color: textColor }]}
                    placeholder="Message the room…"
                    placeholderTextColor={COLORS.sub}
                    value={input}
                    onChangeText={setInput}
                    multiline
                    maxLength={500}
                    onSubmitEditing={handleSend}
                    returnKeyType="send"
                    blurOnSubmit={false}
                  />
                </View>
                <TouchableOpacity
                  onPress={handleSend}
                  disabled={!input.trim() || sending}
                  style={[styles.sendBtn, (!input.trim() || sending) && { opacity: 0.4 }]}
                  activeOpacity={0.85}
                >
                  <LinearGradient colors={GRADIENTS.primary} style={styles.sendBtnInner}>
                    {sending
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <AppIcon name="send" size={16} color="#fff" fixedColor />}
                  </LinearGradient>
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          )}
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.35)' },
  panel: {
    height: '58%',
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1,
    overflow: 'hidden',
    ...SHADOW.glow,
  },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  headerBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerTitle: { fontSize: 14, fontWeight: '700' },
  headerSub: { fontSize: 11, marginTop: 1 },
  centerPad: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },

  listContent: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 8, gap: 6 },
  row: { marginBottom: 6, maxWidth: '88%' },
  rowMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  rowOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  senderName: { fontSize: 11, fontWeight: '700', marginBottom: 3, marginLeft: 4 },

  bubble: {
    borderRadius: 14, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 5,
    borderWidth: 1,
  },
  bubbleMine: { backgroundColor: COLORS.blue, borderColor: 'transparent', borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: 'rgba(150,150,150,0.12)', borderColor: 'rgba(150,150,150,0.18)', borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 13.5, lineHeight: 18 },
  bubbleTime: { fontSize: 9.5, alignSelf: 'flex-end', marginTop: 3 },

  systemRow: { alignSelf: 'stretch', marginVertical: 8, paddingHorizontal: 4 },
  systemCard: {
    borderRadius: 12, borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.30)',
    backgroundColor: 'rgba(9,178,238,0.08)',
    paddingHorizontal: 12, paddingVertical: 10,
  },
  systemHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  systemName: { color: COLORS.blue, fontSize: 11.5, fontWeight: '800', flex: 1, letterSpacing: 0.3 },
  systemTime: { color: 'rgba(120,120,120,0.9)', fontSize: 10 },
  systemText: { color: '#1e3a8a', fontSize: 12.5, lineHeight: 18 },

  inputRow: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 10, paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 20 : 10,
    gap: 8, borderTopWidth: 1,
  },
  inputWrap: {
    flex: 1, borderRadius: RADIUS.xl, borderWidth: 1,
    paddingHorizontal: 12, minHeight: 40, justifyContent: 'center',
  },
  input: { fontSize: 13.5, paddingVertical: 7, maxHeight: 90 },
  sendBtn: { width: 40, height: 40, borderRadius: 20, overflow: 'hidden', ...SHADOW.button },
  sendBtnInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});