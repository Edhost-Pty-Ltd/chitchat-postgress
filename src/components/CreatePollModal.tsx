// ─── CreatePollModal ──────────────────────────────────────────────────────────
// Lets the user compose a poll (question + 2–10 options) before sending.

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  Modal, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS, RADIUS } from '../types/theme';
import { AppBg, AppText, useForeground } from '../context/ThemeContext';

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreate: (question: string, options: string[], multiple: boolean) => void;
}

export function CreatePollModal({ visible, onClose, onCreate }: Props) {
  const { FG } = useForeground();
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState<string[]>(['', '']);
  const [multiple, setMultiple] = useState(false);

  const reset = () => { setQuestion(''); setOptions(['', '']); setMultiple(false); };
  const close = () => { reset(); onClose(); };

  const setOption = (i: number, v: string) => {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? v : o)));
  };
  const addOption = () => setOptions((prev) => (prev.length >= 10 ? prev : [...prev, '']));
  const removeOption = (i: number) =>
    setOptions((prev) => (prev.length <= 2 ? prev : prev.filter((_, idx) => idx !== i)));

  const trimmedOptions = options.map((o) => o.trim()).filter(Boolean);
  const canSend = question.trim().length > 0 && trimmedOptions.length >= 2;

  const handleSend = () => {
    if (!canSend) return;
    onCreate(question.trim(), trimmedOptions, multiple);
    reset();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={close} />
        <View style={[styles.sheet, { backgroundColor: FG.glassBg }]}>
          <AppBg />
          <View style={styles.handle} />

          <View style={styles.header}>
            <TouchableOpacity onPress={close} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <AppText style={styles.cancel}>Cancel</AppText>
            </TouchableOpacity>
            <AppText style={styles.title}>Create poll</AppText>
            <TouchableOpacity onPress={handleSend} disabled={!canSend} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <AppText style={[styles.send, !canSend && styles.sendDisabled]}>Send</AppText>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }} keyboardShouldPersistTaps="handled">
            <AppText style={styles.sectionLabel}>QUESTION</AppText>
            <View style={[styles.inputWrap, { borderColor: FG.glassBorder }]}>
              <TextInput
                style={[styles.questionInput, { color: COLORS.text }]}
                placeholder="Ask a question…"
                placeholderTextColor={COLORS.sub}
                value={question}
                onChangeText={setQuestion}
                multiline
                maxLength={200}
              />
            </View>

            <AppText style={styles.sectionLabel}>OPTIONS</AppText>
            {options.map((opt, i) => (
              <View key={i} style={[styles.optionRow, { borderColor: FG.glassBorder }]}>
                <TextInput
                  style={[styles.optionInput, { color: COLORS.text }]}
                  placeholder={`Option ${i + 1}`}
                  placeholderTextColor={COLORS.sub}
                  value={opt}
                  onChangeText={(v) => setOption(i, v)}
                  maxLength={100}
                />
                {options.length > 2 && (
                  <TouchableOpacity onPress={() => removeOption(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Ionicons name="close-circle" size={20} color={COLORS.sub} />
                  </TouchableOpacity>
                )}
              </View>
            ))}

            {options.length < 10 && (
              <TouchableOpacity style={styles.addOption} onPress={addOption} activeOpacity={0.8}>
                <Ionicons name="add-circle-outline" size={20} color={COLORS.blue} />
                <AppText style={styles.addOptionText}>Add option</AppText>
              </TouchableOpacity>
            )}

            <View style={styles.toggleRow}>
              <View style={{ flex: 1 }}>
                <AppText style={styles.toggleTitle}>Allow multiple answers</AppText>
                <AppText style={styles.toggleSub}>Voters can pick more than one option</AppText>
              </View>
              <Switch
                value={multiple}
                onValueChange={setMultiple}
                trackColor={{ false: 'rgba(0,0,0,0.12)', true: COLORS.blue }}
                thumbColor="#fff"
              />
            </View>

            <TouchableOpacity activeOpacity={0.85} onPress={handleSend} disabled={!canSend} style={styles.sendBtn}>
              <LinearGradient
                colors={canSend ? GRADIENTS.primary : ['#b9c6d4', '#b9c6d4']}
                style={styles.sendBtnGrad}
              >
                <Ionicons name="stats-chart" size={16} color="#fff" />
                <Text style={styles.sendBtnText}>Send poll</Text>
              </LinearGradient>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 18, paddingTop: 10, paddingBottom: Platform.OS === 'ios' ? 30 : 16,
    maxHeight: '88%', overflow: 'hidden',
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.15)', marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  cancel: { fontSize: 15, color: COLORS.sub },
  title: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  send: { fontSize: 15, fontWeight: '700', color: COLORS.blue },
  sendDisabled: { color: COLORS.sub, opacity: 0.5 },

  sectionLabel: { fontSize: 11, fontWeight: '700', color: COLORS.sub, letterSpacing: 0.5, marginTop: 10, marginBottom: 6 },
  inputWrap: { borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: 'rgba(255,255,255,0.6)' },
  questionInput: { fontSize: 15, minHeight: 40, maxHeight: 110 },

  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderWidth: 1, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 4,
    marginBottom: 8, backgroundColor: 'rgba(255,255,255,0.6)',
  },
  optionInput: { flex: 1, fontSize: 15, paddingVertical: 8 },
  addOption: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8 },
  addOptionText: { fontSize: 14, fontWeight: '600', color: COLORS.blue },

  toggleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 14, marginBottom: 6 },
  toggleTitle: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  toggleSub: { fontSize: 12, color: COLORS.sub, marginTop: 2 },

  sendBtn: { marginTop: 18, borderRadius: RADIUS.full, overflow: 'hidden' },
  sendBtnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 13, borderRadius: RADIUS.full },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});
