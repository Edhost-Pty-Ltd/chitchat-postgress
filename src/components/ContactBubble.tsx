// ─── ContactBubble ────────────────────────────────────────────────────────────
// Shared-contact card rendered inside a chat thread.
//   • One contact  → identity card with Message (registered) or Invite+Save.
//   • Many contacts → compact "N contacts" card with a "View all" button that
//     opens a bottom sheet; each row opens the inbox (registered) or invites.
// The displayed name is whatever the sender saved for each contact.

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Dimensions, Alert, Platform, Linking,
  Modal, ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import { RootStackParamList } from '../types';
import { Avatar } from './';
import { useAuth } from '../hooks/useAuth';
import { getOrCreateDirectChat } from '../hooks/useChatActions';

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_W = Math.min(SCREEN_W * 0.72, 290);
type NavProp = NativeStackNavigationProp<RootStackParamList, 'Chat'>;

export interface ContactData {
  name: string;
  phone: string;
  userId: string | null;
  registered: boolean;
  photoURL: string | null;
  // Present when multiple contacts were shared in one message.
  contacts?: ContactData[];
}

interface Props {
  contact: ContactData;
  isOutgoing: boolean;
  timestamp?: string;
  tickIcon?: { icon: 'checkmark' | 'checkmark-done'; color: string };
  // Opens the host screen's "Add Contact" form sheet, prefilled with the
  // given name/phone, instead of silently saving to the address book.
  onSaveContact?: (name: string, phone: string) => void;
}

function getInitials(name: string): string {
  const p = (name || '').trim().split(/\s+/);
  return p.length >= 2 ? (p[0][0] + p[1][0]).toUpperCase() : (name || '?').slice(0, 2).toUpperCase();
}

// ── Shared action helpers (used by both single card and the sheet rows) ──────
function useContactActions(onSaveContact?: (name: string, phone: string) => void) {
  const navigation = useNavigation<NavProp>();
  const { user } = useAuth();
  const userId = user?.uid ?? null;

  const openInbox = async (c: ContactData) => {
    if (!userId || !c.userId) return;
    try {
      const chatId = await getOrCreateDirectChat(userId, c.userId);
      navigation.navigate('Chat', {
        chatId,
        displayName: c.name,
        isGroup: false,
        otherUserId: c.userId,
        otherUserPhoto: c.photoURL ?? null,
      });
    } catch (err) {
      console.error('[ContactBubble] openInbox error:', err);
      Alert.alert('Error', 'Could not open the chat. Please try again.');
    }
  };

  const invite = async (c: ContactData) => {
    const body = encodeURIComponent(
      `Hi ${c.name}, join me on ChitChatBusiness! Download the app to chat with me.`,
    );
    const sep = Platform.OS === 'ios' ? '&' : '?';
    const url = `sms:${c.phone}${sep}body=${body}`;
    try {
      const ok = await Linking.canOpenURL(url);
      if (ok) await Linking.openURL(url);
      else await Linking.openURL(`sms:${c.phone}`);
    } catch {
      Alert.alert('Could not open Messages', 'Please invite them manually.');
    }
  };

  // Open the host screen's Add-Contact form sheet (name/surname + sync switch),
  // prefilled with this contact. Falls back to a direct save only if no handler
  // was provided.
  const saveContact = async (c: ContactData) => {
    if (onSaveContact) {
      onSaveContact(c.name, c.phone);
      return;
    }
    try {
      if (Platform.OS === 'web') {
        Alert.alert('Not supported', 'Saving contacts is not available on web.');
        return;
      }
      const Contacts = await import('expo-contacts/legacy');
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Allow contacts access to save this contact.');
        return;
      }
      const parts = (c.name || '').trim().split(/\s+/);
      const firstName = parts[0] || c.name || c.phone;
      const lastName = parts.slice(1).join(' ');
      await Contacts.addContactAsync({
        [Contacts.Fields.FirstName]: firstName,
        [Contacts.Fields.LastName]: lastName,
        [Contacts.Fields.PhoneNumbers]: [{ label: 'mobile', number: c.phone }],
      } as any);
      Alert.alert('Saved', `${c.name} has been added to your contacts.`);
    } catch (err) {
      console.error('[ContactBubble] save error:', err);
      Alert.alert('Error', 'Could not save the contact. Please try again.');
    }
  };

  return { openInbox, invite, saveContact };
}

