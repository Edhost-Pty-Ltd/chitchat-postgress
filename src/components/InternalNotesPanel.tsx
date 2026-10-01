import React, { useState, useEffect, useCallback, memo } from 'react';
import {
  View, Modal, TouchableOpacity, TextInput, FlatList,
  StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { COLORS, RADIUS, SHADOW } from '../types/theme';
import { AppText, AppIcon } from '../context/ThemeContext';
import { InternalNote } from '../types';

const fsDb = () => db as ReturnType<typeof firestore>;

interface Props {
  visible:    boolean;
  onClose:    () => void;
  chatId:     string;
  authorId:   string;
  authorName: string;
}

export const InternalNotesPanel = memo(function InternalNotesPanel({
  visible, onClose, chatId, authorId, authorName,
}: Props) {
  const [notes,   setNotes]   = useState<InternalNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [text,    setText]    = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!visible || !chatId) return;
    setLoading(true);
    const unsub = fsDb()
      .collection('chats').doc(chatId)
      .collection('notes')
      .orderBy('createdAt', 'desc')
      .onSnapshot(
        (snap) => {
          setNotes(snap.docs.map((d) => {
            const x = d.data();
            return {
              noteId:     d.id,
              authorId:   x.authorId,
              authorName: x.authorName,
              text:       x.text,
              createdAt:  x.createdAt?.toDate?.() ?? new Date(),
            };
          }));
          setLoading(false);
        },
        () => setLoading(false),
      );
    return () => unsub();
  }, [visible, chatId]);

  const send = useCallback(async () => {
    if (!text.trim()) return;
    setSending(true);
    const t = text.trim();
    setText('');
    try {
      await fsDb()
        .collection('chats').doc(chatId)
        .collection('notes')
        .add({
          authorId, authorName, text: t,
          createdAt: firestore.FieldValue.serverTimestamp(),
        });
    } catch {
      setText(t);
    } finally {
      setSending(false);
    }
  }, [text, chatId, authorId, authorName]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={s.root}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <View style={s.header}>
            <TouchableOpacity onPress={onClose} style={s.hBtn}>
              <AppIcon name="close" size={22} color={COLORS.text} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <AppText style={s.hTitle}>Internal Notes</AppText>
              <AppText style={s.hSub}>Only agents can see these</AppText>
            </View>
            <Ionicons name="lock-closed" size={18} color={COLORS.amber} />
          </View>

          {loading ? (
            <View style={s.empty}><ActivityIndicator color={COLORS.blue} /></View>
          ) : notes.length === 0 ? (
            <View style={s.empty}>
              <Ionicons name="document-text-outline" size={52} color={COLORS.textFaint} />
              <AppText style={s.emptyTxt}>No notes yet</AppText>
              <AppText style={s.emptySub}>Leave a note for your team.</AppText>
            </View>
          ) : (
            <FlatList
              data={notes}
              keyExtractor={(n) => n.noteId}
              contentContainerStyle={{ padding: 16, gap: 10 }}
              renderItem={({ item }) => (
                <View style={s.noteCard}>
                  <View style={s.noteHeader}>
                    <Ionicons name="lock-closed" size={12} color={COLORS.amber} />
                    <AppText style={s.noteAuthor}>{item.authorName}</AppText>
                    <AppText style={s.noteTime}>
                      {item.createdAt.toLocaleString([], {
                        hour: '2-digit', minute: '2-digit',
                        day: '2-digit',  month: '2-digit',
                      })}
                    </AppText>
                  </View>
                  <AppText style={s.noteText}>{item.text}</AppText>
                </View>
              )}
            />
          )}

          <View style={s.composer}>
            <TextInput
              style={s.input}
              placeholder="Write an internal note…"
              placeholderTextColor={COLORS.textFaint}
              value={text}
              onChangeText={setText}
              multiline
            />
            <TouchableOpacity
              style={[s.sendBtn, !text.trim() && { opacity: 0.4 }]}
              onPress={send}
              disabled={!text.trim() || sending}
            >
              {sending
                ? <ActivityIndicator size="small" color="#fff" />
                : <Ionicons name="arrow-up" size={20} color="#fff" />}
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
});

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#F3F6FA' },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 56 : 20,
    paddingBottom: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1, borderBottomColor: '#E4E9F2',
  },
  hBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  hTitle: { fontSize: 16, fontWeight: '800', color: COLORS.text },
  hSub:   { fontSize: 12, color: COLORS.sub, marginTop: 1 },

  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyTxt: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  emptySub: { fontSize: 13, color: COLORS.sub },

  noteCard: {
    backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#E4E9F2',
    borderLeftWidth: 4, borderLeftColor: COLORS.amber,
  },
  noteHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  noteAuthor: { flex: 1, fontSize: 13, fontWeight: '700', color: COLORS.text },
  noteTime:   { fontSize: 11, color: COLORS.textFaint },
  noteText:   { fontSize: 14, color: COLORS.text, lineHeight: 20 },

  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    padding: 12, backgroundColor: '#FFFFFF',
    borderTopWidth: 1, borderTopColor: '#E4E9F2',
  },
  input: {
    flex: 1, minHeight: 44, maxHeight: 120,
    backgroundColor: '#F3F6FA', borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 14, color: COLORS.text,
    borderWidth: 1, borderColor: '#E4E9F2',
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: COLORS.blue,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
});