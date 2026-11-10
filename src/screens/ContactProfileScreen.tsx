// ─── Screen: Contact Profile ──────────────────────────────────────────────────
// Full-page profile for another user — replaces the bottom sheet that used to
// live inside ChatScreen. Contains everything the sheet had:
//   • Hero header (avatar, name, presence, verified badge)
//   • Quick actions (call, video call, catalog, QR share)
//   • Business info (phone, email, website, industry, address, working hours)
//   • About / description
//   • Catalog shortcut
//   • Group participants
//   • Shared media
//   • Block / Unblock / Leave group / Delete contact / Delete chats

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, ScrollView, TouchableOpacity, StyleSheet, Alert,
  Linking, ActivityIndicator, Platform, Modal, Pressable,
  TextInput, Switch,
} from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { endpoints } from '../api/endpoints';
import { mediaService } from '../services/mediaService';
import { useAuth } from '../hooks/useAuth';
import { useOutgoingCall } from '../hooks/useOutgoingCall';
import { getOrCreateDirectChat } from '../hooks/useChatActions';
import { useOtherUserPresence } from '../hooks/usePresence';
import { socketClient } from '../realtime/socket';
import { trackProfileView } from '../utils/trackProfileView';

import {
  AppBg, AppText, AppIcon,
  useForeground, useTypography, useGlass,
} from '../context/ThemeContext';
import { Avatar } from '../components';
import IdentityVerificationBadge from '../components/IdentityVerificationBadge';

import { usePhoneBook } from '../hooks/usePhoneBook';

import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { INDUSTRY_CATEGORIES, type RootStackParamList, type CatalogItem, type CatalogCollection } from '../types';

type NavProp      = NativeStackNavigationProp<RootStackParamList, 'ContactProfile'>;
type RouteP       = RouteProp<RootStackParamList, 'ContactProfile'>;

// ─── BusinessProfileData ──────────────────────────────────────────────────────
interface DaySchedule { open: string; close: string; }
interface BusinessProfileData {
  email: string;
  website: string;
  phone: string;
  workSchedule: Record<string, DaySchedule>;
  operationalHours: string;   // legacy plain-text hours fallback
  catalogCount: number;
  collectionsCount: number;
  description: string;
  industry: string;
  address: {
    street: string; city: string; province: string; postalCode: string; country: string;
  } | null;
  timezone: string;
  identityVerified: boolean;
  accountType: string;
}

interface GroupMember {
  userId: string;
  displayName: string;
  photoURL: string | null;
  status: 'online' | 'away' | 'offline';
}

// ─── Hours helpers ────────────────────────────────────────────────────────────
const WEEK_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function isCurrentlyOpen(schedule: Record<string, DaySchedule>): boolean {
  if (!schedule) return false;
  const now   = new Date();
  const day   = WEEK_ORDER[now.getDay() === 0 ? 6 : now.getDay() - 1];
  const entry = schedule[day];
  if (!entry) return false;
  const [oh, om] = (entry.open  || '').split(':').map(Number);
  const [ch, cm] = (entry.close || '').split(':').map(Number);
  if (isNaN(oh) || isNaN(ch)) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= oh * 60 + om && mins < ch * 60 + cm;
}

function getTodayHoursLabel(schedule: Record<string, DaySchedule>): string {
  if (!schedule) return '';
  const day   = WEEK_ORDER[new Date().getDay() === 0 ? 6 : new Date().getDay() - 1];
  const entry = schedule[day];
  if (!entry) return 'Closed today';
  if (!entry.open && !entry.close) return 'Hours not set';
  return `${entry.open} – ${entry.close}`;
}

function getWorkHoursSummary(schedule: Record<string, DaySchedule>) {
  return WEEK_ORDER.map((day) => {
    const entry = schedule?.[day];
    const text  = entry?.open && entry?.close ? `${entry.open} – ${entry.close}` : 'Closed';
    return { day, text, isClosed: !entry?.open };
  });
}

// ─── Small helpers ────────────────────────────────────────────────────────────
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ─── InfoRow ──────────────────────────────────────────────────────────────────
function InfoRow({ icon, label, value, onPress }: {
  icon: string; label: string; value: string; onPress?: () => void;
}) {
  const { FG } = useForeground();
  const { textColor } = useTypography();
  const { bevel } = useGlass();
  const Inner = (
    <View style={[styles.infoRow, bevel]}>
      <View style={styles.infoIconWrap}>
        <AppIcon name={icon as any} size={18} color={COLORS.blue} fixedColor />
      </View>
      <View style={{ flex: 1 }}>
        <AppText style={[styles.infoLabel, { color: FG.secondary }]}>{label}</AppText>
        <AppText style={[styles.infoValue, { color: textColor }]}>{value}</AppText>
      </View>
      {onPress && <AppIcon name="open-outline" size={16} color={FG.secondary} />}
    </View>
  );
  if (onPress) return <TouchableOpacity onPress={onPress} activeOpacity={0.75}>{Inner}</TouchableOpacity>;
  return Inner;
}

