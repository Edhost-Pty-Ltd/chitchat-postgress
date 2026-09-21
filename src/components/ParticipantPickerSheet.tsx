// ─── ParticipantPickerSheet ──────────────────────────────────────────────────
// Self-contained modal that lets the user pick contacts. Used by both the
// Calendar screen (during scheduling) and the VideoCall screen (add to room).

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, FlatList, TouchableOpacity, StyleSheet, TextInput, Modal,
  Pressable, ScrollView, ActivityIndicator, Image, Text, Linking,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useContacts, AppContact } from '../hooks/useContacts';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';

interface Props {
  visible: boolean;
  selected: string[];
  /** IDs already in the room / already picked that we should not show. */
  excludeIds?: string[];
  onConfirm: (ids: string[]) => void;
  onClose: () => void;
  title?: string;
}

function stringToColor(str: string) {
  const c = ['#f97316','#8b5cf6','#ec4899','#06b6d4','#10b981','#f59e0b','#6366f1','#e11d48'];
  let h = 0; for (let i = 0; i < str.length; i++) h = str.charCodeAt(i) + ((h << 5) - h);
  return c[Math.abs(h) % c.length];
}
function initials(n: string) {
  const p = n.trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[p.length-1][0]).toUpperCase() : n.slice(0,2).toUpperCase();
}

function ContactAvatar({ contact, size = 40 }: { contact: AppContact; size?: number }) {
  const photo = contact.photoUri || contact.firebasePhotoURL;
  return (
    <View style={{
      width: size, height: size, borderRadius: size/2, overflow: 'hidden',
      backgroundColor: stringToColor(contact.displayName),
      alignItems: 'center', justifyContent: 'center',
    }}>
      {photo
        ? <Image source={{ uri: photo }} style={{ width: size, height: size }} />
        : <Text style={{ color: '#fff', fontSize: size*0.36, fontWeight: '700' }}>{initials(contact.displayName)}</Text>}
    </View>
  );
}