// ── Multi-contact grouped card + "View all" bottom sheet ─────────────────────
function MultiContactCard({ contacts, isOutgoing, timestamp, tickIcon, onSaveContact }: {
  contacts: ContactData[];
  isOutgoing: boolean;
  timestamp?: string;
  tickIcon?: Props['tickIcon'];
  onSaveContact?: (name: string, phone: string) => void;
}) {
  const { openInbox, invite, saveContact } = useContactActions(onSaveContact);
  const [sheetOpen, setSheetOpen] = useState(false);

  const preview = contacts.slice(0, 3);
  const registeredCount = contacts.filter((c) => c.registered).length;

  return (
    <View style={[styles.wrapper, isOutgoing ? styles.wrapperOut : styles.wrapperIn]}>
      <View style={styles.card}>
        {/* Stacked avatar + title */}
        <View style={styles.idRow}>
          <View style={styles.stack}>
            {preview.map((c, i) => (
              <View key={c.phone + i} style={[styles.stackAvatar, { left: i * 18, zIndex: 3 - i }]}>
                <Avatar initials={getInitials(c.name)} color={COLORS.blue} size={38} imageUrl={c.photoURL} />
              </View>
            ))}
          </View>
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.name} numberOfLines={1}>{contacts.length} contacts</Text>
            <Text style={styles.phone} numberOfLines={1}>
              {preview.map((c) => c.name.split(/\s+/)[0]).join(', ')}
              {contacts.length > preview.length ? ` +${contacts.length - preview.length}` : ''}
            </Text>
            {registeredCount > 0 && (
              <View style={styles.badgeRow}>
                <Ionicons name="checkmark-circle" size={12} color={COLORS.green} />
                <Text style={[styles.badgeText, { color: COLORS.green }]}>
                  {registeredCount} on ChitChatBusiness
                </Text>
              </View>
            )}
          </View>
        </View>

        <TouchableOpacity activeOpacity={0.85} onPress={() => setSheetOpen(true)} style={styles.primaryBtn}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGrad}>
            <Ionicons name="people-outline" size={16} color="#fff" />
            <Text style={styles.primaryBtnText}>View all</Text>
          </LinearGradient>
        </TouchableOpacity>

        <View style={styles.timeRow}>
          {timestamp && <Text style={styles.timeText}>{timestamp}</Text>}
          {isOutgoing && tickIcon && (
            <Ionicons name={tickIcon.icon} size={13} color={tickIcon.color} style={{ marginLeft: 3 }} />
          )}
        </View>
      </View>

      {/* ── Bottom sheet with the full list ── */}
      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <TouchableOpacity style={sheet.backdrop} activeOpacity={1} onPress={() => setSheetOpen(false)} />
        <View style={sheet.container}>
          <View style={sheet.handle} />
          <View style={sheet.header}>
            <Text style={sheet.title}>{contacts.length} contacts</Text>
            <TouchableOpacity onPress={() => setSheetOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={COLORS.sub} />
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 28 }}>
            {contacts.map((c, i) => (
              <View key={c.phone + i} style={sheet.row}>
                <Avatar initials={getInitials(c.name)} color={COLORS.blue} size={44} imageUrl={c.photoURL} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={sheet.rowName} numberOfLines={1}>{c.name}</Text>
                  <Text style={sheet.rowPhone} numberOfLines={1}>{c.phone}</Text>
                </View>
                {c.registered ? (
                  <TouchableOpacity onPress={() => { setSheetOpen(false); openInbox(c); }} style={sheet.msgBtn} activeOpacity={0.85}>
                    <LinearGradient colors={GRADIENTS.primary} style={sheet.msgBtnGrad}>
                      <Ionicons name="chatbubble-ellipses-outline" size={14} color="#fff" />
                      <Text style={sheet.msgBtnText}>Message</Text>
                    </LinearGradient>
                  </TouchableOpacity>
                ) : (
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <TouchableOpacity onPress={() => invite(c)} style={sheet.inviteBtn} activeOpacity={0.85}>
                      <Ionicons name="paper-plane-outline" size={14} color="#fff" />
                      <Text style={sheet.inviteBtnText}>Invite</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => { setSheetOpen(false); setTimeout(() => saveContact(c), 350); }}
                      style={sheet.saveBtn}
                      activeOpacity={0.85}
                    >
                      <Ionicons name="person-add-outline" size={16} color={COLORS.blue} />
                    </TouchableOpacity>
                  </View>
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ── Single-contact card ──────────────────────────────────────────────────────
function SingleContactCard({ contact, isOutgoing, timestamp, tickIcon, onSaveContact }: Props) {
  const { openInbox, invite, saveContact } = useContactActions(onSaveContact);
  const [busy, setBusy] = useState(false);

  return (
    <View style={[styles.wrapper, isOutgoing ? styles.wrapperOut : styles.wrapperIn]}>
      <View style={styles.card}>
        <View style={styles.idRow}>
          <Avatar initials={getInitials(contact.name)} color={COLORS.blue} size={52} imageUrl={contact.photoURL} />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={styles.name} numberOfLines={1}>{contact.name}</Text>
            <Text style={styles.phone} numberOfLines={1}>{contact.phone}</Text>
            <View style={styles.badgeRow}>
              <Ionicons
                name={contact.registered ? 'checkmark-circle' : 'person-add-outline'}
                size={12}
                color={contact.registered ? COLORS.green : COLORS.sub}
              />
              <Text style={[styles.badgeText, { color: contact.registered ? COLORS.green : COLORS.sub }]}>
                {contact.registered ? 'On ChitChatBusiness' : 'Not on ChitChatBusiness'}
              </Text>
            </View>
          </View>
        </View>

        {contact.registered ? (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={async () => { setBusy(true); await openInbox(contact); setBusy(false); }}
            style={styles.primaryBtn}
            disabled={busy}
          >
            <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtnGrad}>
              <Ionicons name="chatbubble-ellipses-outline" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>Message</Text>
            </LinearGradient>
          </TouchableOpacity>
        ) : (
          <View style={styles.dualRow}>
            <TouchableOpacity activeOpacity={0.85} onPress={() => invite(contact)} style={[styles.halfBtn, styles.halfBtnFilled]}>
              <Ionicons name="paper-plane-outline" size={15} color="#fff" />
              <Text style={styles.halfBtnTextFilled}>Invite</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.85} onPress={() => saveContact(contact)} style={[styles.halfBtn, styles.halfBtnOutline]}>
              <Ionicons name="person-add-outline" size={15} color={COLORS.blue} />
              <Text style={styles.halfBtnTextOutline}>Save</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.timeRow}>
          {timestamp && <Text style={styles.timeText}>{timestamp}</Text>}
          {isOutgoing && tickIcon && (
            <Ionicons name={tickIcon.icon} size={13} color={tickIcon.color} style={{ marginLeft: 3 }} />
          )}
        </View>
      </View>
    </View>
  );
}

export const ContactBubble = React.memo(function ContactBubble({ contact, isOutgoing, timestamp, tickIcon, onSaveContact }: Props) {
  const list = contact.contacts;
  if (list && list.length > 1) {
    return <MultiContactCard contacts={list} isOutgoing={isOutgoing} timestamp={timestamp} tickIcon={tickIcon} onSaveContact={onSaveContact} />;
  }
  return <SingleContactCard contact={contact} isOutgoing={isOutgoing} timestamp={timestamp} tickIcon={tickIcon} onSaveContact={onSaveContact} />;
});

const styles = StyleSheet.create({
  wrapper: { marginVertical: 3, marginHorizontal: 6, maxWidth: CARD_W },
  wrapperOut: { alignSelf: 'flex-end' },
  wrapperIn: { alignSelf: 'flex-start' },
  card: {
    width: CARD_W,
    borderRadius: RADIUS.lg,
    backgroundColor: '#fff',
    padding: 14,
    ...SHADOW.card,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.10)',
  },
  idRow: { flexDirection: 'row', alignItems: 'center' },
  name: { fontSize: 15.5, fontWeight: '700', color: COLORS.text },
  phone: { fontSize: 13, color: COLORS.sub, marginTop: 2 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  badgeText: { fontSize: 11, fontWeight: '600' },

  // Stacked avatars for the multi card
  stack: { width: 74, height: 38, justifyContent: 'center' },
  stackAvatar: {
    position: 'absolute',
    borderRadius: 19,
    borderWidth: 2, borderColor: '#fff',
  },

  primaryBtn: { marginTop: 12, borderRadius: RADIUS.full, overflow: 'hidden' },
  primaryBtnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: RADIUS.full,
  },
  primaryBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },

  dualRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  halfBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: RADIUS.full,
  },
  halfBtnFilled: { backgroundColor: COLORS.blue },
  halfBtnOutline: { borderWidth: 1.5, borderColor: COLORS.blue, backgroundColor: 'rgba(30,156,240,0.06)' },
  halfBtnTextFilled: { color: '#fff', fontSize: 13.5, fontWeight: '700' },
  halfBtnTextOutline: { color: COLORS.blue, fontSize: 13.5, fontWeight: '700' },

  timeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, marginTop: 8 },
  timeText: { fontSize: 11, color: COLORS.sub },
});

const sheet = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.4)' },
  container: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: '80%', paddingHorizontal: 16,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(0,0,0,0.15)', marginTop: 8, marginBottom: 6 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  title: { fontSize: 16, fontWeight: '800', color: COLORS.text },
  row: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  rowName: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  rowPhone: { fontSize: 12.5, color: COLORS.sub, marginTop: 2 },
  msgBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  msgBtnGrad: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 8, paddingHorizontal: 14, borderRadius: RADIUS.full },
  msgBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  inviteBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    backgroundColor: COLORS.blue, borderRadius: RADIUS.full,
    paddingVertical: 8, paddingHorizontal: 12,
  },
  inviteBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  saveBtn: {
    width: 38, height: 38, borderRadius: 19,
    borderWidth: 1.5, borderColor: COLORS.blue, backgroundColor: 'rgba(30,156,240,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
});