// ─── ActionBtn ────────────────────────────────────────────────────────────────
function ActionBtn({ icon, label, onPress, disabled }: {
  icon: string; label: string; onPress: () => void; disabled?: boolean;
}) {
  const { FG } = useForeground();
  return (
    <TouchableOpacity
      style={[styles.actionBtn, disabled && { opacity: 0.4 }]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.75}
    >
      <LinearGradient colors={GRADIENTS.primary} style={styles.actionBtnIcon}>
        <AppIcon name={icon as any} size={22} color="#fff" fixedColor />
      </LinearGradient>
      <AppText style={[styles.actionBtnLabel, { color: FG.secondary }]}>{label}</AppText>
    </TouchableOpacity>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function ContactProfileScreen() {
  const navigation = useNavigation<NavProp>();
  const route      = useRoute<RouteP>();
  const {
    userId: targetId,
    displayName: initialName,
    photoUrl: initialPhoto,
    phoneNumber: initialPhone,
    chatId: routeChatId,
    isGroup = false,
    fromChat = false,
  } = route.params;

  const { user }  = useAuth();
  const myId      = user?.uid ?? null;
  const { FG }    = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { bevel } = useGlass();
  const insets    = useSafeAreaInsets();

  const { resolveName, contactsMap, reloadPhoneBook } = usePhoneBook();

  // ── Avatar URL ──────────────────────────────────────────────────
  const [avatarUrl, setAvatarUrl] = useState<string | null>(initialPhoto ?? null);

  // ── Business / public profile data ──────────────────────────────
  const [businessProfile, setBusinessProfile] = useState<BusinessProfileData | null>(null);
  const [loadingProfile,  setLoadingProfile]  = useState(true);

  // ── Catalog ──────────────────────────────────────────────────────
  const [sellerCatalog,     setSellerCatalog]     = useState<CatalogItem[]>([]);
  const [sellerCollections, setSellerCollections] = useState<CatalogCollection[]>([]);

  // ── Group members ────────────────────────────────────────────────
  const [groupMembers,  setGroupMembers]  = useState<GroupMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  // ── Presence (1-on-1 only) ───────────────────────────────────────
  const { statusText: presenceText, isOnline } = useOtherUserPresence(
    isGroup ? null : targetId,
    isGroup,
    true,
  );

  // ── Block status ─────────────────────────────────────────────────
  const [blockedByMe,  setBlockedByMe]  = useState(false);
  const [showBlockConfirm, setShowBlockConfirm] = useState(false);

  // ── Leave group ──────────────────────────────────────────────────
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [leavingGroup,     setLeavingGroup]     = useState(false);

  // ── Add / edit contact ───────────────────────────────────────────
  const [addContactOpen, setAddContactOpen] = useState(false);
  const otherUserPhone  = businessProfile?.phone ?? initialPhone ?? '';
  const savedContactName = useMemo(() => {
    if (isGroup || !otherUserPhone) return null;
    const { normalizePhone } = require('../utils/phoneUtils');
    return contactsMap.get(normalizePhone(otherUserPhone)) ?? null;
  }, [isGroup, otherUserPhone, contactsMap]);
  const isUnsavedContact = !isGroup && !!otherUserPhone && !savedContactName;

  // ── Chat ID (created on first message open) ──────────────────────
  const [chatId, setChatId] = useState<string | undefined>(routeChatId);

  const { initiateCall } = useOutgoingCall();
  const [calling, setCalling] = useState(false);

  // ── Load public profile + catalog ───────────────────────────────
  useEffect(() => {
    if (isGroup || !targetId) return;
    let cancelled = false;
    setLoadingProfile(true);
    (async () => {
      try {
        const res = await endpoints.getUser(targetId);
        if (!res.ok || cancelled) return;
        const data = res.data;

        // Resolve avatar
        if (data.avatarObjectKey) {
          try {
            const urls = await mediaService.getDownloadUrls([data.avatarObjectKey]);
            if (!cancelled) setAvatarUrl(urls[data.avatarObjectKey] ?? null);
          } catch { /* leave initial */ }
        }

        // Build business profile
        if (!cancelled) {
          setBusinessProfile({
            email:            data.email || '',
            website:          data.website || '',
            phone:            data.phoneNumber || '',
            workSchedule:     (data.workSchedule as any) ?? {},
            operationalHours: data.operationalHours || '',
            catalogCount:     (data.catalogItems ?? []).length,
            collectionsCount: (data.catalogCollections ?? []).length,
            description:      data.about || '',
            industry:         data.industry || '',
            address:          (data.address as any) ?? null,
            timezone:         (data as any).timezone || '',
            identityVerified: data.identityVerified === true,
            accountType:      data.accountType || '',
          });
          // Use block state from the profile response — avoids a separate listBlocks call
          setBlockedByMe(data.iBlocked === true);
        }

        // Build catalog
        const items: CatalogItem[] = (data.catalogItems ?? []).map((i) => ({
          id: String(i.id), name: i.name, price: i.price,
          description: i.description ?? undefined,
          imageObjectKey: i.imageUri ?? null,
          imageUri: i.imageUri ?? null,
          collectionId: i.collectionId ?? null,
        }));
        const cols: CatalogCollection[] = (data.catalogCollections ?? []).map((c) => ({
          id: String(c.id), name: c.name, emoji: c.emoji ?? null, createdAt: c.createdAt ?? 0,
        }));

        const keys = items.map((i) => i.imageUri).filter((k): k is string => !!k);
        let urls: Record<string, string> = {};
        if (keys.length > 0) {
          try { urls = await mediaService.getDownloadUrls(keys); } catch { /* skip */ }
        }
        if (cancelled) return;
        setSellerCatalog(items.map((i) => ({ ...i, imageUri: i.imageUri ? (urls[i.imageUri] ?? null) : null })));
        setSellerCollections(cols);
      } catch { /* silent */ }
      finally { if (!cancelled) setLoadingProfile(false); }
    })();
    return () => { cancelled = true; };
  }, [isGroup, targetId]);

  // ── Load group members ───────────────────────────────────────────
  useEffect(() => {
    if (!isGroup || !chatId) return;
    let cancelled = false;
    setLoadingMembers(true);
    (async () => {
      try {
        const chatsRes = await endpoints.listChats();
        const thisChat = chatsRes.ok ? chatsRes.data.chats.find((c) => c.chatId === chatId) : null;
        const memberIds = thisChat?.members ?? [];
        const members = await Promise.all(memberIds.map(async (mid) => {
          try {
            const r = await endpoints.getUser(mid);
            if (!r.ok) return { userId: mid, displayName: 'Unknown', photoURL: null, status: 'offline' as const };
            const photoURL = r.data.avatarObjectKey
              ? await mediaService.getDownloadUrl(r.data.avatarObjectKey)
              : null;
            return {
              userId: mid,
              displayName: r.data.displayName || resolveName(r.data.phoneNumber || '', 'Unknown'),
              photoURL,
              status: 'offline' as const,
            };
          } catch { return { userId: mid, displayName: 'Unknown', photoURL: null, status: 'offline' as const }; }
        }));
        if (!cancelled) setGroupMembers(members);
      } catch { /* silent */ }
      finally { if (!cancelled) setLoadingMembers(false); }
    })();
    return () => { cancelled = true; };
  }, [isGroup, chatId, resolveName]);

  // ── Block status ─────────────────────────────────────────────────
  useEffect(() => {
    if (!myId || !targetId || isGroup) return;
    (async () => {
      try {
        const res = await endpoints.listBlocks();
        if (res.ok) setBlockedByMe(res.data.blocked.some((b) => b.userId === targetId));
      } catch { /* silent */ }
    })();
  }, [myId, targetId, isGroup]);

  // ── Profile view tracking ─────────────────────────────────────────
  useEffect(() => {
    if (isGroup || !targetId || !myId || myId === targetId) return;
    const dayKey = new Date().toISOString().slice(0, 10);
    const key = `pv_${targetId}_${dayKey}`;
    (async () => {
      try {
        const already = await AsyncStorage.getItem(key);
        if (already) return;
        await trackProfileView(targetId);
        await AsyncStorage.setItem(key, '1');
      } catch { /* silent */ }
    })();
  }, [isGroup, targetId, myId]);

  // ── Identity status socket updates ────────────────────────────────
  useEffect(() => {
    if (isGroup || !targetId) return;
    return socketClient.subscribe('user:identity-status', (raw) => {
      const p = raw as { userId?: string; identityVerified?: boolean } | null;
      if (p?.userId !== targetId || typeof p.identityVerified !== 'boolean') return;
      setBusinessProfile((prev) => prev ? { ...prev, identityVerified: p.identityVerified! } : prev);
    });
  }, [isGroup, targetId]);

  // ── Navigation helpers ────────────────────────────────────────────
  const openChat = useCallback(async () => {
    if (!myId) return;
    try {
      const id = chatId ?? await getOrCreateDirectChat(myId, targetId);
      setChatId(id);
      navigation.navigate('Chat', {
        chatId: id,
        displayName: businessProfile?.phone
          ? (savedContactName ?? initialName)
          : initialName,
        isGroup,
        otherUserId: targetId,
        otherUserPhoto: avatarUrl,
      });
    } catch { Alert.alert('Error', 'Could not open chat.'); }
  }, [myId, chatId, targetId, navigation, businessProfile, savedContactName, initialName, isGroup, avatarUrl]);

  const startVoiceCall = useCallback(async () => {
    if (!myId || calling) return;
    setCalling(true);
    try {
      await initiateCall(
        myId, targetId,
        { userId: myId, displayName: user?.displayName ?? '', photoUrl: user?.photoURL ?? null },
        { userId: targetId, displayName: initialName, photoUrl: avatarUrl },
        'audio',
      );
    } finally { setCalling(false); }
  }, [myId, targetId, calling, initiateCall, user, initialName, avatarUrl]);

  const startVideoCall = useCallback(async () => {
    if (!myId || calling) return;
    setCalling(true);
    try {
      await initiateCall(
        myId, targetId,
        { userId: myId, displayName: user?.displayName ?? '', photoUrl: user?.photoURL ?? null },
        { userId: targetId, displayName: initialName, photoUrl: avatarUrl },
        'video',
      );
    } finally { setCalling(false); }
  }, [myId, targetId, calling, initiateCall, user, initialName, avatarUrl]);

  const handleBlock = useCallback(() => {
    Alert.alert(`Block ${initialName}?`, "They won't be able to message or call you.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: async () => {
        try {
          await endpoints.blockUser(targetId);
          setBlockedByMe(true);
          setShowBlockConfirm(false);
        } catch { Alert.alert('Error', 'Could not block.'); }
      }},
    ]);
  }, [targetId, initialName]);

  const handleUnblock = useCallback(async () => {
    try {
      await endpoints.unblockUser(targetId);
      setBlockedByMe(false);
    } catch { Alert.alert('Error', 'Could not unblock.'); }
  }, [targetId]);

  const handleDeleteContact = useCallback(() => {
    if (!otherUserPhone || Platform.OS === 'web') return;
    Alert.alert('Delete Contact', 'Remove this contact from your phone? The chat stays.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        try {
          const Contacts = await import('expo-contacts/legacy');
          const { status } = await Contacts.requestPermissionsAsync();
          if (status !== 'granted') return;
          const { normalizePhone } = await import('../utils/phoneUtils');
          const normalized = normalizePhone(otherUserPhone);
          const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
          await Promise.all(
            data
              .filter((c: any) => (c.phoneNumbers ?? []).some((pn: any) => normalizePhone(pn.number ?? '') === normalized))
              .map((c: any) => c.id ? Contacts.removeContactAsync(c.id) : Promise.resolve()),
          );
          reloadPhoneBook();
        } catch { /* silent */ }
      }},
    ]);
  }, [otherUserPhone, reloadPhoneBook]);

  const handleLeaveGroup = useCallback(async () => {
    if (!chatId) return;
    setLeavingGroup(true);
    try {
      await endpoints.leaveChat(chatId);
      navigation.goBack();
    } catch { Alert.alert('Error', 'Could not leave group.'); }
    finally { setLeavingGroup(false); }
  }, [chatId, navigation]);

  const displayName = businessProfile?.phone
    ? (savedContactName ?? initialName)
    : initialName;

  // ── Render ────────────────────────────────────────────────────────
  return (
    <View style={styles.root}>
      <AppBg />

      {/* ── Header bar ── */}
      <View style={[styles.headerBar, { paddingTop: insets.top + 4 }]}>
        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <AppIcon name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>

        <AppText
          style={[styles.headerTitle, { color: textColor, fontFamily }]}
          numberOfLines={1}
        >
          {isGroup ? 'Group Info' : 'Contact Info'}
        </AppText>

        <TouchableOpacity
          style={styles.headerBtn}
          onPress={() =>
            Alert.alert(displayName, undefined, [
              !isGroup && !blockedByMe
                ? { text: 'Block',  style: 'destructive', onPress: () => setShowBlockConfirm(true) }
                : !isGroup && blockedByMe
                ? { text: 'Unblock', onPress: handleUnblock }
                : null,
              !isGroup
                ? { text: 'Report', style: 'destructive', onPress: () =>
                    Alert.alert('Report', `Report ${displayName}?`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Report', style: 'destructive', onPress: async () => {
                        try { await endpoints.reportUser(targetId); Alert.alert('Reported', 'Thank you.'); }
                        catch { Alert.alert('Error', 'Could not report.'); }
                      }},
                    ])
                  }
                : null,
              { text: 'Cancel', style: 'cancel' },
            ].filter(Boolean) as any)
          }
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <AppIcon name="ellipsis-vertical" size={22} color={textColor} />
        </TouchableOpacity>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Hero ── */}
        <View style={styles.hero}>
          <LinearGradient
            colors={[COLORS.blue, '#0a74c4']}
            start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
            style={styles.heroBanner}
          />
          {/* Edit contact pill */}
          {!isGroup && !!savedContactName && (
            <TouchableOpacity
              style={styles.heroEditBtn}
              onPress={() => setAddContactOpen(true)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <AppIcon name="create-outline" size={16} color="#fff" fixedColor />
            </TouchableOpacity>
          )}
          {/* Avatar ring */}
          <View style={styles.avatarRing}>
            <Avatar
              initials={getInitials(displayName)}
              color={COLORS.blue}
              size={86}
              imageUrl={avatarUrl}
            />
          </View>
        </View>

        {/* ── Name / presence ── */}
        <View style={styles.nameBlock}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <AppText style={[styles.name, { color: textColor, fontFamily }]}>
              {displayName}
            </AppText>
            {!isGroup && businessProfile?.identityVerified && (
              <IdentityVerificationBadge verified compact />
            )}
          </View>
          <AppText style={[styles.accountType, { color: FG.secondary }]}>
            {isGroup ? 'Group' : (businessProfile?.accountType
              ? businessProfile.accountType.charAt(0).toUpperCase() + businessProfile.accountType.slice(1) + ' account'
              : 'Business account')}
          </AppText>
          {!isGroup && (
            <AppText style={[styles.presence, { color: isOnline ? COLORS.blue : FG.secondary }]}>
              {presenceText || ''}
            </AppText>
          )}
          {loadingProfile && !isGroup && (
            <ActivityIndicator style={{ marginTop: 8 }} size="small" color={COLORS.blue} />
          )}
        </View>

        {/* ── Quick actions ── */}
        {!isGroup && (
          <View style={[styles.actionsRow, bevel]}>
            <ActionBtn icon="chatbubble-outline" label="Message"    onPress={openChat}       />
            <View style={styles.actionDivider} />
            <ActionBtn icon="call-outline"      label="Audio call"  onPress={startVoiceCall} disabled={calling} />
            <View style={styles.actionDivider} />
            <ActionBtn icon="videocam-outline"  label="Video call"  onPress={startVideoCall} disabled={calling} />
          </View>
        )}

        {/* ── Add to contacts ── */}
        {!isGroup && isUnsavedContact && (
          <View style={{ paddingHorizontal: 16, marginBottom: 20 }}>
            <TouchableOpacity
              style={[styles.addContactBtn, bevel]}
              onPress={() => setAddContactOpen(true)}
              activeOpacity={0.85}
            >
              <AppIcon name="person-add-outline" size={18} color={COLORS.blue} fixedColor />
              <AppText style={[styles.addContactText, { color: COLORS.blue }]}>Add to Contacts</AppText>
            </TouchableOpacity>
          </View>
        )}

        {/* ── Business info ── */}
        {!isGroup && businessProfile && (
          <View style={styles.section}>
            <AppText style={[styles.sectionTitle, { color: FG.secondary }]}>BUSINESS INFO</AppText>

            {/* Open / closed */}
            <View style={[styles.infoRow, bevel]}>
              <View style={styles.infoIconWrap}>
                <AppIcon name="time-outline" size={18} color={COLORS.blue} fixedColor />
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={[styles.infoValue, { color: textColor }]}>
                  {isCurrentlyOpen(businessProfile.workSchedule) ? 'Open now' : 'Closed now'}
                </AppText>
                <AppText style={[styles.infoLabel, { color: FG.secondary }]}>
                  {getTodayHoursLabel(businessProfile.workSchedule)}
                </AppText>
              </View>
            </View>

            {/* Full weekly hours */}
            {Object.keys(businessProfile.workSchedule || {}).length > 0 && (
              <View style={[styles.hoursCard, bevel]}>
                <AppText style={[styles.sectionTitle, { color: FG.secondary }]}>OPENING HOURS</AppText>
                {getWorkHoursSummary(businessProfile.workSchedule).map((row) => (
                  <View key={row.day} style={styles.hoursRow}>
                    <AppText style={[styles.hoursDay, { color: textColor }]}>{row.day}</AppText>
                    <AppText style={[styles.hoursVal, { color: row.isClosed ? FG.secondary : textColor }]}>
                      {row.text}
                    </AppText>
                  </View>
                ))}
              </View>
            )}

            {businessProfile.phone ? (
              <InfoRow icon="call-outline"   label="Phone"   value={businessProfile.phone}
                onPress={() => Linking.openURL(`tel:${businessProfile.phone}`)} />
            ) : null}
            {businessProfile.email ? (
              <InfoRow icon="mail-outline"   label="Email"   value={businessProfile.email}
                onPress={() => Linking.openURL(`mailto:${businessProfile.email}`)} />
            ) : null}
            {businessProfile.website ? (
              <InfoRow icon="globe-outline"  label="Website" value={businessProfile.website}
                onPress={() => {
                  const url = businessProfile.website.startsWith('http')
                    ? businessProfile.website : `https://${businessProfile.website}`;
                  Linking.openURL(url);
                }} />
            ) : null}
            {businessProfile.industry ? (() => {
              const cat = INDUSTRY_CATEGORIES.find((c) => c.id === businessProfile.industry);
              return cat ? (
                <View style={[styles.infoRow, bevel]}>
                  <View style={styles.infoIconWrap}>
                    <AppIcon name="briefcase-outline" size={18} color={COLORS.blue} fixedColor />
                  </View>
                  <View style={{ flex: 1 }}>
                    <AppText style={[styles.infoLabel, { color: FG.secondary }]}>Industry</AppText>
                    <AppText style={[styles.infoValue, { color: textColor }]}>
                      {cat.emoji} {cat.label}
                    </AppText>
                  </View>
                </View>
              ) : null;
            })() : null}
            {businessProfile.description ? (
              <View style={[styles.aboutCard, bevel]}>
                <AppText style={[styles.sectionTitle, { color: FG.secondary }]}>ABOUT</AppText>
                <AppText style={[styles.aboutText, { color: textColor }]}>
                  {businessProfile.description}
                </AppText>
              </View>
            ) : null}
            {businessProfile.address && (
              businessProfile.address.street || businessProfile.address.city || businessProfile.address.country
            ) ? (
              <InfoRow
                icon="location-outline"
                label="Address"
                value={[
                  businessProfile.address.street,
                  businessProfile.address.city,
                  businessProfile.address.province,
                  businessProfile.address.postalCode,
                  businessProfile.address.country,
                ].filter(Boolean).join(', ')}
              />
            ) : null}
            {/* Timezone */}
            {businessProfile.timezone ? (
              <InfoRow
                icon="earth-outline"
                label="Timezone"
                value={businessProfile.timezone}
              />
            ) : null}
            {/* Operational hours fallback — shown only when no structured schedule is set */}
            {!Object.keys(businessProfile.workSchedule || {}).length && businessProfile.operationalHours ? (
              <InfoRow
                icon="time-outline"
                label="Hours"
                value={businessProfile.operationalHours}
              />
            ) : null}
          </View>
        )}

        {/* ── Catalog shortcut ── */}
        {!isGroup && sellerCatalog.length > 0 && (
          <View style={styles.section}>
            <AppText style={[styles.sectionTitle, { color: FG.secondary }]}>CATALOG</AppText>
            <TouchableOpacity
              style={[styles.catalogRow, bevel]}
              activeOpacity={0.8}
              onPress={() => {
                // Navigate to the chat so the catalog sheet can open there
                if (chatId) {
                  navigation.navigate('Chat', {
                    chatId,
                    displayName,
                    isGroup,
                    otherUserId: targetId,
                    otherUserPhoto: avatarUrl,
                  });
                }
              }}
            >
              <LinearGradient colors={GRADIENTS.primary} style={styles.catalogIcon}>
                <AppIcon name="storefront-outline" size={18} color="#fff" fixedColor />
              </LinearGradient>
              <View style={{ flex: 1 }}>
                <AppText style={[styles.infoValue, { color: textColor }]}>Catalog</AppText>
                <AppText style={[styles.infoLabel, { color: FG.secondary }]}>
                  {sellerCatalog.length} item{sellerCatalog.length !== 1 ? 's' : ''}
                  {sellerCollections.length > 0 ? ` · ${sellerCollections.length} collection${sellerCollections.length !== 1 ? 's' : ''}` : ''}
                </AppText>
              </View>
              <AppIcon name="chevron-forward" size={18} color={FG.secondary} />
            </TouchableOpacity>
          </View>
        )}

        {/* ── Group participants ── */}
        {isGroup && (
          <View style={styles.section}>
            <AppText style={[styles.sectionTitle, { color: FG.secondary }]}>
              PARTICIPANTS ({groupMembers.length})
            </AppText>
            {loadingMembers ? (
              <View style={[styles.loadingBox, bevel]}>
                <ActivityIndicator size="small" color={COLORS.blue} />
                <AppText style={[{ color: FG.secondary, marginTop: 6, fontSize: 13 }]}>
                  Loading participants…
                </AppText>
              </View>
            ) : groupMembers.map((member) => (
              <View key={member.userId} style={[styles.memberRow, bevel]}>
                <Avatar
                  initials={getInitials(member.displayName)}
                  color={COLORS.blue}
                  size={42}
                  imageUrl={member.photoURL}
                  status={member.status}
                />
                <View style={{ flex: 1 }}>
                  <AppText style={[styles.memberName, { color: textColor, fontFamily }]}>
                    {member.displayName}
                    {member.userId === myId ? (
                      <AppText style={{ color: FG.secondary, fontWeight: '400' }}> (You)</AppText>
                    ) : null}
                  </AppText>
                  <AppText style={[{ color: FG.secondary, fontSize: 12 }]}>
                    {member.status === 'online' ? 'Online' : member.status === 'away' ? 'Away' : 'Offline'}
                  </AppText>
                </View>
              </View>
            ))}
          </View>
        )}

        {/* ── Privacy / Danger zone ── */}
        <View style={styles.section}>
          <AppText style={[styles.sectionTitle, { color: FG.secondary }]}>PRIVACY</AppText>

          {/* Block / Unblock */}
          {!isGroup && (
            blockedByMe ? (
              <TouchableOpacity style={[styles.dangerRow, bevel]} onPress={handleUnblock} activeOpacity={0.8}>
                <AppIcon name="checkmark-circle-outline" size={20} color={COLORS.blue} fixedColor />
                <AppText style={[styles.dangerLabel, { color: COLORS.blue }]}>Unblock {displayName}</AppText>
              </TouchableOpacity>
            ) : !showBlockConfirm ? (
              <TouchableOpacity style={[styles.dangerRow, bevel]} onPress={() => setShowBlockConfirm(true)} activeOpacity={0.8}>
                <AppIcon name="ban-outline" size={20} color={COLORS.missed} fixedColor />
                <AppText style={[styles.dangerLabel, { color: COLORS.missed }]}>Block {displayName}</AppText>
              </TouchableOpacity>
            ) : (
              <View style={[styles.confirmCard, bevel]}>
                <LinearGradient colors={['rgba(255,59,48,0.20)','rgba(255,149,0,0.20)']} style={styles.confirmIconWrap}>
                  <AppIcon name="ban-outline" size={28} color={COLORS.missed} fixedColor />
                </LinearGradient>
                <AppText style={[styles.confirmTitle, { color: textColor, fontFamily }]}>Block {displayName}?</AppText>
                <AppText style={[styles.confirmBody, { color: FG.secondary }]}>
                  Blocked contacts cannot call you or send you messages.
                </AppText>
                <View style={styles.confirmBtns}>
                  <TouchableOpacity style={[styles.confirmCancel, { borderColor: FG.glassBorder }]} onPress={() => setShowBlockConfirm(false)}>
                    <AppText style={[styles.confirmCancelTxt, { color: textColor }]}>Cancel</AppText>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.confirmAction, { backgroundColor: COLORS.missed }]} onPress={handleBlock}>
                    <AppText style={styles.confirmActionTxt}>Block</AppText>
                  </TouchableOpacity>
                </View>
              </View>
            )
          )}

          {/* Leave group */}
          {isGroup && (
            !showLeaveConfirm ? (
              <TouchableOpacity style={[styles.dangerRow, bevel]} onPress={() => setShowLeaveConfirm(true)} activeOpacity={0.8}>
                <AppIcon name="exit-outline" size={20} color={COLORS.missed} fixedColor />
                <AppText style={[styles.dangerLabel, { color: COLORS.missed }]}>Leave Group</AppText>
              </TouchableOpacity>
            ) : (
              <View style={[styles.confirmCard, bevel]}>
                <LinearGradient colors={['rgba(255,59,48,0.20)','rgba(255,149,0,0.20)']} style={styles.confirmIconWrap}>
                  <AppIcon name="exit-outline" size={28} color={COLORS.missed} fixedColor />
                </LinearGradient>
                <AppText style={[styles.confirmTitle, { color: textColor, fontFamily }]}>Leave Group?</AppText>
                <AppText style={[styles.confirmBody, { color: FG.secondary }]}>
                  You will no longer receive messages from this group.
                </AppText>
                <View style={styles.confirmBtns}>
                  <TouchableOpacity style={[styles.confirmCancel, { borderColor: FG.glassBorder }]} onPress={() => setShowLeaveConfirm(false)} disabled={leavingGroup}>
                    <AppText style={[styles.confirmCancelTxt, { color: textColor }]}>Cancel</AppText>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.confirmAction, { backgroundColor: COLORS.missed }]} onPress={handleLeaveGroup} disabled={leavingGroup}>
                    {leavingGroup
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <AppText style={styles.confirmActionTxt}>Leave Group</AppText>}
                  </TouchableOpacity>
                </View>
              </View>
            )
          )}

          {/* Delete contact */}
          {!isGroup && !!savedContactName && (
            <TouchableOpacity style={[styles.dangerRow, bevel, { marginTop: 10 }]} onPress={handleDeleteContact} activeOpacity={0.8}>
              <AppIcon name="person-remove-outline" size={20} color={COLORS.missed} fixedColor />
              <AppText style={[styles.dangerLabel, { color: COLORS.missed }]}>Delete Contact</AppText>
            </TouchableOpacity>
          )}
        </View>

      </ScrollView>

      {/* ── Add / edit contact sheet ── */}
      <AddContactSheet
        visible={addContactOpen}
        onClose={() => setAddContactOpen(false)}
        phone={otherUserPhone}
        suggestedName={displayName}
        existingName={savedContactName}
        onSaved={() => { setAddContactOpen(false); reloadPhoneBook(); }}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root:  { flex: 1 },

  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  headerBtn:   { padding: 4 },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', textAlign: 'center' },

  scroll: { paddingHorizontal: 0 },

  // Hero
  hero:       { alignItems: 'center', marginBottom: 0 },
  heroBanner: {
    width: '100%', height: 130,
    borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
  },
  heroEditBtn: {
    position: 'absolute', top: 12, right: 16,
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 16, padding: 7,
  },
  avatarRing: {
    marginTop: -48,
    padding: 4,
    borderRadius: 52,
    backgroundColor: 'rgba(0,0,0,0.15)',
  },

  // Name block
  nameBlock:   { alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 },
  name:        { fontSize: 24, fontWeight: '800', letterSpacing: -0.3, textAlign: 'center', marginBottom: 4 },
  accountType: { fontSize: 13, textAlign: 'center' },
  presence:    { fontSize: 13, marginTop: 3, textAlign: 'center' },

  // Quick actions
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    marginHorizontal: 16,
    borderRadius: RADIUS.xl,
    paddingVertical: 16,
    paddingHorizontal: 8,
    marginBottom: 24,
    ...SHADOW.card,
  },
  actionBtn:      { flex: 1, alignItems: 'center', gap: 8 },
  actionBtnIcon:  { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', ...SHADOW.button },
  actionBtnLabel: { fontSize: 12, fontWeight: '600' },
  actionDivider:  { width: StyleSheet.hairlineWidth, height: 40, backgroundColor: 'rgba(120,120,140,0.2)' },

  // Add contact
  addContactBtn:  { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: RADIUS.lg, padding: 14, ...SHADOW.card },
  addContactText: { fontSize: 15, fontWeight: '600' },

  // Sections
  section:      { marginHorizontal: 16, marginBottom: 24 },
  sectionTitle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.8, marginBottom: 8, marginLeft: 4 },

  // Info rows
  infoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.lg, padding: 14, marginBottom: 8, ...SHADOW.card },
  infoIconWrap: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(9,178,238,0.12)', alignItems: 'center', justifyContent: 'center' },
  infoLabel: { fontSize: 11, fontWeight: '600', letterSpacing: 0.3, marginBottom: 2 },
  infoValue: { fontSize: 15 },

  // Hours
  hoursCard: { borderRadius: RADIUS.lg, padding: 14, marginBottom: 8, ...SHADOW.card },
  hoursRow:  { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  hoursDay:  { fontSize: 14, fontWeight: '600', flex: 1 },
  hoursVal:  { fontSize: 14 },

  // About
  aboutCard: { borderRadius: RADIUS.lg, padding: 14, marginBottom: 8, ...SHADOW.card },
  aboutText: { fontSize: 15, lineHeight: 22 },

  // Catalog
  catalogRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.lg, padding: 14, ...SHADOW.card },
  catalogIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },

  // Members
  loadingBox: { borderRadius: RADIUS.lg, padding: 20, alignItems: 'center', marginBottom: 8, ...SHADOW.card },
  memberRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.lg, padding: 12, marginBottom: 8, ...SHADOW.card },
  memberName: { fontSize: 15, fontWeight: '600' },

  // Danger
  dangerRow:   { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.lg, padding: 14, marginBottom: 8, ...SHADOW.card },
  dangerLabel: { fontSize: 15, fontWeight: '600' },

  // Confirmation card
  confirmCard:     { borderRadius: RADIUS.xl, padding: 20, alignItems: 'center', gap: 8, marginBottom: 8, ...SHADOW.card },
  confirmIconWrap: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  confirmTitle:    { fontSize: 17, fontWeight: '700', textAlign: 'center' },
  confirmBody:     { fontSize: 14, textAlign: 'center', lineHeight: 20 },
  confirmBtns:     { flexDirection: 'row', gap: 12, marginTop: 8 },
  confirmCancel:   { flex: 1, borderRadius: RADIUS.lg, borderWidth: 1, padding: 13, alignItems: 'center' },
  confirmCancelTxt:{ fontSize: 15, fontWeight: '600' },
  confirmAction:   { flex: 1, borderRadius: RADIUS.lg, padding: 13, alignItems: 'center' },
  confirmActionTxt:{ fontSize: 15, fontWeight: '700', color: '#fff' },
});