export function ParticipantPickerSheet({
  visible, selected, excludeIds = [], onConfirm, onClose, title = 'Add Participants',
}: Props) {
  const { contacts, loading, error, hasPermission, canAskAgain, reload } = useContacts();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>(selected);
  const { textColor } = useTypography();
  const { bevel }    = useGlass();
  const { FG }       = useForeground();

  useEffect(() => { if (visible) setPicked(selected); }, [visible]); // eslint-disable-line

  const filtered = useMemo(() => {
    const base = excludeIds.length
      ? contacts.filter(c => !excludeIds.includes(c.userId))
      : contacts;
    if (!search.trim()) return base;
    const q = search.toLowerCase();
    return base.filter(c =>
      c.displayName.toLowerCase().includes(q) || c.phone.includes(q)
    );
  }, [contacts, search, excludeIds]);

  const toggle = (id: string) =>
    setPicked(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]);

  const openSettings = () => Linking.openSettings?.().catch(() => {});

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.overlay} onPress={onClose} />
      <View style={styles.sheet}>
        <AppBg />
        <View style={styles.handle} />

        <View style={styles.sheetSubHeader}>
          <TouchableOpacity onPress={onClose} style={styles.iconPad}>
            <AppIcon name="close" size={22} color={COLORS.sub} />
          </TouchableOpacity>
          <AppText style={[styles.sheetTitle, { color: textColor }]}>{title}</AppText>
          <TouchableOpacity onPress={() => { onConfirm(picked); onClose(); }} activeOpacity={0.85}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.nextBtnGrad}>
              <AppText style={styles.nextBtnText}>Done ({picked.length})</AppText>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        <View style={[styles.glassInput, bevel, { marginHorizontal: 14, marginBottom: 10 }]}>
          <AppIcon name="search-outline" size={16} color={COLORS.sub} />
          <TextInput
            style={[styles.inputField, { color: textColor }]}
            placeholder="Search contacts..." placeholderTextColor={COLORS.sub}
            value={search} onChangeText={setSearch}
          />
        </View>

        {picked.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            {picked.map(uid => {
              const c = contacts.find(x => x.userId === uid);
              if (!c) return null;
              return (
                <TouchableOpacity key={uid} style={styles.chip} onPress={() => toggle(uid)}>
                  <ContactAvatar contact={c} size={22} />
                  <AppText style={styles.chipText} numberOfLines={1}>{c.displayName.split(' ')[0]}</AppText>
                  <AppIcon name="close-circle" size={14} color={COLORS.sub} />
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {!hasPermission ? (
          <View style={styles.centerPad}>
            <AppIcon name="lock-closed-outline" size={44} color={COLORS.sub} />
            <AppText style={[styles.emptyText, { textAlign: 'center', marginTop: 12 }]}>
              Contacts permission is required to invite participants.
            </AppText>
            {canAskAgain ? (
              <TouchableOpacity onPress={reload} style={styles.retryBtn}>
                <AppText style={styles.retryText}>Grant permission</AppText>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={openSettings} style={styles.retryBtn}>
                <AppText style={styles.retryText}>Open Settings</AppText>
              </TouchableOpacity>
            )}
          </View>
        ) : loading ? (
          <View style={styles.centerPad}>
            <ActivityIndicator size="small" color={COLORS.blue} />
            <AppText style={{ color: COLORS.sub, marginTop: 10 }}>Loading contacts…</AppText>
          </View>
        ) : (
          <FlatList
            data={filtered} keyExtractor={c => c.userId}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 30 }}
            keyboardShouldPersistTaps="handled"
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: 'rgba(150,150,150,0.08)' }} />}
            renderItem={({ item: c }) => {
              const isSel = picked.includes(c.userId);
              return (
                <TouchableOpacity style={styles.contactRow} activeOpacity={0.7} onPress={() => toggle(c.userId)}>
                  <ContactAvatar contact={c} size={40} />
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <AppText style={[styles.contactName, { color: textColor }]}>{c.displayName}</AppText>
                    <AppText style={[styles.contactPhone, { color: FG.secondary }]}>{c.phone}</AppText>
                  </View>
                  {isSel && <AppIcon name="checkmark-circle" size={22} color={COLORS.blue} />}
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <View style={styles.centerPad}>
                <AppIcon name="people-outline" size={40} color={COLORS.sub} />
                <AppText style={{ color: COLORS.sub, fontSize: 14, marginTop: 10, textAlign: 'center' }}>
                  {error ?? 'No contacts found on ChitChat'}
                </AppText>
              </View>
            }
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '82%', borderTopLeftRadius: 24, borderTopRightRadius: 24, overflow: 'hidden', ...SHADOW.glow },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(30,156,240,0.30)', marginTop: 10, marginBottom: 4 },
  sheetSubHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, gap: 10 },
  iconPad: { padding: 4 },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: '700' },
  nextBtnGrad: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: RADIUS.full, ...SHADOW.button },
  nextBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  glassInput: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 12 },
  inputField: { flex: 1, fontSize: 14, padding: 0 },
  contactRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  contactName: { fontSize: 14, fontWeight: '600' },
  contactPhone: { fontSize: 12, marginTop: 1 },
  chipsRow: { paddingHorizontal: 14, paddingBottom: 10, gap: 8, flexDirection: 'row' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(30,156,240,0.12)', borderRadius: RADIUS.full, paddingHorizontal: 8, paddingVertical: 4 },
  chipText: { fontSize: 12, fontWeight: '600', maxWidth: 70 },
  centerPad: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 },
  emptyText: { fontSize: 15, color: COLORS.sub },
  retryBtn: { marginTop: 12, paddingHorizontal: 20, paddingVertical: 10, borderRadius: RADIUS.full, backgroundColor: COLORS.blue },
  retryText: { color: '#fff', fontWeight: '700', fontSize: 13 },
});