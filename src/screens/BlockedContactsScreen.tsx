// ─── Screen: Blocked Contacts ─────────────────────────────────────────────────
//
// COMPANION NOTE
//   The list is readable on a companion device (owner's blocked list), but
//   unblocking is a write — the rule for users/{uid}/blockedUsers requires
//   request.auth.uid == userId, and a companion's auth.uid is anon. So the
//   list renders read-only and the Unblock button is disabled with an
//   explanatory alert.
//
import React, { useState } from 'react';
import {
  View,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Avatar } from '../components';
import { useAuth } from '../context/AuthContext';
import { useBlockedContacts, BlockedContact } from '../hooks/useBlockedContacts';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList } from '../types';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'BlockedContacts'>;

export default function BlockedContactsScreen() {
  const navigation = useNavigation<NavProp>();

  // ownerUid === the account whose blocked list we're viewing. On a companion
  // this is the owner's uid, so the list matches what the owner sees.
  // isCompanion gates the destructive Unblock action.
  const { userId: ownerUid, isCompanion } = useAuth();

  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();
  const { blockedContacts, loading, unblockContact } = useBlockedContacts(ownerUid);
  const [unblocking, setUnblocking] = useState<string | null>(null);

  // ── Unblock handler ───────────────────────────────────────────────
  const handleUnblock = (contact: BlockedContact) => {
    if (isCompanion) {
      Alert.alert(
        'Managed on your primary device',
        'Blocking and unblocking contacts is not available on companion devices. Open ChitChat on the phone you signed in with to change this.',
      );
      return;
    }

    Alert.alert(
      'Unblock Contact',
      `Unblock ${contact.displayName}? You'll be able to send and receive messages from this contact again.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Unblock',
          style: 'default',
          onPress: async () => {
            setUnblocking(contact.userId);
            const result = await unblockContact(contact.userId);
            setUnblocking(null);

            if (result.success) {
              Alert.alert('Success', `${contact.displayName} has been unblocked.`);
            } else {
              Alert.alert('Error', result.error || 'Failed to unblock contact.');
            }
          },
        },
      ]
    );
  };

  // ── Format blocked date ────────────────────────────────────────────
  const formatBlockedDate = (date: Date): string => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Blocked today';
    if (diffDays === 1) return 'Blocked yesterday';
    if (diffDays < 7) return `Blocked ${diffDays} days ago`;
    if (diffDays < 30) return `Blocked ${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `Blocked ${Math.floor(diffDays / 30)} months ago`;
    return `Blocked ${date.toLocaleDateString([], { year: 'numeric', month: 'short' })}`;
  };

  // ── Render blocked contact item ────────────────────────────────────
  const renderContact = ({ item }: { item: BlockedContact }) => {
    const isUnblocking = unblocking === item.userId;

    return (
      <View style={[styles.contactItem, bevel]}>
        <Avatar
          size={50}
          initials={item.displayName.split(' ').map((w: string) => w[0]).join('').toUpperCase().slice(0, 2) || '?'}
          color={(() => {
            const palette = ['#f97316','#8b5cf6','#ec4899','#06b6d4','#10b981','#f59e0b','#6366f1','#e11d48'];
            let h = 0;
            for (let i = 0; i < item.displayName.length; i++) h = item.displayName.charCodeAt(i) + ((h << 5) - h);
            return palette[Math.abs(h) % palette.length];
          })()}
          imageUrl={item.photoURL}
        />

        <View style={styles.contactInfo}>
          <AppText style={[styles.contactName, { color: textColor, fontFamily }]}>
            {item.displayName}
          </AppText>
          <AppText style={[styles.contactDate, { color: FG.secondary }]}>
            {formatBlockedDate(item.blockedAt)}
          </AppText>
        </View>

        {/* Unblock is a write — disabled on companion devices */}
        <TouchableOpacity
          style={[
            styles.unblockBtn,
            { borderColor: isCompanion ? COLORS.sub : COLORS.blue },
            isCompanion && styles.unblockBtnDisabled,
          ]}
          onPress={() => handleUnblock(item)}
          disabled={isUnblocking}
          activeOpacity={0.8}
        >
          {isUnblocking ? (
            <ActivityIndicator size="small" color={COLORS.blue} />
          ) : (
            <AppText
              style={[
                styles.unblockText,
                { color: isCompanion ? COLORS.sub : COLORS.blue },
              ]}
            >
              Unblock
            </AppText>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  // ── Empty state ────────────────────────────────────────────────────
  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <View style={[styles.emptyIconWrap, { backgroundColor: FG.glassBg }]}>
        <AppIcon name="ban-outline" size={48} color={FG.secondary} />
      </View>
      <AppText style={[styles.emptyTitle, { color: textColor, fontFamily }]}>
        No Blocked Contacts
      </AppText>
      <AppText style={[styles.emptyText, { color: FG.secondary }]}>
        When you block someone, they'll appear here.{'\n'}
        You won't receive calls or messages from blocked contacts.
      </AppText>
    </View>
  );

  return (
    <AppBg>
      <SafeAreaView style={styles.container} edges={['top']}>
        {/* ── Header ── */}
        <View style={[styles.header, { backgroundColor: FG.glassBg, borderBottomColor: FG.glassBorder }]}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            activeOpacity={0.7}
          >
            <AppIcon name="arrow-back" size={24} color={textColor} />
          </TouchableOpacity>

          <AppText style={[styles.headerTitle, { color: textColor, fontFamily }]}>
            Blocked Contacts
          </AppText>

          <View style={styles.headerRight} />
        </View>

        {/* Companion notice — read-only list */}
        {isCompanion && (
          <View style={[styles.noticeCard, bevel]}>
            <LinearGradient
              colors={['#6366f1', '#8b5cf6']}
              style={styles.noticeIconWrap}
            >
              <AppIcon name="link-outline" size={18} color="#fff" fixedColor />
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <AppText style={[styles.noticeTitle, { color: textColor, fontFamily }]}>
                Read-only on this device
              </AppText>
              <AppText style={[styles.noticeBody, { color: FG.secondary }]}>
                You can view the blocked list, but blocking or unblocking a
                contact requires the primary device.
              </AppText>
            </View>
          </View>
        )}

        {/* ── Content ── */}
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={COLORS.blue} />
            <AppText style={[styles.loadingText, { color: FG.secondary }]}>
              Loading blocked contacts...
            </AppText>
          </View>
        ) : (
          <FlatList
            data={blockedContacts}
            renderItem={renderContact}
            keyExtractor={(item) => item.userId}
            contentContainerStyle={[
              styles.listContent,
              blockedContacts.length === 0 && styles.listContentEmpty,
            ]}
            ListEmptyComponent={renderEmpty}
            showsVerticalScrollIndicator={false}
          />
        )}
      </SafeAreaView>
    </AppBg>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.8)',
  },
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
    marginHorizontal: 8,
  },
  headerRight: {
    width: 40,
  },
  listContent: {
    padding: 16,
    gap: 12,
  },
  listContentEmpty: {
    flex: 1,
    justifyContent: 'center',
  },
  contactItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: RADIUS.lg,
    gap: 12,
  },
  contactInfo: {
    flex: 1,
    gap: 4,
  },
  contactName: {
    fontSize: 16,
    fontWeight: '600',
  },
  contactDate: {
    fontSize: 13,
  },
  unblockBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    minWidth: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unblockBtnDisabled: {
    opacity: 0.6,
  },
  unblockText: {
    fontSize: 14,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 14,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  emptyIconWrap: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },

  // Companion notice
  noticeCard: {
    flexDirection: 'row', gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 14,
    marginHorizontal: 16, marginTop: 12,
  },
  noticeIconWrap: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    ...SHADOW.button,
  },
  noticeTitle: { fontSize: 13, fontWeight: '800', marginBottom: 3 },
  noticeBody:  { fontSize: 12, lineHeight: 17 },
});