// ─── Add Contact Sheet ────────────────────────────────────────────────────────
// Lets the user save an unsaved contact. First/last name fields plus a
// "Sync to phone" switch that also writes to the device address book.
function AddContactSheet({
  visible, onClose, phone, suggestedName, existingName, onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  phone: string;
  suggestedName: string;
  existingName: string | null;
  onSaved: () => void;
}) {
  const { textColor } = useTypography();
  const { FG } = useForeground();
  const { bevel } = useGlass();

  const isEditing = !!existingName;

  const [firstName, setFirstName] = useState('');
  const [lastName,  setLastName]  = useState('');
  const [syncToPhone, setSyncToPhone] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      const seed = (existingName || suggestedName || '').trim();
      const parts = seed.split(/\s+/);
      setFirstName(parts[0] && !/^\+?\d+$/.test(parts[0]) ? parts[0] : '');
      setLastName(parts.length > 1 && !/^\+?\d+$/.test(parts[1]) ? parts.slice(1).join(' ') : '');
      setSyncToPhone(true);
    }
  }, [visible, suggestedName, existingName]);

  const handleSave = async () => {
    const fn = firstName.trim();
    if (!fn || saving) return;
    setSaving(true);
    try {
      if (Platform.OS !== 'web' && (syncToPhone || isEditing)) {
        const Contacts = await import('expo-contacts/legacy');
        const { status } = await Contacts.requestPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission needed', 'Allow contacts access to save this contact to your phone.');
          setSaving(false);
          return;
        }

        if (isEditing) {
          const { normalizePhone } = await import('../utils/phoneUtils');
          const normalized = normalizePhone(phone);
          const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
          await Promise.all(
            data
              .filter((c: any) => (c.phoneNumbers ?? []).some((pn: any) => normalizePhone(pn.number ?? '') === normalized))
              .map((c: any) => c.id ? Contacts.removeContactAsync(c.id) : Promise.resolve())
          );
        }

        if (syncToPhone) {
          await Contacts.addContactAsync({
            [Contacts.Fields.FirstName]: fn,
            [Contacts.Fields.LastName]:  lastName.trim(),
            [Contacts.Fields.PhoneNumbers]: [{ label: 'mobile', number: phone }],
          } as any);
        }
      }
      onSaved();
    } catch (err) {
      console.error('[AddContactSheet] Failed to save contact:', err);
      Alert.alert('Could not save', 'Failed to save the contact. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={addContactSheetStyles.overlay} onPress={onClose} />
      <View style={[addContactSheetStyles.sheet, { backgroundColor: FG.glassBg, borderColor: FG.glassBorder }]}>
        <AppBg />
        <View style={addContactSheetStyles.handle} />

        <View style={addContactSheetStyles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <AppIcon name="close" size={22} color={COLORS.sub} />
          </TouchableOpacity>
          <AppText style={[addContactSheetStyles.title, { color: textColor }]}>
            {isEditing ? 'Edit Contact' : 'New Contact'}
          </AppText>
          <TouchableOpacity onPress={handleSave} disabled={!firstName.trim() || saving} activeOpacity={0.85}>
            {saving
              ? <ActivityIndicator size="small" color={COLORS.blue} />
              : <AppText style={[addContactSheetStyles.save, { opacity: firstName.trim() ? 1 : 0.4 }]}>Save</AppText>}
          </TouchableOpacity>
        </View>

        <View style={{ paddingHorizontal: 18, gap: 12 }}>
          <View style={[addContactSheetStyles.input, bevel]}>
            <AppIcon name="person-outline" size={18} color={COLORS.sub} />
            <TextInput
              style={[addContactSheetStyles.inputField, { color: textColor }]}
              placeholder="First name"
              placeholderTextColor={COLORS.sub}
              value={firstName}
              onChangeText={setFirstName}
              autoFocus
            />
          </View>

          <View style={[addContactSheetStyles.input, bevel]}>
            <AppIcon name="person-outline" size={18} color={COLORS.sub} />
            <TextInput
              style={[addContactSheetStyles.inputField, { color: textColor }]}
              placeholder="Last name"
              placeholderTextColor={COLORS.sub}
              value={lastName}
              onChangeText={setLastName}
            />
          </View>

          <View style={[addContactSheetStyles.input, bevel]}>
            <AppIcon name="call-outline" size={18} color={COLORS.sub} />
            <AppText style={[addContactSheetStyles.inputField, { color: FG.secondary }]}>{phone}</AppText>
          </View>

          <View style={[addContactSheetStyles.switchRow, bevel]}>
            <View style={{ flex: 1 }}>
              <AppText style={[addContactSheetStyles.switchLabel, { color: textColor }]}>Sync to phone</AppText>
              <AppText style={[addContactSheetStyles.switchSub, { color: FG.secondary }]}>
                Also save this contact to your device address book
              </AppText>
            </View>
            <Switch
              value={syncToPhone}
              onValueChange={setSyncToPhone}
              trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.blue }}
              thumbColor="#fff"
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const addContactSheetStyles = StyleSheet.create({
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 36 : 24,
    overflow: 'hidden', borderWidth: 1,
    ...SHADOW.glow,
  },
  handle: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(30,156,240,0.30)', marginTop: 10, marginBottom: 4 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 14,
  },
  title:      { fontSize: 17, fontWeight: '700' },
  save:       { fontSize: 15, fontWeight: '700', color: COLORS.blue },
  input:      { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: RADIUS.md, paddingHorizontal: 14, minHeight: 50 },
  inputField: { flex: 1, fontSize: 15, padding: 0 },
  switchRow:  { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 12, marginTop: 4 },
  switchLabel:{ fontSize: 15, fontWeight: '600' },
  switchSub:  { fontSize: 12, marginTop: 2 },
});



