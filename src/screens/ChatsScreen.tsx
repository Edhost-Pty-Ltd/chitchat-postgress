// ─── Screen: Chats ───────────────────────────────────────────────────────────
import React, { useState, useRef, useMemo, useEffect, useCallback, memo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, Modal, Pressable, ScrollView, Animated,
  ActivityIndicator, Image, Platform, Alert,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { BottomNav } from '../components';
import { useAuth } from '../context/AuthContext';
import { useChats, ChatPreview } from '../hooks/useChats';
import { useContacts, AppContact } from '../hooks/useContacts';
import { useChatPrefs, MAX_PINNED } from '../hooks/useChatPrefs';
import { SwipeableRow } from '../components/SwipeableRow';
import { ChatPreviewModal } from '../components/ChatPreviewModal';
import { clearLocalMessages } from '../hooks/useLocalMessages';
import { fetchUserPrivacySettings, isVisibleTo } from '../hooks/usePrivacySettings';
import { useStatus } from '../hooks/useStatus';
import { getOrCreateDirectChat } from '../hooks/useChatActions';
import { resolveDisplayName } from '../utils/resolveDisplayName';
import { db } from '../config/firebase';
import firestore from '@react-native-firebase/firestore';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList } from '../types';

import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import BroadcastScreen from './BroadcastScreen';

type NavProp   = NativeStackNavigationProp<RootStackParamList, 'Chats'>;
type TabType   = 'Chats' | 'Groups' | 'Broadcast' | string;
type SheetMode = 'select' | 'newContact' | 'newGroup';

const NO_CHAT_PREFIX = '__nochat__';

// ─── Chat Label types ────────────────────────────────────────────────────────
interface ChatLabel {
  id:        string;
  title:     string;
  memberIds: string[];
  groupIds:  string[];
  createdAt: number;
  updatedAt: number;
}

