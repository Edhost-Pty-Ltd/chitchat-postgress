// ─── InCallChatPanel ─────────────────────────────────────────────────────────
// Slide-in panel used inside the Audio/Video call screen.
// Shows the full 1:1 message history from Firestore and lets either side send
// new messages while the call is ongoing.

import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View, FlatList, TouchableOpacity, StyleSheet, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator, Modal,
  Animated, Easing, Image, Keyboard,
} from 'react-native';
import firestore from '@react-native-firebase/firestore';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { getOrCreateDirectChat } from '../hooks/useChatActions';

interface Props {
  visible: boolean;
  onClose: () => void;
  userId: string;
  otherUserId: string;
  otherName: string;
  otherPhoto?: string | null;
}

interface ChatMessage {
  id: string;
  senderId: string;
  text?: string;
  type?: string;
  imageUrl?: string;
  voiceUrl?: string;
  fileName?: string;
  duration?: number;
  timestamp: any;
}

const fmtTime = (ts: any): string => {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

export function InCallChatPanel({
  visible, onClose, userId, otherUserId, otherName, otherPhoto,
}: Props) {
  const { textColor } = useTypography();
  const { FG } = useForeground();
  const { bevel } = useGlass();

  const [chatId, setChatId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const listRef = useRef<FlatList<ChatMessage>>(null);
  const slide = useRef(new Animated.Value(0)).current;

  // ── Slide animation ─────────────────────────────────────────────
  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  // ── Resolve chatId once panel is opened ─────────────────────────
  useEffect(() => {
    if (!visible || !userId || !otherUserId) return;
    let cancelled = false;
    (async () => {
      try {
        const id = await getOrCreateDirectChat(userId, otherUserId);
        if (!cancelled) setChatId(id);
      } catch (e) {
        console.error('[InCallChat] getOrCreateDirectChat failed:', e);
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [visible, userId, otherUserId]);

  // ── Stream all messages ─────────────────────────────────────────
  useEffect(() => {
    if (!chatId) return;
    setLoading(true);
    const unsub = firestore()
      .collection('chats').doc(chatId).collection('messages')
      .orderBy('timestamp', 'asc')
      .onSnapshot(
        snap => {
          const list: ChatMessage[] = snap.docs.map(d => ({
            id: d.id,
            ...(d.data() as Omit<ChatMessage, 'id'>),
          }));
          setMessages(list);
          setLoading(false);
          requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
        },
        err => {
          console.error('[InCallChat] messages subscription error:', err);
          setLoading(false);
        }
      );
    return () => unsub();
  }, [chatId]);

  // ── Send a message ──────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !chatId || !userId) return;
    setInput('');
    setSending(true);
    try {
      const fsDb = firestore();
      const now = firestore.FieldValue.serverTimestamp();
      await fsDb.collection('chats').doc(chatId).collection('messages').add({
        senderId: userId,
        text,
        type: 'text',
        timestamp: now,
        readBy: [userId],
        deliveredTo: [],
      });
      await fsDb.collection('chats').doc(chatId).update({
        'lastMessage.text': text,
        'lastMessage.senderId': userId,
        'lastMessage.timestamp': now,
      });
    } catch (e) {
      console.error('[InCallChat] send failed:', e);
    } finally {
      setSending(false);
    }
  }, [input, chatId, userId]);

  // ── Render a single bubble ──────────────────────────────────────
  const renderItem = useCallback(({ item }: { item: ChatMessage }) => {
    const isMine = item.senderId === userId;
    const isSystem = item.type === 'system';

    if (isSystem) {
      return (
        <View style={styles.systemWrap}>
          <View style={[styles.systemBubble, { backgroundColor: FG.glassBg }]}>
            <AppText style={[styles.systemText, { color: FG.secondary }]}>{item.text}</AppText>
          </View>
        </View>
      );
    }

    const preview =
      item.type === 'voice' ? '🎤 Voice message'
      : item.type === 'image' ? '📷 Photo'
      : item.type === 'file' ? `📎 ${item.fileName ?? 'File'}`
      : item.text ?? '';

    return (
      <View style={[styles.row, isMine ? styles.rowMine : styles.rowOther]}>
        <View style={[
          styles.bubble,
          isMine ? styles.bubbleMine : styles.bubbleOther,
          { borderColor: FG.glassBorder },
        ]}>
          <AppText style={[styles.bubbleText, { color: isMine ? '#fff' : textColor }]} numberOfLines={6}>
            {preview}
          </AppText>
          <AppText style={[
            styles.bubbleTime,
            { color: isMine ? 'rgba(255,255,255,0.75)' : FG.secondary },
          ]}>
            {fmtTime(item.timestamp)}
          </AppText>
        </View>
      </View>
    );
  }, [userId, textColor, FG]);

  if (!visible) return null;

  const translateY = slide.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });
  const opacity    = slide;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Animated.View style={[styles.overlay, { opacity }]}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />

        <Animated.View
          style={[
            styles.panel,
            { backgroundColor: FG.glassBg, borderColor: FG.glassBorder },
            { opacity, transform: [{ translateY }] },
          ]}
        >
          <AppBg />

          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} style={styles.headerBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="chevron-down" size={22} color={COLORS.sub} />
            </TouchableOpacity>
            <View style={{ flex: 1, alignItems: 'center', flexDirection: 'row', gap: 10 }}>
              {otherPhoto ? (
                <Image source={{ uri: otherPhoto }} style={styles.headerAvatar} />
              ) : (
                <View style={[styles.headerAvatar, { backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center' }]}>
                  <AppText fixedColor style={{ color: '#fff', fontWeight: '700' }}>{otherName.slice(0,2).toUpperCase()}</AppText>
                </View>
              )}
              <View>
                <AppText style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
                  {otherName}
                </AppText>
                <AppText style={[styles.headerSub, { color: FG.secondary }]}>
                  In call · {messages.length} message{messages.length === 1 ? '' : 's'}
                </AppText>
              </View>
            </View>
            <View style={styles.headerBtn} />
          </View>

          {/* Body */}
          {loading ? (
            <View style={styles.centerPad}>
              <ActivityIndicator size="small" color={COLORS.blue} />
              <AppText style={[styles.centeredText, { color: FG.secondary, marginTop: 10 }]}>
                Loading conversation…
              </AppText>
            </View>
          ) : messages.length === 0 ? (
            <View style={styles.centerPad}>
              <AppIcon name="chatbubbles-outline" size={48} color={COLORS.sub} />
              <AppText style={[styles.centeredText, { color: FG.secondary, marginTop: 12 }]}>
                No messages yet. Say hi!
              </AppText>
            </View>
          ) : (
            <KeyboardAvoidingView
              style={{ flex: 1 }}
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
              keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
            >
              <FlatList
                ref={listRef}
                data={messages}
                keyExtractor={m => m.id}
                renderItem={renderItem}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
                keyboardShouldPersistTaps="handled"
              />

              {/* Input bar */}
              <View style={[styles.inputRow, { borderTopColor: FG.glassBorder }]}>
                <View style={[styles.inputWrap, bevel, { borderColor: FG.glassBorder }]}>
                  <TextInput
                    style={[styles.input, { color: textColor }]}
                    placeholder="Message during call…"
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
                      : <AppIcon name="send" size={18} color="#fff" fixedColor />}
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
    height: '72%',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    overflow: 'hidden',
    ...SHADOW.glow,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  headerBtn: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  headerAvatar: { width: 36, height: 36, borderRadius: 18, overflow: 'hidden' },
  headerTitle: { fontSize: 15, fontWeight: '700' },
  headerSub: { fontSize: 11, marginTop: 1 },

  listContent: { paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12, gap: 6 },
  row: { flexDirection: 'row', marginBottom: 4 },
  rowMine: { justifyContent: 'flex-end' },
  rowOther: { justifyContent: 'flex-start' },
  bubble: {
    maxWidth: '78%',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
    borderWidth: 1,
  },
  bubbleMine: { backgroundColor: COLORS.blue, borderColor: 'transparent', borderBottomRightRadius: 4 },
  bubbleOther: { backgroundColor: 'rgba(150,150,150,0.12)', borderBottomLeftRadius: 4 },
  bubbleText: { fontSize: 14, lineHeight: 19 },
  bubbleTime: { fontSize: 10, alignSelf: 'flex-end', marginTop: 3 },

  systemWrap: { alignItems: 'center', marginVertical: 6 },
  systemBubble: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, maxWidth: '80%' },
  systemText: { fontSize: 12, textAlign: 'center' },

  centerPad: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  centeredText: { fontSize: 14, textAlign: 'center' },

  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingVertical: 10,
    paddingBottom: Platform.OS === 'ios' ? 22 : 10,
    gap: 8,
    borderTopWidth: 1,
  },
  inputWrap: {
    flex: 1,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    paddingHorizontal: 14,
    minHeight: 42,
    justifyContent: 'center',
  },
  input: { fontSize: 14, paddingVertical: 8, maxHeight: 100 },
  sendBtn: { width: 42, height: 42, borderRadius: 21, overflow: 'hidden', ...SHADOW.button },
  sendBtnInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});