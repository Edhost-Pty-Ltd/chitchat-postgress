// ─── Screen: Contacts ────────────────────────────────────────────────────────
import React, { useState, useMemo } from 'react';
import {
  View,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Alert,
  ActivityIndicator,
  Share,
  ListRenderItemInfo,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Avatar } from '../components';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList } from '../types';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useContacts, AppContact } from '../hooks/useContacts';
import { useAuth } from '../hooks/useAuth';
import { useOutgoingCall } from '../hooks/useOutgoingCall';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Contacts'>;

// ── List row types ────────────────────────────────────────────────────────────
type LetterRow    = { kind: 'letter';       letter: string };
type ContactRow   = { kind: 'contact';      contact: AppContact };
type DividerRow   = { kind: 'divider' };
type InviteRow    = { kind: 'invite';       contact: AppContact };

type ListRow = LetterRow | ContactRow | DividerRow | InviteRow;

function rowKey(item: ListRow, index: number): string {
  switch (item.kind) {
    case 'letter':  return `letter-${item.letter}`;
    case 'contact': return `contact-${item.contact.userId}`;
    case 'divider': return 'divider';
    case 'invite':  return `invite-${item.contact.userId}-${index}`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function getAvatarColor(seed: string): string {
  const palette = [COLORS.blue, COLORS.blueDark, COLORS.green, COLORS.amber, COLORS.missed];
  const idx = seed.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % palette.length;
  return palette[idx];
}

function sectionLetter(name: string): string {
  const first = name.trim()[0]?.toUpperCase() ?? '#';
  return /[A-Z]/.test(first) ? first : '#';
}

// Build a flat list of rows from partitioned contacts
function buildRows(
  onApp: AppContact[],
  offApp: AppContact[],
): ListRow[] {
  const rows: ListRow[] = [];

  // ── On-app contacts grouped by letter ──────────────────────────────────
  let lastLetter = '';
  for (const c of onApp) {
    const letter = sectionLetter(c.displayName);
    if (letter !== lastLetter) {
      rows.push({ kind: 'letter', letter });
      lastLetter = letter;
    }
    rows.push({ kind: 'contact', contact: c });
  }

  // ── Invite divider + off-app contacts ──────────────────────────────────
  if (offApp.length > 0) {
    rows.push({ kind: 'divider' });
    for (const c of offApp) {
      rows.push({ kind: 'invite', contact: c });
    }
  }

  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ContactsScreen() {
  const navigation = useNavigation<NavProp>();
  const { user } = useAuth();
  const { contacts, loading, error, hasPermission } = useContacts();
  const outgoingCall = useOutgoingCall();

  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();
  const [query, setQuery] = useState('');
  const [calling, setCalling] = useState(false);
  const [callingContactId, setCallingContactId] = useState<string | null>(null);

  // ── Partition, filter, then flatten into a renderable row list ───────────
  const rows = useMemo<ListRow[]>(() => {
    const q = query.trim().toLowerCase();

    const filtered = q
      ? contacts.filter(
          (c) =>
            c.displayName.toLowerCase().includes(q) ||
            c.phone.includes(query.trim()),
        )
      : contacts;

    // onApp is already sorted A-Z by useContacts; offApp keeps the same order
    const onApp  = filtered.filter((c) => c.isSaved);
    const offApp = filtered.filter((c) => !c.isSaved);

    return buildRows(onApp, offApp);
  }, [contacts, query]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleCall = async (contact: AppContact) => {
    if (!user) {
      Alert.alert('Error', 'You must be logged in to make calls');
      return;
    }
    setCalling(true);
    setCallingContactId(contact.userId);
    try {
      const callId = await outgoingCall.initiateCall(
        user.uid,
        contact.userId,
        {
          userId: user.uid,
          displayName: user.displayName || 'You',
          photoUrl: user.photoURL,
        },
        {
          userId: contact.userId,
          displayName: contact.displayName,
          photoUrl: contact.firebasePhotoURL || null,
        },
      );
      if (callId) {
        navigation.navigate('AudioCall', {
          callId,
          isOutgoing: true,
          otherParty: {
            userId: contact.userId,
            displayName: contact.displayName,
            photoUrl: contact.firebasePhotoURL || null,
          },
        });
      } else {
        Alert.alert('Call Failed', 'Unable to initiate call');
      }
    } catch (err) {
      console.error('[ContactsScreen] Call failed:', err);
      Alert.alert('Call Failed', 'Unable to start call. Please try again.');
    } finally {
      setCalling(false);
      setCallingContactId(null);
    }
  };

  const handleChat = (contact: AppContact) => {
    Alert.alert('Chat', `Opening chat with ${contact.displayName}`);
  };

  const handleInvite = async (contact: AppContact) => {
    try {
      await Share.share({
        message: `Hey ${contact.displayName}! I'm using Chit-Chat Business to stay connected. Join me here: https://chitchatbusiness.app`,
      });
    } catch {
      // share sheet dismissed — no-op
    }
  };

  // ── Row renderers ──────────────────────────────────────────────────────────
  const renderRow = ({ item, index }: ListRenderItemInfo<ListRow>) => {
    switch (item.kind) {

      case 'letter':
        return (
          <View style={styles.letterHeader}>
            <AppText style={[styles.letterText, { fontFamily }]}>{item.letter}</AppText>
          </View>
        );

      case 'contact': {
        const c = item.contact;
        const isCurrentlyCalling = calling && callingContactId === c.userId;
        return (
          <TouchableOpacity
            style={[styles.contactCard, bevel]}
            activeOpacity={0.75}
            onPress={() => handleChat(c)}
          >
            <Avatar
              initials={getInitials(c.displayName)}
              color={getAvatarColor(c.userId)}
              size={48}
            />
            <View style={styles.contactMeta}>
              <AppText style={[styles.contactName, { color: textColor, fontFamily }]}>
                {c.displayName}
              </AppText>
              <AppText style={[styles.contactSub, { color: COLORS.green }]} numberOfLines={1}>
                On Chit-Chat
              </AppText>
            </View>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => handleCall(c)}
              disabled={calling}
            >
              {isCurrentlyCalling ? (
                <View style={styles.callBtn}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              ) : (
                <LinearGradient colors={GRADIENTS.primary} style={styles.callBtn}>
                  <AppIcon name="call" size={15} color="#fff" fixedColor />
                </LinearGradient>
              )}
            </TouchableOpacity>
          </TouchableOpacity>
        );
      }

      case 'divider':
        return (
          <View style={styles.inviteDivider}>
            <AppText style={[styles.inviteDividerText, { fontFamily }]}>
              Invite to Chit-Chat
            </AppText>
          </View>
        );

      case 'invite': {
        const c = item.contact;
        return (
          <View style={[styles.contactCard, bevel]}>
            <View style={styles.avatarPlaceholder}>
              <AppIcon name="person-outline" size={22} color={COLORS.sub} />
            </View>
            <View style={styles.contactMeta}>
              <AppText style={[styles.contactName, { color: textColor, fontFamily }]}>
                {c.displayName}
              </AppText>
              <AppText style={[styles.contactSub, { color: FG.secondary }]} numberOfLines={1}>
                {c.phone}
              </AppText>
            </View>
            <TouchableOpacity
              style={styles.inviteBtn}
              activeOpacity={0.75}
              onPress={() => handleInvite(c)}
            >
              <AppText style={styles.inviteBtnText}>Invite</AppText>
            </TouchableOpacity>
          </View>
        );
      }
    }
  };

  // ── Main render ────────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <AppBg />

      {/* Header */}
      <View style={styles.header}>
        <AppText style={[styles.title, { color: textColor, fontFamily }]}>Contacts</AppText>
        <TouchableOpacity activeOpacity={0.85}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.addBtn}>
            <AppIcon name="add" size={20} color="#fff" fixedColor />
          </LinearGradient>
        </TouchableOpacity>
      </View>

      {/* Search bar */}
      <View style={styles.searchWrap}>
        <AppIcon name="search-outline" size={16} color={COLORS.sub} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search contacts"
          placeholderTextColor={COLORS.sub}
          value={query}
          onChangeText={setQuery}
          editable={!loading}
        />
      </View>

      {/* States */}
      {loading ? (
        <View style={styles.centerWrap}>
          <ActivityIndicator size="large" color={COLORS.blue} />
          <AppText style={styles.centerText}>Loading contacts...</AppText>
        </View>
      ) : error ? (
        <View style={styles.centerWrap}>
          <AppIcon name="alert-circle-outline" size={48} color={COLORS.missed} />
          <AppText style={styles.centerText}>Failed to load contacts</AppText>
          <AppText style={styles.errorText}>{error}</AppText>
        </View>
      ) : !hasPermission ? (
        <View style={styles.centerWrap}>
          <AppIcon name="lock-closed-outline" size={48} color={COLORS.sub} />
          <AppText style={styles.centerText}>Contacts Permission Required</AppText>
          <AppText style={styles.hintText}>
            Please allow contacts access in your device settings
          </AppText>
        </View>
      ) : (
        <FlatList<ListRow>
          data={rows}
          keyExtractor={rowKey}
          renderItem={renderRow}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          removeClippedSubviews
          maxToRenderPerBatch={20}
          windowSize={10}
          initialNumToRender={25}
          ItemSeparatorComponent={({ leadingItem }) => {
            // No gap between letter header and the first contact below it,
            // no gap before/after the invite divider
            if (
              leadingItem.kind === 'letter' ||
              leadingItem.kind === 'divider'
            ) return null;
            return <View style={{ height: 10 }} />;
          }}
          ListHeaderComponent={
            contacts.length > 0 ? (
              <View style={styles.headerInfo}>
                <AppText style={styles.headerInfoText}>
                  {contacts.filter((c) => c.isSaved).length} of {contacts.length} on Chit-Chat
                </AppText>
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <AppIcon name="people-outline" size={48} color={COLORS.sub} />
              <AppText style={styles.emptyText}>No contacts found</AppText>
              {query.trim() ? (
                <AppText style={styles.hintText}>Try a different search</AppText>
              ) : null}
            </View>
          }
        />
      )}

      {/* Calling overlay */}
      {calling && (
        <View style={styles.callingOverlay}>
          <ActivityIndicator size="large" color="#fff" />
          <AppText fixedColor style={styles.callingText}>
            Starting call...
          </AppText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.sky1 },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 10,
  },
  title:  { fontSize: 26, fontWeight: '800', color: COLORS.text },
  addBtn: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 14,
    marginBottom: 10,
    backgroundColor: 'rgba(9,178,238,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.18)',
    borderRadius: RADIUS.full,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0 },

  // ── Letter section headers ────────────────────────────────────────────────
  letterHeader: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 4,
  },
  letterText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.blue,
    letterSpacing: 0.6,
  },

  // ── "Invite to Chit-Chat" divider ─────────────────────────────────────────
  inviteDivider: {
    marginHorizontal: 0,
    marginTop: 20,
    marginBottom: 10,
    paddingVertical: 10,
    paddingHorizontal: 18,
    backgroundColor: COLORS.sky2,
  },
  inviteDividerText: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },

  headerInfo: { marginBottom: 6, paddingHorizontal: 18 },
  headerInfoText: { fontSize: 12, color: COLORS.sub, fontWeight: '600' },

  listContent: { paddingHorizontal: 14, paddingBottom: 30, paddingTop: 4 },

  // ── Contact / invite card ─────────────────────────────────────────────────
  contactCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  contactMeta: { flex: 1 },
  contactName: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  contactSub:  { fontSize: 12, color: COLORS.sub, marginTop: 3 },

  // Grey circle avatar for non-app contacts
  avatarPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.sky2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Call button ───────────────────────────────────────────────────────────
  callBtn: {
    width: 34,
    height: 34,
    borderRadius: RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#09B2EE',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.40,
    shadowRadius: 12,
    elevation: 10,
  },

  // ── Invite button ─────────────────────────────────────────────────────────
  inviteBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(9,178,238,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.25)',
  },
  inviteBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.blue,
  },

  // ── States ────────────────────────────────────────────────────────────────
  centerWrap: { alignItems: 'center', paddingTop: 80, gap: 12, paddingHorizontal: 40 },
  centerText: { fontSize: 15, color: COLORS.sub, fontWeight: '600', textAlign: 'center' },
  errorText:  { fontSize: 13, color: COLORS.missed, textAlign: 'center' },
  hintText:   { fontSize: 13, color: COLORS.sub, textAlign: 'center' },

  emptyWrap: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 15, color: COLORS.sub, fontWeight: '600' },

  callingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  callingText: { fontSize: 16, color: '#fff', fontWeight: '600' },
});