interface GroupOption {
  chatId:      string;
  name:        string;
  photoURL?:   string | null;
  memberCount: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(date: Date | null): string {
  if (!date) return '';
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString([], { weekday: 'long' });
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit' });
}

function stringToColor(str: string): string {
  const colors = ['#f97316','#8b5cf6','#ec4899','#06b6d4','#10b981','#f59e0b','#6366f1','#e11d48'];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatSAPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 9)}`;
}

function classifyChat(c: ChatPreview): 'direct' | 'group' {
  if (c.type === 'group') return 'group';
  if (c.type === 'direct') return 'direct';
  return c.members.length > 2 ? 'group' : 'direct';
}

function describeSaveError(err: any): string {
  const code = err?.code;
  if (code === 'permission-denied') {
    return 'Permission denied. Add a Firestore rule for users/{uid}/chatLabels.';
  }
  if (code === 'unavailable' || code === 'failed-precondition') {
    return 'No connection. Check your internet and try again.';
  }
  if (code === 'unauthenticated') {
    return 'Session expired. Please sign in again.';
  }
  if (code === 'invalid-argument') {
    return 'Some of the data is invalid. Please try again.';
  }
  if (err?.message) return err.message;
  return 'Could not save the label. Please try again.';
}

function makeSyntheticChat(userId: string, memberId: string): ChatPreview {
  return {
    chatId:       `${NO_CHAT_PREFIX}${memberId}`,
    type:         'direct',
    members:      [userId, memberId],
    lastMessage:  null as any,
    lastSenderId: null as any,
    timestamp:    null as any,
    unreadCount:  0,
  } as unknown as ChatPreview;
}

// ─── Chat Avatar ──────────────────────────────────────────────────────────────
interface ChatAvatarProps {
  displayName: string;
  contactPhotoUri?: string;
  firebasePhotoURL?: string;
  isSavedContact?: boolean;
  hasStatus?: boolean;
}

const ChatAvatar = memo(function ChatAvatar({ displayName, contactPhotoUri, firebasePhotoURL, isSavedContact, hasStatus = false }: ChatAvatarProps) {
  const color = stringToColor(displayName);
  const initials = getInitials(displayName);

  const photoUri = contactPhotoUri || firebasePhotoURL;

  const avatarContent = (
    <View style={[styles.avatarCircle, { backgroundColor: color }]}>
      {photoUri ? (
        <Image
          source={{ uri: photoUri }}
          style={styles.avatarImage}
          defaultSource={require('../../assets/icon.png')}
        />
      ) : (
        <Text style={styles.avatarText}>{initials}</Text>
      )}
    </View>
  );

  if (hasStatus) {
    return (
      <LinearGradient colors={[color, COLORS.blue]} style={styles.ring}
        start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
        <View style={styles.ringInner}>
          {avatarContent}
        </View>
      </LinearGradient>
    );
  }

  return avatarContent;
});

// ─── ChatRow ──────────────────────────────────────────────────────────────────
interface ChatRowProps {
  item:             ChatPreview;
  displayName:      string;
  isGroup:          boolean;
  otherMemberId?:   string;
  contactPhotoUri?: string;
  firebasePhotoURL?:string;
  isSavedContact:   boolean;
  hasStatus:        boolean;
  userId:           string | null;
  bevel:            object;
  textColor:        string;
  fontFamily:       string;
  FGsecondary:      string;
  onPress:          () => void;
  onLongPress?:     () => void;
  senderInfo?:      { displayName: string } | undefined;
  isPinned?:        boolean;
  isMuted?:         boolean;
  isFavourite?:     boolean;
}

const ChatRow = memo(function ChatRow({
  item, displayName, isGroup, contactPhotoUri, firebasePhotoURL,
  isSavedContact, hasStatus, userId, bevel, textColor, fontFamily,
  FGsecondary, onPress, onLongPress, senderInfo, isPinned, isMuted, isFavourite,
}: ChatRowProps) {
  const isVoiceNote = item.lastMessage === '[Voice Note]';

  const senderPrefix = (() => {
    if (!item.lastSenderId) return '';
    if (item.lastSenderId === userId) return 'You: ';
    if (isGroup && senderInfo) return `${senderInfo.displayName.split(' ')[0]}: `;
    return '';
  })();

  return (
    <TouchableOpacity style={[styles.chatCard, bevel]} activeOpacity={0.75} onPress={onPress} onLongPress={onLongPress} delayLongPress={300}>
      <View style={styles.chatAvatarWrap}>
        <ChatAvatar
          displayName={displayName}
          contactPhotoUri={contactPhotoUri}
          firebasePhotoURL={firebasePhotoURL}
          isSavedContact={isSavedContact}
          hasStatus={hasStatus}
        />
      </View>
      <View style={styles.chatMeta}>
        <View style={styles.chatTopRow}>
          <Text style={[styles.chatName, { color: textColor, fontFamily }]} numberOfLines={1}>
            {displayName}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            {isFavourite && <Ionicons name="star" size={13} color="#f59e0b" />}
            {isMuted && <Ionicons name="notifications-off" size={13} color={FGsecondary} />}
            {isPinned && <Ionicons name="pin" size={13} color={COLORS.blue} />}
            <Text style={[styles.chatTime, { color: FGsecondary }]}>{formatTime(item.timestamp)}</Text>
          </View>
        </View>
        <View style={styles.chatBottomRow}>
          {isVoiceNote ? (
            <View style={styles.voiceNotePreview}>
              {senderPrefix ? <Text style={styles.chatPreview}>{senderPrefix}</Text> : null}
              <Ionicons name="mic" size={14} color={COLORS.sub} style={{ marginRight: 3 }} />
              <Text style={styles.chatPreview}>Voice Note</Text>
            </View>
          ) : (
            <Text style={styles.chatPreview} numberOfLines={2}>
              {senderPrefix}{item.lastMessage}
            </Text>
          )}
          {item.unreadCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.unreadCount}</Text>
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
});

// ─── Dial-pad keypad ──────────────────────────────────────────────────────────
const KEY_ROWS = [
  [{ d: '1', s: '' },    { d: '2', s: 'ABC' },  { d: '3', s: 'DEF'  }],
  [{ d: '4', s: 'GHI' }, { d: '5', s: 'JKL' },  { d: '6', s: 'MNO'  }],
  [{ d: '7', s: 'PQRS'}, { d: '8', s: 'TUV' },  { d: '9', s: 'WXYZ' }],
  [{ d: '*', s: '' },    { d: '0', s: '+' },     { d: '#' , s: ''    }],
];

function NewContactSheet({
  onBack, onDone, reloadContacts,
}: {
  onBack: () => void;
  onDone: () => void;
  reloadContacts: () => void;
}) {
  const [number, setNumber] = useState('');
  const [name,   setName]   = useState('');
  const [saving, setSaving] = useState(false);
  const { bevel } = useGlass();
  const press = (k: string) => setNumber((n) => n + k);
  const del   = () => setNumber((n) => n.slice(0, -1));

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedNumber = number.trim();
    if (!trimmedName || !trimmedNumber || saving) return;
    setSaving(true);
    try {
      const Contacts = await import('expo-contacts/legacy');
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Allow contacts access to save a new contact.');
        setSaving(false);
        return;
      }
      await Contacts.addContactAsync({
        [Contacts.Fields.FirstName]: trimmedName,
        [Contacts.Fields.PhoneNumbers]: [
          { label: 'mobile', number: trimmedNumber },
        ],
      } as any);

      // Refresh the contact list so the new contact appears, then return to list
      reloadContacts();
      onBack();
    } catch (err) {
      console.error('[NewContactSheet] Failed to save contact:', err);
      Alert.alert('Could not save', 'Failed to save the contact. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <View style={styles.sheetSubHeader}>
        <TouchableOpacity onPress={onBack} style={styles.iconPad}>
          <AppIcon name="chevron-back" size={22} color={COLORS.blue} />
        </TouchableOpacity>
        <AppText style={styles.sheetTitle}>New Contact</AppText>
      </View>

      <View style={[styles.glassInput, bevel]}>
        <AppIcon name="person-outline" size={18} color={COLORS.sub} />
        <TextInput style={styles.inputField} placeholder="Contact name"
          placeholderTextColor={COLORS.sub} value={name} onChangeText={setName} />
      </View>

      <View style={styles.numberRow}>
        <AppText style={styles.numberText} numberOfLines={1}>{number || ' '}</AppText>
        {number.length > 0 && (
          <TouchableOpacity onPress={del} style={styles.iconPad}>
            <AppIcon name="backspace-outline" size={22} color={COLORS.blue} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.keyGrid}>
        {KEY_ROWS.map((row, ri) => (
          <View key={ri} style={styles.keyRow}>
            {row.map((k) => (
              <TouchableOpacity key={k.d} style={[styles.keyBtn, bevel]} activeOpacity={0.65}
                onPress={() => press(k.d)}>
                <AppText style={styles.keyDigit}>{k.d}</AppText>
                {k.s ? <AppText style={styles.keySub}>{k.s}</AppText> : null}
              </TouchableOpacity>
            ))}
          </View>
        ))}
      </View>

      <View style={styles.rowActions}>
        <TouchableOpacity style={[styles.cancelBtn, bevel]} onPress={onBack} activeOpacity={0.8}>
          <AppText style={styles.cancelText}>Cancel</AppText>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.confirmBtn, (!number || !name || saving) && styles.dimmed]}
          activeOpacity={number && name && !saving ? 0.85 : 1}
          onPress={handleSave}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.confirmGrad}>
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <AppIcon name="person-add-outline" size={18} color="#fff" fixedColor />
                <AppText fixedColor style={styles.confirmText}>Save Contact</AppText>
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </View>
    </>
  );
}

// ─── New Group sheet ──────────────────────────────────────────────────────────
function NewGroupSheet({
  onBack,
  onDone,
  contacts,
  currentUserId,
  onNavigateToGroup,
}: {
  onBack: () => void;
  onDone: () => void;
  contacts: AppContact[];
  currentUserId: string;
  onNavigateToGroup: (chatId: string, groupName: string) => void;
}) {
  const [selected,    setSelected]    = useState<string[]>([]);
  const [groupName,   setGroupName]   = useState('');
  const [nameError,   setNameError]   = useState('');
  const [creating,    setCreating]    = useState(false);
  const [privacyMap,  setPrivacyMap]  = useState<Map<string, string>>(new Map());
  const [privacyLoading, setPrivacyLoading] = useState(true);
  const { bevel } = useGlass();
  const { FG } = useForeground();
  const { textColor } = useTypography();

  useEffect(() => {
    if (!contacts.length) { setPrivacyLoading(false); return; }
    let cancelled = false;
    (async () => {
      const fsDb = db as ReturnType<typeof firestore>;
      const map = new Map<string, string>();
      await Promise.all(
        contacts.map(async (c) => {
          try {
            const snap = await fsDb.collection('users').doc(c.userId).get();
            map.set(c.userId, snap.exists() ? (snap.data()!.privacyGroups ?? 'Everyone') : 'Everyone');
          } catch {
            map.set(c.userId, 'Everyone');
          }
        })
      );
      if (!cancelled) { setPrivacyMap(map); setPrivacyLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [contacts]);

  const canAdd = (userId: string): boolean => {
    const setting = privacyMap.get(userId) ?? 'Everyone';
    return setting !== 'Nobody';
  };

  const toggle = (userId: string) => {
    if (!canAdd(userId)) return;
    setSelected((prev) =>
      prev.includes(userId) ? prev.filter((x) => x !== userId) : [...prev, userId]
    );
  };

  const handleCreate = async () => {
    if (!groupName.trim()) { setNameError('Please enter a group name.'); return; }
    if (selected.length < 1) { setNameError('Select at least one contact.'); return; }

    setCreating(true);
    try {
      const { createGroupChat } = await import('../hooks/useChatActions');
      const { chatId, blockedByPrivacy } = await createGroupChat(currentUserId, selected, groupName.trim());
      if (blockedByPrivacy.length > 0) {
        Alert.alert(
          'Some members not added',
          `${blockedByPrivacy.length} contact(s) have set their privacy to not allow being added to groups and were excluded.`,
        );
      }
      onDone();
      onNavigateToGroup(chatId, groupName.trim());
    } catch (err) {
      setNameError('Failed to create group. Please try again.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <View style={styles.sheetSubHeader}>
        <TouchableOpacity onPress={onBack} style={styles.iconPad} disabled={creating}>
          <AppIcon name="chevron-back" size={22} color={COLORS.blue} />
        </TouchableOpacity>
        <AppText style={styles.sheetTitle}>New Group</AppText>
        {selected.length > 0 && groupName.trim() && (
          <TouchableOpacity onPress={handleCreate} activeOpacity={0.85} disabled={creating}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.nextBtnGrad}>
              {creating ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <AppText style={styles.nextBtnText}>Create</AppText>
                  <AppIcon name="arrow-forward" size={15} color="#fff" fixedColor />
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        )}
      </View>

      <View style={[styles.glassInput, bevel]}>
        <AppIcon name="people-outline" size={18} color={COLORS.sub} />
        <TextInput style={styles.inputField} placeholder="Group name"
          placeholderTextColor={COLORS.sub} value={groupName}
          onChangeText={(t) => { setGroupName(t); setNameError(''); }} />
      </View>
      {nameError ? <AppText style={styles.nameError}>{nameError}</AppText> : null}

      {selected.length > 0 && (
        <View style={styles.selectedAvatarsRow}>
          {selected.map((userId) => {
            const c = contacts.find((x) => x.userId === userId);
            if (!c) return null;
            return (
              <TouchableOpacity key={userId} style={styles.selectedAvatarWrap} onPress={() => toggle(userId)}>
                <ChatAvatar
                  displayName={c.displayName}
                  contactPhotoUri={c.photoUri}
                  firebasePhotoURL={c.firebasePhotoURL}
                  isSavedContact={c.isSaved}
                />
                <View style={styles.removeBadge}>
                  <AppIcon name="close" size={10} color="#fff" fixedColor />
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      <Text style={styles.sectionHint}>{selected.length} selected — tap to add or remove</Text>

      <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
        {contacts.map((c) => {
          const sel = selected.includes(c.userId);
          const addable = canAdd(c.userId);
          return (
            <TouchableOpacity key={c.userId}
              style={[
                styles.contactRow, bevel,
                sel && styles.contactRowSelected,
                !addable && styles.contactRowDisabled,
              ]}
              activeOpacity={addable ? 0.75 : 1}
              onPress={() => toggle(c.userId)}>
              <ChatAvatar
                displayName={c.displayName}
                contactPhotoUri={c.photoUri}
                firebasePhotoURL={c.firebasePhotoURL}
                isSavedContact={c.isSaved}
              />
              <View style={styles.contactMeta}>
                <AppText style={[styles.contactName, { color: textColor, opacity: addable ? 1 : 0.45 }]}>
                  {c.displayName}
                </AppText>
                <AppText style={[styles.contactSub, { color: FG.secondary }]} numberOfLines={1}>
                  {addable ? formatSAPhone(c.phone) : "Can't be added to groups"}
                </AppText>
              </View>
              {sel ? (
                <View style={styles.selectedIndicator}>
                  <AppIcon name="checkmark-circle" size={22} color={COLORS.blue} fixedColor />
                </View>
              ) : !addable ? (
                <AppIcon name="lock-closed-outline" size={18} color={COLORS.sub} />
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </>
  );
}

// ─── Select-contact sheet (FAB flow) ──────────────────────────────────────────
function SelectContactSheet({
  onClose,
  onNavigate,
  contacts,
  contactsLoading,
  contactsError,
  reloadContacts,
  hasPermission,
  currentUserId,
  onNavigateToGroup,
}: {
  onClose: () => void;
  onNavigate: (contact: AppContact) => void;
  contacts: AppContact[];
  contactsLoading: boolean;
  contactsError: string | null;
  reloadContacts: () => void;
  hasPermission: boolean;
  currentUserId: string;
  onNavigateToGroup: (chatId: string, groupName: string) => void;
}) {
  const [mode, setMode] = useState<SheetMode>('select');
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { FG } = useForeground();
  const { textColor } = useTypography();
  const { bevel } = useGlass();

  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchRef = useRef<TextInput>(null);

  const openSearch = () => {
    setSearchOpen(true);
    setMenuOpen(false);
    Animated.spring(searchAnim, { toValue: 1, useNativeDriver: false, friction: 7, tension: 60 })
      .start(() => searchRef.current?.focus());
  };

  const closeSearch = () => {
    setSearchQuery('');
    Animated.spring(searchAnim, { toValue: 0, useNativeDriver: false, friction: 7, tension: 60 })
      .start(() => setSearchOpen(false));
  };

  const refreshContacts = () => {
    setMenuOpen(false);
    closeSearch();
    reloadContacts();
  };

  const filtered = searchQuery.trim()
    ? contacts.filter((c) => c.displayName.toLowerCase().includes(searchQuery.toLowerCase()))
    : contacts;

  if (mode === 'newContact') {
    return <NewContactSheet onBack={() => setMode('select')} onDone={onClose} reloadContacts={reloadContacts} />;
  }
  if (mode === 'newGroup') {
    return <NewGroupSheet
      onBack={() => setMode('select')}
      onDone={onClose}
      contacts={contacts}
      currentUserId={currentUserId}
      onNavigateToGroup={onNavigateToGroup}
    />;
  }

  return (
    <>
      <View style={styles.sheetSubHeader}>
        <TouchableOpacity onPress={onClose} style={styles.iconPad}>
          <AppIcon name="close" size={22} color={COLORS.sub} />
        </TouchableOpacity>

        {searchOpen ? (
          <Animated.View
            style={[
              styles.sheetSearchBubble,
              { backgroundColor: FG.glassBg, borderColor: FG.glassBorder },
              {
                opacity: searchAnim,
                transform: [{
                  translateY: searchAnim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }),
                }],
              },
            ]}
          >
            <AppIcon name="search-outline" size={15} color={COLORS.sub} />
            <TextInput
              ref={searchRef}
              style={[styles.sheetSearchInput, { color: textColor }]}
              placeholder="Search contacts…"
              placeholderTextColor={COLORS.sub}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
            <TouchableOpacity onPress={closeSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="close-circle" size={17} color={COLORS.sub} />
            </TouchableOpacity>
          </Animated.View>
        ) : (
          <View style={{ flex: 1 }}>
            <AppText style={[styles.sheetTitle, { color: textColor }]}>Select contact</AppText>
            <AppText style={[styles.sheetSub, { color: FG.secondary }]}>{contacts.length} contacts</AppText>
          </View>
        )}

        <View style={{ flexDirection: 'row', gap: 14 }}>
          {!searchOpen && (
            <TouchableOpacity onPress={openSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="search-outline" size={22} color={COLORS.sub} />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => setMenuOpen((v) => !v)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <AppIcon name="ellipsis-vertical" size={22} color={COLORS.sub} />
          </TouchableOpacity>
        </View>
      </View>

      {menuOpen && (
        <View style={[styles.sheetDropdown, { backgroundColor: FG.glassBg, borderColor: FG.glassBorder }]}>
          <TouchableOpacity
            style={styles.sheetDropdownItem}
            onPress={refreshContacts}
            activeOpacity={0.75}
          >
            <AppIcon name="refresh-outline" size={18} color={COLORS.blue} fixedColor />
            <AppText style={[styles.sheetDropdownTxt, { color: textColor }]}>Refresh contacts</AppText>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.actionBlock}>
        {[
          { icon: 'people'     as const, label: 'New group',   onPress: () => { setMenuOpen(false); setMode('newGroup');   } },
          { icon: 'person-add' as const, label: 'New contact', onPress: () => { setMenuOpen(false); setMode('newContact'); } },
        ].map((a) => (
          <TouchableOpacity key={a.label} style={[styles.actionRow, bevel]} activeOpacity={0.75} onPress={a.onPress}>
            <View style={styles.actionIconWrap}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.actionIcon}>
                <AppIcon name={a.icon} size={20} color="#fff" fixedColor />
              </LinearGradient>
            </View>
            <AppText style={styles.actionLabel}>{a.label}</AppText>
            <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />
          </TouchableOpacity>
        ))}
      </View>

      <AppText style={styles.sectionHint}>
        {searchQuery.trim() ? `${filtered.length} result${filtered.length !== 1 ? 's' : ''}` : 'Contacts'}
      </AppText>

      {contactsLoading ? (
        <View style={styles.emptyWrap}>
          <ActivityIndicator size="large" color={COLORS.blue} />
          <AppText style={[styles.emptyText, { color: FG.secondary }]}>Loading contacts…</AppText>
        </View>
      ) : contactsError ? (
        <View style={styles.emptyWrap}>
          <AppIcon name="people-outline" size={52} color={COLORS.sub} />
          <AppText style={[styles.emptyText, { color: FG.secondary }]}>{contactsError}</AppText>
          <TouchableOpacity style={styles.retryBtn} onPress={reloadContacts} activeOpacity={0.8}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.retryBtnGrad}>
              <AppIcon name="refresh" size={16} color="#fff" fixedColor />
              <AppText style={styles.retryBtnText} fixedColor>{hasPermission ? 'Retry' : 'Grant Permission'}</AppText>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.emptyWrap}>
          <AppIcon name="people-outline" size={52} color={COLORS.sub} />
          <AppText style={[styles.emptyText, { color: FG.secondary }]}>
            {searchQuery.trim() ? `No contacts match "${searchQuery}"` : 'No registered contacts found'}
          </AppText>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} style={{ flex: 1 }}>
          {filtered.map((c) => (
            <TouchableOpacity key={c.userId} style={[styles.contactRow, bevel]} activeOpacity={0.75}
              onPress={() => { setMenuOpen(false); onNavigate(c); }}>
              <ChatAvatar
                displayName={c.displayName}
                contactPhotoUri={c.photoUri}
                firebasePhotoURL={c.firebasePhotoURL}
                isSavedContact={c.isSaved}
              />
              <View style={styles.contactMeta}>
                <AppText style={[styles.contactName, { color: textColor }]}>{c.displayName}</AppText>
                <AppText style={[styles.contactSub, { color: FG.secondary }]} numberOfLines={1}>{formatSAPhone(c.phone)}</AppText>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </>
  );
}

// ─── Chat Label Manager Sheet ─────────────────────────────────────────────────
function ChatLabelManagerSheet({
  visible,
  onClose,
  currentUserId,
  contacts,
  groups,
  labels,
  initialEditingLabelId,
  onCreateLabel,
  onUpdateLabel,
  onDeleteLabel,
  onLabelCreated,
}: {
  visible: boolean;
  onClose: () => void;
  currentUserId: string;
  contacts: AppContact[];
  groups: GroupOption[];
  labels: ChatLabel[];
  initialEditingLabelId?: string | null;
  onCreateLabel: (title: string, memberIds: string[], groupIds: string[]) => Promise<string | null>;
  onUpdateLabel: (labelId: string, title: string, memberIds: string[], groupIds: string[]) => Promise<void>;
  onDeleteLabel: (labelId: string) => Promise<void>;
  onLabelCreated?: (labelId: string) => void;
}) {
  const { FG } = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { bevel } = useGlass();

  const [view, setView] = useState<'list' | 'editor'>('list');
  const [saving, setSaving] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [editorTab, setEditorTab] = useState<'users' | 'groups'>('users');
  const [editorError, setEditorError] = useState('');
  const [userSearch, setUserSearch] = useState('');

  const filteredContacts = useMemo(() => {
    if (!userSearch.trim()) return contacts;
    const q = userSearch.toLowerCase();
    return contacts.filter((c) =>
      c.displayName.toLowerCase().includes(q) || c.phone.includes(q),
    );
  }, [contacts, userSearch]);

  const resetEditor = useCallback(() => {
    setEditingId(null);
    setTitle('');
    setSelectedUsers([]);
    setSelectedGroups([]);
    setEditorTab('users');
    setEditorError('');
    setUserSearch('');
  }, []);

  const openEditorForNew = useCallback(() => {
    resetEditor();
    setView('editor');
  }, [resetEditor]);

  const openEditorForExisting = useCallback((label: ChatLabel) => {
    setEditingId(label.id);
    setTitle(label.title);
    setSelectedUsers([...label.memberIds]);
    setSelectedGroups([...label.groupIds]);
    setEditorTab('users');
    setEditorError('');
    setUserSearch('');
    setView('editor');
  }, []);

  useEffect(() => {
    if (!visible) return;
    if (initialEditingLabelId) {
      const label = labels.find((l) => l.id === initialEditingLabelId);
      if (label) {
        openEditorForExisting(label);
        return;
      }
    }
    resetEditor();
    setView('list');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialEditingLabelId]);

  const toggleUser = useCallback((uid: string) => {
    setSelectedUsers((prev) =>
      prev.includes(uid) ? prev.filter((x) => x !== uid) : [...prev, uid],
    );
  }, []);

  const toggleGroup = useCallback((chatId: string) => {
    setSelectedGroups((prev) =>
      prev.includes(chatId) ? prev.filter((x) => x !== chatId) : [...prev, chatId],
    );
  }, []);

  const removeUser = useCallback((uid: string) => {
    setSelectedUsers((prev) => prev.filter((x) => x !== uid));
  }, []);
  const removeGroup = useCallback((chatId: string) => {
    setSelectedGroups((prev) => prev.filter((x) => x !== chatId));
  }, []);

  const handleSave = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setEditorError('Please enter a title for this label.');
      return;
    }
    if (selectedUsers.length === 0 && selectedGroups.length === 0) {
      setEditorError('Add at least one contact or group.');
      return;
    }
    if (!currentUserId) {
      setEditorError('Not signed in.');
      return;
    }

    setSaving(true);
    setEditorError('');
    try {
      if (editingId) {
        await onUpdateLabel(editingId, trimmed, selectedUsers, selectedGroups);
      } else {
        const newId = await onCreateLabel(trimmed, selectedUsers, selectedGroups);
        if (newId && onLabelCreated) onLabelCreated(newId);
      }
      resetEditor();
      setView('list');
    } catch (err: any) {
      console.error('[ChatLabelManager] save failed:', err?.code, err?.message, err);
      setEditorError(describeSaveError(err));
    } finally {
      setSaving(false);
    }
  }, [title, selectedUsers, selectedGroups, currentUserId, editingId, resetEditor, onCreateLabel, onUpdateLabel, onLabelCreated]);

  const handleDelete = useCallback((label: ChatLabel) => {
    Alert.alert(
      'Delete chat label?',
      `"${label.title}" will be removed. This does not delete any chats.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await onDeleteLabel(label.id);
              resetEditor();
              setView('list');
            } catch (err: any) {
              console.error('[ChatLabelManager] delete failed:', err?.code, err?.message, err);
              Alert.alert('Error', describeSaveError(err));
            }
          },
        },
      ],
    );
  }, [onDeleteLabel, resetEditor]);

  const handleDeleteCurrent = useCallback(() => {
    if (!editingId) return;
    const label = labels.find((l) => l.id === editingId);
    if (!label) return;
    handleDelete(label);
  }, [editingId, labels, handleDelete]);

  const totalSelected = selectedUsers.length + selectedGroups.length;

  if (view === 'list') {
    return (
      <>
        <View style={styles.sheetSubHeader}>
          <TouchableOpacity onPress={onClose} style={styles.iconPad}>
            <AppIcon name="close" size={22} color={COLORS.sub} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <AppText style={[styles.sheetTitle, { color: textColor, fontFamily }]}>
              Chat Labels
            </AppText>
            <AppText style={[styles.sheetSub, { color: FG.secondary }]}>
              {labels.length} label{labels.length !== 1 ? 's' : ''}
            </AppText>
          </View>
          <TouchableOpacity onPress={openEditorForNew} activeOpacity={0.85}>
            <LinearGradient colors={GRADIENTS.primary} style={styles.nextBtnGrad}>
              <AppIcon name="add" size={16} color="#fff" fixedColor />
              <AppText style={styles.nextBtnText}>New</AppText>
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {labels.length === 0 ? (
          <View style={styles.emptyWrap}>
            <AppIcon name="pricetags-outline" size={52} color={COLORS.sub} />
            <AppText style={[styles.emptyText, { color: FG.secondary }]}>
              No chat labels yet
            </AppText>
            <AppText style={[styles.emptySubText, { color: FG.secondary }]}>
              Create a label to group chats you care about into their own tab.
            </AppText>
          </View>
        ) : (
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 24 }}
          >
            {labels.map((label) => {
              const count = label.memberIds.length + label.groupIds.length;
              return (
                <View key={label.id} style={[styles.broadcastCard, bevel]}>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.broadcastIcon}>
                    <AppIcon name="pricetag" size={20} color="#fff" fixedColor />
                  </LinearGradient>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <AppText
                      style={[styles.contactName, { color: textColor, fontFamily }]}
                      numberOfLines={1}
                    >
                      {label.title}
                    </AppText>
                    <AppText style={[styles.contactSub, { color: FG.secondary }]}>
                      {count} item{count !== 1 ? 's' : ''}
                      {label.groupIds.length > 0
                        ? `  ·  ${label.groupIds.length} group${label.groupIds.length !== 1 ? 's' : ''}`
                        : ''}
                      {label.memberIds.length > 0
                        ? `  ·  ${label.memberIds.length} contact${label.memberIds.length !== 1 ? 's' : ''}`
                        : ''}
                    </AppText>
                  </View>
                  <TouchableOpacity
                    style={styles.broadcastAction}
                    onPress={() => openEditorForExisting(label)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <AppIcon name="create-outline" size={19} color={COLORS.blue} fixedColor />
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={styles.broadcastAction}
                    onPress={() => handleDelete(label)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <AppIcon name="trash-outline" size={19} color={COLORS.missed} fixedColor />
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>
        )}
      </>
    );
  }

  return (
    <>
      <View style={styles.sheetSubHeader}>
        <TouchableOpacity
          onPress={() => { resetEditor(); setView('list'); }}
          style={styles.iconPad}
          disabled={saving}
        >
          <AppIcon name="chevron-back" size={22} color={COLORS.blue} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <AppText style={[styles.sheetTitle, { color: textColor, fontFamily }]}>
            {editingId ? 'Manage Label' : 'New Label'}
          </AppText>
          <AppText style={[styles.sheetSub, { color: FG.secondary }]}>
            {totalSelected} item{totalSelected !== 1 ? 's' : ''} selected
          </AppText>
        </View>
        <TouchableOpacity onPress={handleSave} activeOpacity={0.85} disabled={saving}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.nextBtnGrad}>
            {saving ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <AppText style={styles.nextBtnText}>{editingId ? 'Save' : 'Create'}</AppText>
                <AppIcon name="checkmark" size={15} color="#fff" fixedColor />
              </>
            )}
          </LinearGradient>
        </TouchableOpacity>
      </View>

      <View style={[styles.glassInput, bevel]}>
        <AppIcon name="text-outline" size={18} color={COLORS.sub} />
        <TextInput
          style={[styles.inputField, { color: textColor, fontFamily }]}
          placeholder="Label title (e.g. Family, Work, VIP)"
          placeholderTextColor={COLORS.sub}
          value={title}
          onChangeText={(t) => { setTitle(t); setEditorError(''); }}
          maxLength={40}
        />
      </View>
      {editorError ? <AppText style={styles.nameError}>{editorError}</AppText> : null}

      {totalSelected > 0 && (
        <View style={styles.selectedChipsWrap}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.selectedChipsRow}
          >
            {selectedUsers.map((uid) => {
              const c = contacts.find((x) => x.userId === uid);
              if (!c) return null;
              return (
                <View key={`u-${uid}`} style={[styles.selectedChip, bevel]}>
                  <View style={[styles.selectedChipDot, { backgroundColor: stringToColor(c.displayName) }]}>
                    <AppText style={styles.selectedChipInitial}>{getInitials(c.displayName)}</AppText>
                  </View>
                  <AppText
                    style={[styles.selectedChipLabel, { color: textColor, fontFamily }]}
                    numberOfLines={1}
                  >
                    {c.displayName}
                  </AppText>
                  <TouchableOpacity
                    onPress={() => removeUser(uid)}
                    hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                  >
                    <AppIcon name="close-circle" size={16} color={COLORS.missed} fixedColor />
                  </TouchableOpacity>
                </View>
              );
            })}

            {selectedGroups.map((chatId) => {
              const g = groups.find((x) => x.chatId === chatId);
              if (!g) return null;
              return (
                <View key={`g-${chatId}`} style={[styles.selectedChip, bevel]}>
                  <View style={[styles.selectedChipDot, { backgroundColor: stringToColor(g.name) }]}>
                    <AppIcon name="people" size={12} color="#fff" fixedColor />
                  </View>
                  <AppText
                    style={[styles.selectedChipLabel, { color: textColor, fontFamily }]}
                    numberOfLines={1}
                  >
                    {g.name}
                  </AppText>
                  <TouchableOpacity
                    onPress={() => removeGroup(chatId)}
                    hitSlop={{ top: 8, bottom: 8, left: 4, right: 8 }}
                  >
                    <AppIcon name="close-circle" size={16} color={COLORS.missed} fixedColor />
                  </TouchableOpacity>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      <View style={styles.editorTabs}>
        {(['users', 'groups'] as const).map((t) => {
          const active = editorTab === t;
          return active ? (
            <TouchableOpacity key={t} onPress={() => setEditorTab(t)} activeOpacity={0.85}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.editorTabActive}>
                <AppText style={styles.editorTabActiveText}>
                  {t === 'users' ? 'Contacts' : 'Groups'}
                </AppText>
              </LinearGradient>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              key={t}
              style={[styles.editorTabInactive, bevel]}
              onPress={() => setEditorTab(t)}
              activeOpacity={0.75}
            >
              <AppText style={[styles.editorTabText, { color: FG.secondary }]}>
                {t === 'users' ? 'Contacts' : 'Groups'}
              </AppText>
            </TouchableOpacity>
          );
        })}
      </View>

      {editorTab === 'users' && (
        <View style={[styles.glassInput, bevel, { marginTop: 2 }]}>
          <AppIcon name="search-outline" size={16} color={COLORS.sub} />
          <TextInput
            style={[styles.inputField, { color: textColor }]}
            placeholder="Search contacts…"
            placeholderTextColor={COLORS.sub}
            value={userSearch}
            onChangeText={setUserSearch}
          />
          {userSearch.length > 0 && (
            <TouchableOpacity onPress={() => setUserSearch('')}>
              <AppIcon name="close-circle" size={16} color={COLORS.sub} />
            </TouchableOpacity>
          )}
        </View>
      )}

      <ScrollView
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 20 }}
        keyboardShouldPersistTaps="handled"
      >
        {editorTab === 'users' ? (
          filteredContacts.length === 0 ? (
            <View style={styles.emptyWrap}>
              <AppIcon name="people-outline" size={44} color={COLORS.sub} />
              <AppText style={[styles.emptyText, { color: FG.secondary }]}>
                {userSearch.trim() ? `No contacts match "${userSearch}"` : 'No contacts available'}
              </AppText>
            </View>
          ) : (
            filteredContacts.map((c) => {
              const sel = selectedUsers.includes(c.userId);
              return (
                <TouchableOpacity
                  key={c.userId}
                  style={[styles.contactRow, bevel, sel && styles.contactRowSelected]}
                  activeOpacity={0.75}
                  onPress={() => toggleUser(c.userId)}
                >
                  <ChatAvatar
                    displayName={c.displayName}
                    contactPhotoUri={c.photoUri}
                    firebasePhotoURL={c.firebasePhotoURL}
                    isSavedContact={c.isSaved}
                  />
                  <View style={styles.contactMeta}>
                    <AppText style={[styles.contactName, { color: textColor, fontFamily }]}>
                      {c.displayName}
                    </AppText>
                    <AppText style={[styles.contactSub, { color: FG.secondary }]} numberOfLines={1}>
                      {formatSAPhone(c.phone)}
                    </AppText>
                  </View>
                  {sel ? (
                    <AppIcon name="checkmark-circle" size={22} color={COLORS.blue} fixedColor />
                  ) : (
                    <View style={styles.checkbox} />
                  )}
                </TouchableOpacity>
              );
            })
          )
        ) : groups.length === 0 ? (
          <View style={styles.emptyWrap}>
            <AppIcon name="people-outline" size={44} color={COLORS.sub} />
            <AppText style={[styles.emptyText, { color: FG.secondary }]}>
              You are not in any groups yet
            </AppText>
          </View>
        ) : (
          groups.map((g) => {
            const sel = selectedGroups.includes(g.chatId);
            return (
              <TouchableOpacity
                key={g.chatId}
                style={[styles.contactRow, bevel, sel && styles.contactRowSelected]}
                activeOpacity={0.75}
                onPress={() => toggleGroup(g.chatId)}
              >
                <ChatAvatar
                  displayName={g.name}
                  firebasePhotoURL={g.photoURL ?? undefined}
                  isSavedContact={false}
                />
                <View style={styles.contactMeta}>
                  <AppText style={[styles.contactName, { color: textColor, fontFamily }]}>
                    {g.name}
                  </AppText>
                  <AppText style={[styles.contactSub, { color: FG.secondary }]}>
                    Group · {g.memberCount} member{g.memberCount !== 1 ? 's' : ''}
                  </AppText>
                </View>
                {sel ? (
                  <AppIcon name="checkmark-circle" size={22} color={COLORS.blue} fixedColor />
                ) : (
                  <View style={styles.checkbox} />
                )}
              </TouchableOpacity>
            );
          })
        )}

        {editingId && (
          <TouchableOpacity
            style={[styles.deleteLabelBtn, bevel]}
            onPress={handleDeleteCurrent}
            activeOpacity={0.8}
          >
            <AppIcon name="trash-outline" size={18} color={COLORS.missed} fixedColor />
            <AppText style={[styles.deleteLabelText, { color: COLORS.missed, fontFamily }]}>
              Delete this label
            </AppText>
          </TouchableOpacity>
        )}
      </ScrollView>
    </>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function ChatsScreen() {
  const navigation  = useNavigation<NavProp>();
  const { userId }  = useAuth();

  const { FG }                    = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel, iconButton }     = useGlass();
  const insets = useSafeAreaInsets();

  const { chats, loading: chatsLoading } = useChats(userId);
  const { contacts, loading: contactsLoading, reload: reloadContacts, hasPermission, error: contactsError } = useContacts();
  const { pinned, favourites, mutedChats, togglePin, toggleFavourite, toggleMute, loadMutedFor } = useChatPrefs(userId);

  // Chat currently targeted by the swipe-right actions menu
  const [actionChat, setActionChat] = useState<{
    chatId: string;
    displayName: string;
    isGroup: boolean;
    otherUserId?: string;
    otherUserPhone?: string;
    otherUserPhoto?: string | null;
    isSavedContact: boolean;
  } | null>(null);

  // Chat being peeked via long-press (read-only message preview)
  const [previewChat, setPreviewChat] = useState<{
    chatId: string;
    displayName: string;
    isGroup: boolean;
    otherUserId?: string;
    otherUserPhoto?: string | null;
  } | null>(null);
  const { contactStatuses } = useStatus(userId);

  const userStatusMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const statusGroup of contactStatuses) {
      map.set(statusGroup.userId, true);
    }
    return map;
  }, [contactStatuses]);

  const [tab,        setTab]        = useState<TabType>('Chats');
  const [query,      setQuery]      = useState('');
  const [sheetOpen,  setSheetOpen]  = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [labelManagerOpen, setLabelManagerOpen] = useState(false);
  const [managingLabelId,  setManagingLabelId]  = useState<string | null>(null);

  // Refresh device contacts each time the picker sheet opens
  useEffect(() => {
    if (sheetOpen) reloadContacts();
  }, [sheetOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh contacts whenever the screen regains focus, so a contact edited or
  // deleted inside a chat is reflected in the chat list name immediately.
  useFocusEffect(
    useCallback(() => {
      reloadContacts();
    }, [reloadContacts])
  );

  // Keep the muted-chat badges in sync with the current chat list
  useEffect(() => {
    if (chats.length > 0) loadMutedFor(chats.map((c) => c.chatId));
  }, [chats, loadMutedFor]);

  const [labels, setLabels] = useState<ChatLabel[]>([]);
  const pendingLabelIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!userId) { setLabels([]); return; }
    const fsDb = db as ReturnType<typeof firestore>;
    const unsub = fsDb
      .collection('users')
      .doc(userId)
      .collection('chatLabels')
      .onSnapshot(
        (snap) => {
          const items: ChatLabel[] = snap.docs.map((d) => {
            const data = d.data() || {};
            return {
              id:        d.id,
              title:     data.title ?? '',
              memberIds: Array.isArray(data.memberIds) ? data.memberIds : [],
              groupIds:  Array.isArray(data.groupIds)  ? data.groupIds  : [],
              createdAt: data.createdAt ?? 0,
              updatedAt: data.updatedAt ?? 0,
            };
          });
          items.sort((a, b) => a.createdAt - b.createdAt);
          setLabels(items);
        },
        (err) => {
          console.error('[ChatsScreen] chatLabels snapshot error:', err?.message, err?.message, err);
        },
      );
    return () => unsub();
  }, [userId]);

  const createLabel = useCallback(async (
    title: string, memberIds: string[], groupIds: string[],
  ): Promise<string | null> => {
    if (!userId) throw new Error('Not signed in');
    const fsDb = db as ReturnType<typeof firestore>;
    const now = Date.now();

    const docRef = fsDb
      .collection('users')
      .doc(userId)
      .collection('chatLabels')
      .doc();

    await docRef.set({
      title,
      memberIds,
      groupIds,
      createdAt: now,
      updatedAt: now,
    });

    setLabels((prev) => {
      if (prev.some((l) => l.id === docRef.id)) return prev;
      const next = [
        ...prev,
        { id: docRef.id, title, memberIds, groupIds, createdAt: now, updatedAt: now },
      ];
      next.sort((a, b) => a.createdAt - b.createdAt);
      return next;
    });

    return docRef.id;
  }, [userId]);

  const updateLabel = useCallback(async (
    labelId: string, title: string, memberIds: string[], groupIds: string[],
  ): Promise<void> => {
    if (!userId) throw new Error('Not signed in');
    const fsDb = db as ReturnType<typeof firestore>;
    const now = Date.now();
    await fsDb
      .collection('users')
      .doc(userId)
      .collection('chatLabels')
      .doc(labelId)
      .update({ title, memberIds, groupIds, updatedAt: now });

    setLabels((prev) =>
      prev.map((l) =>
        l.id === labelId ? { ...l, title, memberIds, groupIds, updatedAt: now } : l,
      ),
    );
  }, [userId]);

  const deleteLabel = useCallback(async (labelId: string): Promise<void> => {
    if (!userId) throw new Error('Not signed in');
    const fsDb = db as ReturnType<typeof firestore>;
    await fsDb
      .collection('users')
      .doc(userId)
      .collection('chatLabels')
      .doc(labelId)
      .delete();

    setLabels((prev) => prev.filter((l) => l.id !== labelId));
  }, [userId]);

  useEffect(() => {
    if (tab === 'Chats' || tab === 'Groups' || tab === 'Broadcast') return;
    const exists = labels.some((l) => l.id === tab);
    if (exists) {
      if (pendingLabelIdRef.current === tab) pendingLabelIdRef.current = null;
      return;
    }
    if (pendingLabelIdRef.current === tab) return;
    setTab('Chats');
  }, [labels, tab]);

  const [memberInfo, setMemberInfo] = useState<Map<string, { displayName: string; phone: string; photoURL?: string }>>(new Map());
  const [privacyPhotoMap, setPrivacyPhotoMap] = useState<Map<string, string>>(new Map());

  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchRef  = useRef<TextInput>(null);

  const contactsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts) {
      map.set(c.phone, c.displayName);
    }
    return map;
  }, [contacts]);

  const firestoreUsersMap = useMemo(() => {
    const map = new Map<string, { displayName: string; phone: string; photoURL?: string; contactPhotoUri?: string }>();
    for (const c of contacts) {
      map.set(c.userId, {
        displayName: c.displayName,
        phone: c.phone,
        photoURL: c.firebasePhotoURL,
        contactPhotoUri: c.photoUri,
      });
    }
    for (const [uid, info] of memberInfo) {
      if (!map.has(uid)) {
        map.set(uid, info);
      }
    }
    return map;
  }, [contacts, memberInfo]);

  useEffect(() => {
    if (!chats.length || !userId) return;

    const knownIds = new Set(contacts.map((c) => c.userId));
    const unknownIds = new Set<string>();

    for (const chat of chats) {
      for (const memberId of chat.members) {
        if (memberId !== userId && !knownIds.has(memberId) && !memberInfo.has(memberId)) {
          unknownIds.add(memberId);
        }
      }
    }

    if (unknownIds.size === 0) return;

    (async () => {
      const fsDb = db as ReturnType<typeof firestore>;
      const newInfo = new Map(memberInfo);
      const newPrivacy = new Map(privacyPhotoMap);

      for (const uid of unknownIds) {
        try {
          const snap = await fsDb.collection('users').doc(uid).get();
          if (snap.exists()) {
            const data = snap.data()!;
            newInfo.set(uid, {
              displayName: data.displayName ?? data.phone ?? uid,
              phone: data.phone ?? '',
              photoURL: data.photoURL || null,
            });
            newPrivacy.set(uid, data.privacyProfilePhoto ?? 'Contacts');
          }
        } catch (_) {}
      }

      setMemberInfo(newInfo);
      setPrivacyPhotoMap(newPrivacy);
    })();
  }, [chats, userId, contacts]);

  useEffect(() => {
    if (!contacts.length) return;
    const alreadyCached = new Set(privacyPhotoMap.keys());
    const needed = contacts.filter((c) => c.userId && !alreadyCached.has(c.userId));
    if (!needed.length) return;

    (async () => {
      const updates = new Map<string, string>();
      await Promise.all(
        needed.map(async (c) => {
          try {
            const privacy = await fetchUserPrivacySettings(c.userId);
            updates.set(c.userId, privacy.profilePhoto);
          } catch {}
        })
      );
      if (updates.size > 0) {
        setPrivacyPhotoMap((prev) => new Map([...prev, ...updates]));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts]);

  const groupChats = useMemo(
    () => chats.filter((c) => classifyChat(c) === 'group'),
    [chats],
  );

  const groupOptions: GroupOption[] = useMemo(() => {
    if (!userId) return [];
    return groupChats.map((g) => ({
      chatId: g.chatId,
      name:   resolveDisplayName(g, userId, contactsMap, firestoreUsersMap),
      photoURL: null,
      memberCount: g.members.length,
    }));
  }, [groupChats, userId, contactsMap, firestoreUsersMap]);

  const currentLabel = useMemo(
    () => (tab === 'Chats' || tab === 'Groups' || tab === 'Broadcast')
      ? null
      : (labels.find((l) => l.id === tab) ?? null),
    [labels, tab],
  );

  // ── Data for the current tab ────────────────────────────────────────────
  // Chats  → every chat (direct + group)
  // Groups → only groups
  // Label  → chats belonging to that label + placeholders for members with no chat yet
  const data = useMemo(() => {
    let base: ChatPreview[];

    if (tab === 'Chats') {
      // Show EVERYTHING — direct chats AND groups.
      base = chats;
    } else if (tab === 'Groups') {
      base = groupChats;
    } else if (tab === 'Broadcast') {
      base = [];
    } else {
      const label = labels.find((l) => l.id === tab);
      if (!label) return [];

      const existing = chats.filter((c) => {
        const kind = classifyChat(c);
        if (kind === 'group') return label.groupIds.includes(c.chatId);
        const otherMember = c.members.find((m) => m !== userId);
        return !!otherMember && label.memberIds.includes(otherMember);
      });

      const membersWithChat = new Set<string>();
      existing.forEach((c) => {
        if (classifyChat(c) === 'direct') {
          const other = c.members.find((m) => m !== userId);
          if (other) membersWithChat.add(other);
        }
      });

      const orphans = userId
        ? label.memberIds.filter((m) => m !== userId && !membersWithChat.has(m))
        : [];
      const synthetic = orphans.map((m) => makeSyntheticChat(userId!, m));

      base = [...existing, ...synthetic];
    }

    // Sort pinned chats first (in pin order), then by most-recently-active.
    const pinIndex = (id: string) => {
      const i = pinned.indexOf(id);
      return i === -1 ? Infinity : i;
    };
    const byRecent = (a: ChatPreview, b: ChatPreview) => {
      const pa = pinIndex(a.chatId);
      const pb = pinIndex(b.chatId);
      if (pa !== pb) return pa - pb; // pinned first, in pin order
      const ta = a.timestamp?.getTime() ?? 0;
      const tb = b.timestamp?.getTime() ?? 0;
      return tb - ta;
    };

    if (!query.trim()) return [...base].sort(byRecent);
    const q = query.toLowerCase();
    return base
      .filter((c) => {
        if (!userId) return false;
        return resolveDisplayName(c, userId, contactsMap, firestoreUsersMap).toLowerCase().includes(q);
      })
      .sort(byRecent);
  }, [tab, groupChats, labels, chats, query, userId, contactsMap, firestoreUsersMap, pinned]);

  const openSearch = () => {
    setSearchOpen(true);
    Animated.spring(searchAnim, {
      toValue: 1, useNativeDriver: false,
      friction: 7, tension: 60,
    }).start(() => searchRef.current?.focus());
  };

  const closeSearch = () => {
    setQuery('');
    Animated.spring(searchAnim, {
      toValue: 0, useNativeDriver: false,
      friction: 7, tension: 60,
    }).start(() => setSearchOpen(false));
  };

  const handleSelectContact = useCallback(async (contact: AppContact) => {
    if (!userId) return;
    setSheetOpen(false);
    try {
      const chatId = await getOrCreateDirectChat(userId, contact.userId);
      navigation.navigate('Chat', {
        chatId,
        displayName: contact.displayName,
        isGroup: false,
        otherUserId: contact.userId,
        otherUserPhoto: contact.photoUri || contact.firebasePhotoURL || null,
      });
    } catch {}
  }, [userId, navigation]);

  const handleNavigateToGroup = useCallback((chatId: string, groupName: string) => {
    if (!userId) return;
    navigation.navigate('Chat', { chatId, displayName: groupName, isGroup: true });
  }, [userId, navigation]);

  const openOrCreateDirectChat = useCallback(async (
    otherUserId: string,
    displayName: string,
    photoUrl: string | null,
  ) => {
    if (!userId) return;
    try {
      const chatId = await getOrCreateDirectChat(userId, otherUserId);
      navigation.navigate('Chat', {
        chatId,
        displayName,
        isGroup: false,
        otherUserId,
        otherUserPhoto: photoUrl,
      });
    } catch (err) {
      console.error('[ChatsScreen] failed to open/create chat:', err);
      Alert.alert('Error', 'Could not open chat. Please try again.');
    }
  }, [userId, navigation]);

  const openLabelManager = useCallback(() => {
    setManagingLabelId(null);
    setLabelManagerOpen(true);
  }, []);

  const openManageLabel = useCallback((labelId: string) => {
    setManagingLabelId(labelId);
    setLabelManagerOpen(true);
  }, []);

  const closeLabelManager = useCallback(() => {
    setLabelManagerOpen(false);
    setTimeout(() => setManagingLabelId(null), 200);
  }, []);

  // Swipe-left → pin/unpin (max 3)
  const handleTogglePin = useCallback(async (chatId: string) => {
    const res = await togglePin(chatId);
    if (!res.ok && res.reason) Alert.alert('Pin limit', res.reason);
  }, [togglePin]);

  // Swipe-right → open the actions menu for this chat
  const openChatActions = useCallback((payload: NonNullable<typeof actionChat>) => {
    setActionChat(payload);
  }, []);

  // ── Actions-menu operations ──────────────────────────────────────
  // Clear chat FOR THIS USER ONLY — records a per-user cutoff; the other member
  // keeps their messages. Nothing is deleted from Firestore.
  const actionClearChat = useCallback(async (chatId: string) => {
    if (!userId) return;
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('chats').doc(chatId).set(
        { clearedAt: { [userId]: firestore.FieldValue.serverTimestamp() } },
        { merge: true },
      );
      await clearLocalMessages(chatId);
    } catch (err) {
      console.error('[ChatsScreen] clear chat failed:', err);
      Alert.alert('Error', 'Could not clear chat.');
    }
  }, [userId]);

  // Delete chat FOR THIS USER ONLY — clears their view and removes them from the
  // chat members so it leaves their list. The other member is unaffected.
  const actionDeleteChat = useCallback(async (chatId: string) => {
    if (!userId) return;
    try {
      await actionClearChat(chatId);
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('chats').doc(chatId).update({
        members: firestore.FieldValue.arrayRemove(userId),
      }).catch(() => {});
    } catch (err) {
      console.error('[ChatsScreen] delete chat failed:', err);
      Alert.alert('Error', 'Could not delete chat.');
    }
  }, [actionClearChat, userId]);

  const actionBlock = useCallback(async (otherUid: string, name: string, photo: string | null) => {
    if (!userId) return;
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(userId).collection('blockedUsers').doc(otherUid).set({
        blockedAt: new Date(), displayName: name, photoURL: photo || null,
      });
      Alert.alert('Contact Blocked', `${name} has been blocked.`);
    } catch (err) {
      console.error('[ChatsScreen] block failed:', err);
      Alert.alert('Error', 'Could not block contact.');
    }
  }, [userId]);

  const renderChat = useCallback(({ item }: { item: ChatPreview }) => {
    if (item.chatId.startsWith(NO_CHAT_PREFIX)) {
      const otherId = item.chatId.slice(NO_CHAT_PREFIX.length);
      const contact = contacts.find((c) => c.userId === otherId);
      const otherUser = firestoreUsersMap.get(otherId);
      const displayName = contact?.displayName ?? otherUser?.displayName ?? 'Unknown';
      const contactPhotoUri = contact?.photoUri ?? otherUser?.contactPhotoUri;
      const rawPhoto = contact?.firebasePhotoURL ?? otherUser?.photoURL;
      const photoSetting = privacyPhotoMap.get(otherId) ?? 'Contacts';
      const firebasePhotoURL = (rawPhoto && isVisibleTo(photoSetting as any, true)) ? rawPhoto : null;

      return (
        <TouchableOpacity
          style={[styles.chatCard, bevel]}
          activeOpacity={0.75}
          onPress={() => openOrCreateDirectChat(
            otherId,
            displayName,
            firebasePhotoURL || contactPhotoUri || null,
          )}
        >
          <View style={styles.chatAvatarWrap}>
            <ChatAvatar
              displayName={displayName}
              contactPhotoUri={contactPhotoUri}
              firebasePhotoURL={firebasePhotoURL ?? undefined}
              isSavedContact={!!contactPhotoUri}
            />
          </View>
          <View style={styles.chatMeta}>
            <View style={styles.chatTopRow}>
              <Text style={[styles.chatName, { color: textColor, fontFamily }]} numberOfLines={1}>
                {displayName}
              </Text>
              <View style={styles.startChatPill}>
                <AppText fixedColor style={styles.startChatPillText}>Start chat</AppText>
              </View>
            </View>
            <View style={styles.chatBottomRow}>
              <Text style={[styles.chatPreview, { fontStyle: 'italic' }]} numberOfLines={1}>
                No messages yet — tap to open
              </Text>
            </View>
          </View>
        </TouchableOpacity>
      );
    }

    const displayName     = userId ? resolveDisplayName(item, userId, contactsMap, firestoreUsersMap) : 'Unknown';
    const isGroup         = classifyChat(item) === 'group';
    const otherMemberId   = isGroup ? null : item.members.find((id) => id !== userId);
    const otherUser       = otherMemberId ? firestoreUsersMap.get(otherMemberId) : null;
    const contactPhotoUri = otherUser?.contactPhotoUri;
    const rawPhoto        = otherUser?.photoURL;
    const photoSetting    = otherMemberId ? (privacyPhotoMap.get(otherMemberId) ?? 'Contacts') : 'Contacts';
    const firebasePhotoURL = (rawPhoto && isVisibleTo(photoSetting as any, true)) ? rawPhoto : null;
    const isSavedContact  = !!(contactPhotoUri || (otherUser && contactsMap.has(otherUser.phone)));
    const hasStatus       = otherMemberId ? (userStatusMap.get(otherMemberId) ?? false) : false;

    const isPinned = pinned.includes(item.chatId);
    const isMuted  = mutedChats.has(item.chatId);
    const otherPhone = otherUser?.phone;

    const swipeActions = [
      {
        key: 'pin',
        label: isPinned ? 'Unpin' : 'Pin',
        icon: 'pin',
        color: '#f59e0b',
        onPress: () => handleTogglePin(item.chatId),
      },
      {
        key: 'mute',
        label: isMuted ? 'Unmute' : 'Mute',
        icon: isMuted ? 'notifications' : 'notifications-off',
        color: '#6366f1',
        onPress: () => { toggleMute(item.chatId); },
      },
      {
        key: 'more',
        label: 'More',
        icon: 'ellipsis-horizontal',
        color: COLORS.blue,
        onPress: () => openChatActions({
          chatId: item.chatId,
          displayName,
          isGroup,
          otherUserId: otherMemberId ?? undefined,
          otherUserPhone: otherPhone,
          otherUserPhoto: firebasePhotoURL || contactPhotoUri || null,
          isSavedContact,
        }),
      },
    ];

    return (
      <SwipeableRow actions={swipeActions}>
        <ChatRow
          item={item}
          displayName={displayName}
          isGroup={isGroup}
          otherMemberId={otherMemberId ?? undefined}
          contactPhotoUri={contactPhotoUri}
          firebasePhotoURL={firebasePhotoURL ?? undefined}
          isSavedContact={isSavedContact}
          hasStatus={hasStatus}
          userId={userId}
          bevel={bevel}
          textColor={textColor}
          fontFamily={fontFamily}
          FGsecondary={FG.secondary}
          isPinned={isPinned}
          isMuted={isMuted}
          isFavourite={favourites.includes(item.chatId)}
          onPress={() => navigation.navigate('Chat', {
            chatId: item.chatId,
            displayName,
            isGroup,
            otherUserId: otherMemberId || undefined,
            otherUserPhoto: firebasePhotoURL || contactPhotoUri || null,
          })}
          onLongPress={() => setPreviewChat({
            chatId: item.chatId,
            displayName,
            isGroup,
            otherUserId: otherMemberId || undefined,
            otherUserPhoto: firebasePhotoURL || contactPhotoUri || null,
          })}
          senderInfo={item.lastSenderId && isGroup ? firestoreUsersMap.get(item.lastSenderId) : undefined}
        />
      </SwipeableRow>
    );
  }, [
    userId, contacts, contactsMap, firestoreUsersMap, privacyPhotoMap, userStatusMap,
    bevel, textColor, fontFamily, FG.secondary, navigation, openOrCreateDirectChat,
    pinned, mutedChats, favourites, handleTogglePin, toggleMute, openChatActions,
  ]);

  const openPreviewedChat = useCallback(() => {
    if (!previewChat) return;
    const pc = previewChat;
    navigation.navigate('Chat', {
      chatId: pc.chatId,
      displayName: pc.displayName,
      isGroup: pc.isGroup,
      otherUserId: pc.otherUserId,
      otherUserPhoto: pc.otherUserPhoto ?? null,
    });
  }, [previewChat, navigation]);

  const currentLabelTitle = (() => {
    if (tab === 'Chats') return 'Chats';
    if (tab === 'Groups') return 'Groups';
    if (tab === 'Broadcast') return 'Broadcast';
    return currentLabel?.title ?? 'Label';
  })();

  const isOnCustomLabel = !!currentLabel;

  return (
    <View style={styles.root}>
      <AppBg />

      <Modal visible={sheetOpen} transparent animationType="slide"
        onRequestClose={() => setSheetOpen(false)} statusBarTranslucent>
        <Pressable style={styles.overlay} onPress={() => setSheetOpen(false)} />
        <View style={styles.sheet}>
          <AppBg />
          <View style={styles.handle} />
          <SelectContactSheet
            onClose={() => setSheetOpen(false)}
            onNavigate={handleSelectContact}
            contacts={contacts}
            contactsLoading={contactsLoading}
            contactsError={contactsError}
            reloadContacts={reloadContacts}
            hasPermission={hasPermission}
            currentUserId={userId || ''}
            onNavigateToGroup={handleNavigateToGroup}
          />
        </View>
      </Modal>

      {/* ── Long-press message preview (read-only peek) ── */}
      <ChatPreviewModal
        visible={!!previewChat}
        chatId={previewChat?.chatId ?? null}
        currentUserId={userId}
        displayName={previewChat?.displayName ?? ''}
        onClose={() => setPreviewChat(null)}
        onOpenChat={openPreviewedChat}
      />

      {/* ── Chat actions menu (swipe right) ── */}
      <Modal
        visible={!!actionChat}
        transparent
        animationType="fade"
        onRequestClose={() => setActionChat(null)}
        statusBarTranslucent
      >
        <Pressable style={styles.overlay} onPress={() => setActionChat(null)} />
        {actionChat && (
          <View style={styles.actionMenuSheet}>
            <AppBg />
            <View style={styles.handle} />
            <AppText style={[styles.actionMenuTitle, { color: textColor, fontFamily }]} numberOfLines={1}>
              {actionChat.displayName}
            </AppText>

            {([
              {
                icon: 'information-circle-outline', label: 'Contact info', color: COLORS.blue,
                onPress: () => {
                  const ac = actionChat;
                  setActionChat(null);
                  navigation.navigate('Chat', {
                    chatId: ac.chatId, displayName: ac.displayName, isGroup: ac.isGroup,
                    otherUserId: ac.otherUserId, otherUserPhoto: ac.otherUserPhoto ?? null,
                    openProfile: true,
                  } as any);
                },
              },
              !actionChat.isSavedContact && !actionChat.isGroup && !!actionChat.otherUserPhone ? {
                icon: 'person-add-outline', label: 'Create contact', color: COLORS.blue,
                onPress: () => {
                  const ac = actionChat;
                  setActionChat(null);
                  navigation.navigate('Chat', {
                    chatId: ac.chatId, displayName: ac.displayName, isGroup: ac.isGroup,
                    otherUserId: ac.otherUserId, otherUserPhoto: ac.otherUserPhoto ?? null,
                    openAddContact: true,
                  } as any);
                },
              } : null,
              {
                icon: mutedChats.has(actionChat.chatId) ? 'notifications' : 'notifications-off-outline',
                label: mutedChats.has(actionChat.chatId) ? 'Unmute' : 'Mute',
                color: COLORS.blue,
                onPress: async () => { await toggleMute(actionChat.chatId); setActionChat(null); },
              },
              {
                icon: favourites.includes(actionChat.chatId) ? 'star' : 'star-outline',
                label: favourites.includes(actionChat.chatId) ? 'Remove favourite' : 'Add to favourites',
                color: '#f59e0b',
                onPress: async () => { await toggleFavourite(actionChat.chatId); setActionChat(null); },
              },
              {
                icon: 'brush-outline', label: 'Clear chat', color: COLORS.blue,
                onPress: () => {
                  const ac = actionChat; setActionChat(null);
                  Alert.alert('Clear Chat', 'Clear all messages in this chat?', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Clear', style: 'destructive', onPress: () => actionClearChat(ac.chatId) },
                  ]);
                },
              },
              !actionChat.isGroup && !!actionChat.otherUserId ? {
                icon: 'ban-outline', label: 'Block', color: COLORS.missed,
                onPress: () => {
                  const ac = actionChat; setActionChat(null);
                  Alert.alert('Block Contact', `Block ${ac.displayName}?`, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Block', style: 'destructive', onPress: () => actionBlock(ac.otherUserId!, ac.displayName, ac.otherUserPhoto ?? null) },
                  ]);
                },
              } : null,
              {
                icon: 'trash-outline', label: 'Delete chat', color: COLORS.missed,
                onPress: () => {
                  const ac = actionChat; setActionChat(null);
                  Alert.alert('Delete Chat', 'Delete this chat and all its messages?', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => actionDeleteChat(ac.chatId) },
                  ]);
                },
              },
            ].filter(Boolean) as { icon: string; label: string; color: string; onPress: () => void }[])
              .map((a) => (
                <TouchableOpacity key={a.label} style={[styles.actionMenuRow, bevel]} activeOpacity={0.75} onPress={a.onPress}>
                  <AppIcon name={a.icon as any} size={20} color={a.color} fixedColor />
                  <AppText style={[styles.actionMenuLabel, { color: a.color === COLORS.missed ? COLORS.missed : textColor }]}>
                    {a.label}
                  </AppText>
                </TouchableOpacity>
              ))}
          </View>
        )}
      </Modal>

      <Modal
        visible={labelManagerOpen}
        transparent
        animationType="slide"
        onRequestClose={closeLabelManager}
        statusBarTranslucent
      >
        <Pressable
          style={styles.overlay}
          onPress={closeLabelManager}
        />
        <View style={styles.sheet}>
          <AppBg />
          <View style={styles.handle} />
          <ChatLabelManagerSheet
            visible={labelManagerOpen}
            onClose={closeLabelManager}
            currentUserId={userId || ''}
            contacts={contacts}
            groups={groupOptions}
            labels={labels}
            initialEditingLabelId={managingLabelId}
            onCreateLabel={createLabel}
            onUpdateLabel={updateLabel}
            onDeleteLabel={deleteLabel}
            onLabelCreated={(id) => {
              pendingLabelIdRef.current = id;
              closeLabelManager();
              setTimeout(() => setTab(id), 60);
            }}
          />
        </View>
      </Modal>

      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerRow}>
          <AppText style={[styles.appName, { color: textColor, fontFamily }]}>ChitChat</AppText>

          {!searchOpen && (
            <TouchableOpacity
              style={iconButton}
              onPress={openSearch}
              activeOpacity={0.8}
            >
              <AppIcon name="search-outline" size={20} color={COLORS.blue} />
            </TouchableOpacity>
          )}
        </View>

        {searchOpen && (
          <Animated.View
            style={[
              styles.searchBubble,
              {
                opacity: searchAnim,
                transform: [{
                  translateY: searchAnim.interpolate({
                    inputRange: [0, 1], outputRange: [-12, 0],
                  }),
                }],
              },
            ]}
          >
            <AppIcon name="search-outline" size={15} color={COLORS.sub} />
            <TextInput
              ref={searchRef}
              style={styles.searchInput}
              placeholder="Search"
              placeholderTextColor={COLORS.sub}
              value={query}
              onChangeText={setQuery}
            />
            <TouchableOpacity onPress={closeSearch} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <AppIcon name="close-circle" size={18} color={COLORS.sub} />
            </TouchableOpacity>
          </Animated.View>
        )}
      </View>

      <View style={styles.tabBarOuter}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabBarContent}
        >
          {(['Chats', 'Groups', 'Broadcast'] as const).map((t) => {
            const active = tab === t;
            return active ? (
              <TouchableOpacity key={t} onPress={() => setTab(t)} activeOpacity={0.85}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.tabPillActive}>
                  <AppText style={styles.tabLabelActive}>{t}</AppText>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity key={t} style={[styles.tabPillInactive, bevel]}
                onPress={() => setTab(t)} activeOpacity={0.7}>
                <AppText style={[styles.tabLabel, { color: FG.secondary }]}>{t}</AppText>
              </TouchableOpacity>
            );
          })}

          {labels.map((label) => {
            const active = tab === label.id;
            return active ? (
              <TouchableOpacity key={label.id} onPress={() => setTab(label.id)} activeOpacity={0.85}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.tabPillActive}>
                  <AppText style={styles.tabLabelActive} numberOfLines={1}>
                    {label.title}
                  </AppText>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                key={label.id}
                style={[styles.tabPillInactive, bevel]}
                onPress={() => setTab(label.id)}
                activeOpacity={0.7}
              >
                <AppText style={[styles.tabLabel, { color: FG.secondary }]} numberOfLines={1}>
                  {label.title}
                </AppText>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <TouchableOpacity
          style={[styles.tabAddBtn, bevel]}
          onPress={openLabelManager}
          activeOpacity={0.85}
          accessibilityLabel="Manage chat labels"
          accessibilityRole="button"
        >
          <AppIcon name="add" size={20} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
      </View>

      {tab === 'Broadcast' ? (
        <BroadcastScreen />
      ) : chatsLoading ? (
        <View style={styles.emptyWrap}>
          <ActivityIndicator size="large" color={COLORS.blue} />
          <Text style={styles.emptyText}>Loading chats…</Text>
        </View>
      ) : (
        <FlatList
          data={data}
          keyExtractor={(item) => item.chatId}
          renderItem={renderChat}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          removeClippedSubviews
          maxToRenderPerBatch={10}
          windowSize={10}
          initialNumToRender={12}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <AppIcon name="chatbubbles-outline" size={52} color={COLORS.sub} />
              <AppText style={styles.emptyText}>
                {(tab === 'Chats' || tab === 'Groups')
                  ? `No ${tab.toLowerCase()} yet`
                  : `Nothing in "${currentLabelTitle}" yet`}
              </AppText>
              {isOnCustomLabel && (
                <AppText style={[styles.emptySubText, { color: COLORS.sub }]}>
                  Tap "Manage the Label" below to add contacts or groups.
                </AppText>
              )}
            </View>
          }
          ListFooterComponent={
            isOnCustomLabel ? (
              <TouchableOpacity
                style={[styles.manageLabelBtn, bevel]}
                onPress={() => openManageLabel(currentLabel!.id)}
                activeOpacity={0.8}
              >
                <LinearGradient colors={GRADIENTS.primary} style={styles.manageLabelIcon}>
                  <AppIcon name="settings-outline" size={18} color="#fff" fixedColor />
                </LinearGradient>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <AppText style={[styles.manageLabelTitle, { color: textColor, fontFamily }]}>
                    Manage the Label
                  </AppText>
                  <AppText style={[styles.manageLabelSub, { color: FG.secondary }]}>
                    Add or remove people, rename, or delete this label
                  </AppText>
                </View>
                <AppIcon name="chevron-forward" size={18} color={FG.secondary} />
              </TouchableOpacity>
            ) : null
          }
        />
      )}

      {tab !== 'Broadcast' && (
        <TouchableOpacity
          style={[styles.fab, bevel, { bottom: insets.bottom + 150 }, Platform.OS === 'web' && styles.fabWeb]}
          activeOpacity={0.85}
          onPress={() => setSheetOpen(true)}
        >
          <AppIcon name="add" size={28} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
      )}

      <BottomNav active="chats" />
    </View>
  );
}


// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.sky1 },

  avatarCircle: {
    width: 50, height: 50, borderRadius: 25,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.50)',
    borderTopColor: 'rgba(255,255,255,0.75)',
    shadowColor: '#1E9CF0',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.20,
    shadowRadius: 6,
    elevation: 3,
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 18 },

  header: {
    flexDirection: 'column',
    paddingHorizontal: 14,
    paddingBottom: 10,
    gap: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  appName: {
    fontSize: 22,
    fontWeight: '800',
    color: COLORS.text, letterSpacing: -0.5,
  },
  searchBubble: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(30,156,240,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.18)',
    shadowColor: '#1E9CF0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 2,
    borderRadius: RADIUS.full,
    paddingHorizontal: 14, height: 42,
    overflow: 'hidden',
  },
  searchInput: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0 },

  tabBarOuter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 10,
    marginBottom: 10,
  },
  tabBarContent: {
    gap: 6,
    paddingRight: 8,
    alignItems: 'center',
  },
  tabPillActive:   { paddingHorizontal: 20, paddingVertical: 9, borderRadius: RADIUS.full, ...SHADOW.button, maxWidth: 180 },
  tabPillInactive: {
    paddingHorizontal: 20,
    paddingVertical: 9,
    borderRadius: RADIUS.full,
    maxWidth: 180,
  },
  tabLabel:        { fontSize: 14, fontWeight: '600', color: COLORS.sub },
  tabLabelActive:  { fontSize: 14, fontWeight: '700', color: '#fff' },

  tabAddBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },

  listContent: { paddingHorizontal: 14, paddingBottom: 110 },
  chatCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  chatAvatarWrap: { position: 'relative', width: 52, height: 52 },
  onlineDot: {
    position: 'absolute', bottom: 1, right: 1,
    width: 13, height: 13, borderRadius: 7,
    backgroundColor: '#22c55e',
    borderWidth: 2, borderColor: 'rgba(180,225,245,0.22)',
  },
  awayDot: { backgroundColor: '#f59e0b' },

  chatMeta:       { flex: 1, gap: 4 },
  chatTopRow:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  chatBottomRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6 },
  chatName:       { flex: 1, fontSize: 14, fontWeight: '700', color: COLORS.text },
  chatPreview:    { flex: 1, fontSize: 12, color: COLORS.sub, lineHeight: 17 },
  voiceNotePreview: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  chatTime:       { fontSize: 11, color: COLORS.sub, flexShrink: 0 },
  badge:          {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#25D366',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    paddingHorizontal: 6,
  },
  badgeText:      { color: '#fff', fontSize: 11, fontWeight: '700' },

  startChatPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: RADIUS.full,
    backgroundColor: 'rgba(30,156,240,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.30)',
  },
  startChatPillText: {
    fontSize: 10,
    fontWeight: '800',
    color: COLORS.blue,
  },

  fab:      { position: 'absolute', right: 20, bottom: 130, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  fabWeb:   { right: 16, bottom: 120 },
  fabInner: { flex: 1, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },

  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: '90%',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    overflow: 'hidden',
    ...SHADOW.glow,
  },
  handle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(30,156,240,0.30)', marginTop: 10, marginBottom: 4,
  },

  // Chat actions menu (swipe right)
  actionMenuSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 14,
    paddingBottom: Platform.OS === 'ios' ? 36 : 20,
    overflow: 'hidden',
    ...SHADOW.glow,
  },
  actionMenuTitle: { fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 4, marginBottom: 12 },
  actionMenuRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14, paddingHorizontal: 16,
    borderRadius: RADIUS.md, marginBottom: 8,
  },
  actionMenuLabel: { fontSize: 15, fontWeight: '600' },

  sheetSubHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, gap: 10,
  },
  iconPad:    { padding: 4 },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: COLORS.text },
  sheetSub:   { fontSize: 12, color: COLORS.sub, marginTop: 1 },

  actionBlock: { paddingHorizontal: 14, gap: 8, marginBottom: 4 },
  actionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 13,
  },
  actionIconWrap: {},
  actionIcon: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  actionLabel: { flex: 1, fontSize: 15, fontWeight: '600', color: COLORS.text },

  sectionHint: {
    fontSize: 11, fontWeight: '600', color: COLORS.sub,
    letterSpacing: 0.5, paddingHorizontal: 20, paddingVertical: 8,
  },

  contactRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    marginHorizontal: 14, marginBottom: 8,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 11,
  },
  contactMeta: { flex: 1 },
  contactName: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  contactSub:  { fontSize: 12, color: COLORS.sub, marginTop: 2 },

  checkbox:   { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.sub, alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },

  nameError: {
    fontSize: 12, color: COLORS.missed,
    marginHorizontal: 14, marginTop: -6, marginBottom: 8,
  },

  retryBtn: {
    marginTop: 16,
    borderRadius: RADIUS.full,
    overflow: 'hidden',
    ...SHADOW.button,
  },
  retryBtnGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  retryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },

  nextBtnGrad: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADIUS.full,
    ...SHADOW.button,
  },
  nextBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },

  glassInput: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 14, marginBottom: 10,
    borderRadius: RADIUS.md,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  inputField: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0 },

  numberRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginHorizontal: 20, marginBottom: 12, minHeight: 52,
  },
  numberText: {
    flex: 1, textAlign: 'center',
    fontSize: 34, fontWeight: '200', color: COLORS.text, letterSpacing: 5,
  },

  keyGrid: { marginHorizontal: 14, gap: 10, marginBottom: 16 },
  keyRow:  { flexDirection: 'row', gap: 10 },
  keyBtn:  {
    flex: 1, paddingVertical: 14,
    borderRadius: RADIUS.lg,
    alignItems: 'center', justifyContent: 'center',
  },
  keyDigit: { fontSize: 26, fontWeight: '300', color: COLORS.text, lineHeight: 30 },
  keySub:   { fontSize: 9, fontWeight: '600', color: COLORS.sub, letterSpacing: 1 },

  rowActions:  { flexDirection: 'row', gap: 10, marginHorizontal: 14, marginBottom: 20 },
  cancelBtn:   {
    flex: 1,
    paddingVertical: 14,
    borderRadius: RADIUS.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText:  { fontSize: 14, fontWeight: '600', color: COLORS.sub },
  confirmBtn:  { flex: 2 },
  dimmed:      { opacity: 0.4 },
  confirmGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 14, borderRadius: RADIUS.lg, ...SHADOW.button,
  },
  confirmText: { fontSize: 14, fontWeight: '700', color: '#fff' },

  emptyWrap: { alignItems: 'center', paddingTop: 80, gap: 12, paddingHorizontal: 30 },
  emptyText: { fontSize: 15, color: COLORS.sub, textAlign: 'center' },
  emptySubText: { fontSize: 13, color: COLORS.sub, textAlign: 'center', marginTop: -4 },

  ring: {
    width: 54, height: 54, borderRadius: 27,
    padding: 2, alignItems: 'center', justifyContent: 'center',
  },
  ringInner: {
    width: 50, height: 50, borderRadius: 25,
    backgroundColor: 'rgba(255,255,255,0.95)', overflow: 'hidden',
  },

  sheetDropdown: {
    marginHorizontal: 14, marginTop: 4, marginBottom: 10,
    borderRadius: RADIUS.lg, borderWidth: 1,
    overflow: 'hidden',
  },
  sheetDropdownItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  sheetDropdownTxt: { fontSize: 14, fontWeight: '600' },

  sheetSearchBubble: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: RADIUS.full, borderWidth: 1,
    paddingHorizontal: 14, height: 42,
    overflow: 'hidden',
  },
  sheetSearchInput: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0 },

  selectedAvatarsRow: {
    flexDirection: 'row', paddingHorizontal: 14,
    paddingBottom: 10, gap: 12, flexWrap: 'wrap',
  },
  selectedAvatarWrap: { position: 'relative' },
  removeBadge: {
    position: 'absolute', top: -2, right: -2,
    width: 18, height: 18, borderRadius: 9,
    backgroundColor: COLORS.missed,
    alignItems: 'center', justifyContent: 'center',
  },

  contactRowSelected: {
    backgroundColor: 'rgba(30,156,240,0.12)',
    borderColor: 'rgba(30,156,240,0.30)',
  },
  contactRowDisabled: {
    opacity: 0.55,
  },
  selectedIndicator: { marginLeft: 8 },

  broadcastCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: RADIUS.lg,
    marginBottom: 10,
  },
  broadcastIcon: {
    width: 42, height: 42, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  broadcastAction: {
    paddingHorizontal: 6,
    paddingVertical: 6,
  },

  selectedChipsWrap: {
    maxHeight: 52,
    marginTop: 2,
    marginBottom: 6,
  },
  selectedChipsRow: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    gap: 8,
    flexDirection: 'row',
    alignItems: 'center',
  },
  selectedChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: RADIUS.full,
    maxWidth: 200,
    flexShrink: 0,
  },
  selectedChipDot: {
    width: 22, height: 22, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
  },
  selectedChipInitial: { fontSize: 9, color: '#fff', fontWeight: '800' },
  selectedChipLabel: { fontSize: 12, fontWeight: '600', maxWidth: 130 },
  editorTabs: {
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 14,
    marginTop: 8,
    marginBottom: 6,
  },
  editorTabActive: {
    paddingHorizontal: 18, paddingVertical: 8,
    borderRadius: RADIUS.full,
    ...SHADOW.button,
  },
  editorTabInactive: {
    paddingHorizontal: 18, paddingVertical: 8,
    borderRadius: RADIUS.full,
  },
  editorTabActiveText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  editorTabText: { fontSize: 13, fontWeight: '600' },

  manageLabelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 16,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.18)',
    backgroundColor: 'rgba(30,156,240,0.06)',
  },
  manageLabelIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  manageLabelTitle: { fontSize: 14, fontWeight: '800' },
  manageLabelSub:   { fontSize: 12, marginTop: 2, lineHeight: 16 },

  deleteLabelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 24,
    marginHorizontal: 14,
    paddingVertical: 14,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    backgroundColor: 'rgba(239,68,68,0.06)',
  },
  deleteLabelText: { fontSize: 14, fontWeight: '700' },
});