// ─── Screen: Chats ───────────────────────────────────────────────────────────
import React, { useState, useRef, useMemo, useEffect, useCallback, memo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, Modal, Pressable, ScrollView, Animated,
  ActivityIndicator, Image, Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { BottomNav } from '../components';
import { useAuth } from '../hooks/useAuth';
import { useChats, ChatPreview } from '../hooks/useChats';
import { useContacts, AppContact } from '../hooks/useContacts';
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
type TabType   = 'Chats' | 'Groups' | 'Broadcast';
type SheetMode = 'select' | 'newContact' | 'newGroup';

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
  
  // Priority: 1. Contact photo, 2. Firebase photo, 3. Initials
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

  // If user has status, wrap in gradient ring
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

// ─── ChatRow — memoized list row ──────────────────────────────────────────────
// Receives all resolved data as props so React.memo can do a shallow compare
// and skip re-rendering rows whose data hasn't changed.
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
  senderInfo?:      { displayName: string } | undefined;
}

const ChatRow = memo(function ChatRow({
  item, displayName, isGroup, contactPhotoUri, firebasePhotoURL,
  isSavedContact, hasStatus, userId, bevel, textColor, fontFamily,
  FGsecondary, onPress, senderInfo,
}: ChatRowProps) {
  const isVoiceNote = item.lastMessage === '[Voice Note]';

  const senderPrefix = (() => {
    if (!item.lastSenderId) return '';
    if (item.lastSenderId === userId) return 'You: ';
    if (isGroup && senderInfo) return `${senderInfo.displayName.split(' ')[0]}: `;
    return '';
  })();

  return (
    <TouchableOpacity style={[styles.chatCard, bevel]} activeOpacity={0.75} onPress={onPress}>
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
          <Text style={[styles.chatTime, { color: FGsecondary }]}>{formatTime(item.timestamp)}</Text>
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
  [{ d: '*', s: '' },    { d: '0', s: '+' },     { d: '#', s: ''     }],
];

function NewContactSheet({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [number, setNumber] = useState('');
  const [name,   setName]   = useState('');
  const { bevel } = useGlass();
  const press = (k: string) => setNumber((n) => n + k);
  const del   = () => setNumber((n) => n.slice(0, -1));

  return (
    <>
      <View style={styles.sheetSubHeader}>
        <TouchableOpacity onPress={onBack} style={styles.iconPad}>
          <AppIcon name="chevron-back" size={22} color={COLORS.blue} />
        </TouchableOpacity>
        <AppText style={styles.sheetTitle}>New Contact</AppText>
      </View>

      {/* Name input — glass */}
      <View style={[styles.glassInput, bevel]}>
        <AppIcon name="person-outline" size={18} color={COLORS.sub} />
        <TextInput style={styles.inputField} placeholder="Contact name"
          placeholderTextColor={COLORS.sub} value={name} onChangeText={setName} />
      </View>

      {/* Number display */}
      <View style={styles.numberRow}>
        <AppText style={styles.numberText} numberOfLines={1}>{number || ' '}</AppText>
        {number.length > 0 && (
          <TouchableOpacity onPress={del} style={styles.iconPad}>
            <AppIcon name="backspace-outline" size={22} color={COLORS.blue} />
          </TouchableOpacity>
        )}
      </View>

      {/* Keypad */}
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
        <TouchableOpacity style={[styles.confirmBtn, (!number || !name) && styles.dimmed]}
          activeOpacity={number && name ? 0.85 : 1}
          onPress={() => { if (number && name) onDone(); }}>
          <LinearGradient colors={GRADIENTS.primary} style={styles.confirmGrad}>
            <AppIcon name="person-add-outline" size={18} color="#fff" fixedColor />
            <AppText fixedColor style={styles.confirmText}>Save Contact</AppText>
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
  // Map of userId → privacyGroups setting, fetched once when the sheet opens
  const [privacyMap,  setPrivacyMap]  = useState<Map<string, string>>(new Map());
  const [privacyLoading, setPrivacyLoading] = useState(true);
  const { bevel } = useGlass();
  const { FG } = useForeground();
  const { textColor } = useTypography();

  // Fetch each contact's privacyGroups setting once on mount
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

  /** Returns true if the current user is allowed to add this contact to a group. */
  const canAdd = (userId: string): boolean => {
    const setting = privacyMap.get(userId) ?? 'Everyone';
    // 'Everyone' → anyone can add
    // 'Contacts' → only contacts can add — since all people in this list are
    //              the creator's device contacts, we treat this as allowed.
    // 'Nobody'   → nobody can add
    return setting !== 'Nobody';
  };

  const toggle = (userId: string) => {
    if (!canAdd(userId)) return; // silently ignore taps on blocked contacts
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
      console.log('[NewGroupSheet] Group created:', chatId);
      if (blockedByPrivacy.length > 0) {
        const { Alert } = await import('react-native');
        Alert.alert(
          'Some members not added',
          `${blockedByPrivacy.length} contact(s) have set their privacy to not allow being added to groups and were excluded.`,
        );
      }
      onDone();
      onNavigateToGroup(chatId, groupName.trim());
    } catch (err) {
      console.error('[NewGroupSheet] Failed to create group:', err);
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
          <TouchableOpacity 
            onPress={handleCreate} 
            activeOpacity={0.85}
            disabled={creating}
          >
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

      {/* Group name — glass */}
      <View style={[styles.glassInput, bevel]}>
        <AppIcon name="people-outline" size={18} color={COLORS.sub} />
        <TextInput style={styles.inputField} placeholder="Group name"
          placeholderTextColor={COLORS.sub} value={groupName}
          onChangeText={(t) => { setGroupName(t); setNameError(''); }} />
      </View>
      {nameError ? (
        <AppText style={styles.nameError}>{nameError}</AppText>
      ) : null}

      {/* Selected avatars row */}
      {selected.length > 0 && (
        <View style={styles.selectedAvatarsRow}>
          {selected.map((userId) => {
            const c = contacts.find((x) => x.userId === userId);
            if (!c) return null;
            const color = stringToColor(c.displayName);
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

// ─── Select-contact sheet ─────────────────────────────────────────────────────
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
    return <NewContactSheet onBack={() => setMode('select')} onDone={onClose} />;
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
      {/* Header */}
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

      {/* 3-dot dropdown — shown inline below the header */}
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

      {/* Action rows */}
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

      {/* Contact list */}
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

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function ChatsScreen() {
  const navigation  = useNavigation<NavProp>();
  const { user }    = useAuth();
  const userId      = user?.uid ?? null;

  // Three theme hooks — each subscribes to ThemeContext once.
  // They are memoized in the provider so they won't cause unnecessary re-renders.
  const { FG }                         = useForeground();
  const { fontFamily, textColor }      = useTypography();
  const { bevel, iconButton }          = useGlass();
  const insets = useSafeAreaInsets();

  const { chats, loading: chatsLoading } = useChats(userId);
  const { contacts, loading: contactsLoading, reload: reloadContacts, hasPermission, error: contactsError } = useContacts();
  const { contactStatuses } = useStatus(userId);

  // Create a map of userId -> hasStatus for quick lookup
  const userStatusMap = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const statusGroup of contactStatuses) {
      map.set(statusGroup.userId, true);
    }
    return map;
  }, [contactStatuses]);

  // Log contacts state — removed for production performance

  const [tab,        setTab]        = useState<TabType>('Chats');
  const [query,      setQuery]      = useState('');
  const [sheetOpen,  setSheetOpen]  = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // Extra member info fetched from Firestore for users not in device contacts
  const [memberInfo, setMemberInfo] = useState<Map<string, { displayName: string; phone: string; photoURL?: string }>>(new Map());
  // Cache of privacy settings: userId → profilePhoto visibility ('Everyone'|'Contacts'|'Nobody')
  const [privacyPhotoMap, setPrivacyPhotoMap] = useState<Map<string, string>>(new Map());

  // Animated width: 0 → 1 (multiplied by max width in style)
  const searchAnim = useRef(new Animated.Value(0)).current;
  const searchRef  = useRef<TextInput>(null);

  // Build contacts map: phone → displayName (for resolveDisplayName)
  const contactsMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of contacts) {
      map.set(c.phone, c.displayName);
    }
    return map;
  }, [contacts]);

  // Build firestoreUsers map: userId → { displayName, phone, photoURL }
  const firestoreUsersMap = useMemo(() => {
    const map = new Map<string, { displayName: string; phone: string; photoURL?: string; contactPhotoUri?: string }>();
    // Add all contacts (displayName from useContacts already has correct priority)
    for (const c of contacts) {
      map.set(c.userId, { 
        displayName: c.displayName, 
        phone: c.phone,
        photoURL: c.firebasePhotoURL,
        contactPhotoUri: c.photoUri,
      });
    }
    // Add users not in contacts (fetched separately from Firestore)
    for (const [uid, info] of memberInfo) {
      if (!map.has(uid)) {
        map.set(uid, info);
      }
    }
    return map;
  }, [contacts, memberInfo]);

  // Fetch Firestore user info for chat members not in contacts
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

  // Fetch privacyProfilePhoto for device contacts (they come from useContacts, not the effect above)
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
    // Only run when the contact list changes, not on every privacyPhotoMap update
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contacts]);

  // Filter chats by tab
  const directChats = useMemo(() => chats.filter((c) => c.type === 'direct'), [chats]);
  const groupChats  = useMemo(() => chats.filter((c) => c.type === 'group'), [chats]);

  // Memoize the filtered + searched list so FlatList only re-renders when it changes
  const data = useMemo(() => {
    const base = tab === 'Chats' ? directChats : groupChats;
    if (!query.trim()) return base;
    const q = query.toLowerCase();
    return base.filter((c) => {
      if (!userId) return false;
      return resolveDisplayName(c, userId, contactsMap, firestoreUsersMap).toLowerCase().includes(q);
    });
  }, [tab, directChats, groupChats, query, userId, contactsMap, firestoreUsersMap]);

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

  // Called when a contact is tapped in the sheet
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

  // Called when a group is created
  const handleNavigateToGroup = useCallback((chatId: string, groupName: string) => {
    if (!userId) return;
    navigation.navigate('Chat', { chatId, displayName: groupName, isGroup: true });
  }, [userId, navigation]);

  // renderItem is stable — only re-runs when the resolved row data changes
  const renderChat = useCallback(({ item }: { item: ChatPreview }) => {
    const displayName     = userId ? resolveDisplayName(item, userId, contactsMap, firestoreUsersMap) : 'Unknown';
    const isGroup         = item.type === 'group';
    const otherMemberId   = isGroup ? null : item.members.find((id) => id !== userId);
    const otherUser       = otherMemberId ? firestoreUsersMap.get(otherMemberId) : null;
    const contactPhotoUri = otherUser?.contactPhotoUri;
    const rawPhoto        = otherUser?.photoURL;
    const photoSetting    = otherMemberId ? (privacyPhotoMap.get(otherMemberId) ?? 'Contacts') : 'Contacts';
    const firebasePhotoURL = (rawPhoto && isVisibleTo(photoSetting as any, true)) ? rawPhoto : null;
    const isSavedContact  = !!(contactPhotoUri || (otherUser && contactsMap.has(otherUser.phone)));
    const hasStatus       = otherMemberId ? (userStatusMap.get(otherMemberId) ?? false) : false;

    return (
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
        onPress={() => navigation.navigate('Chat', {
          chatId: item.chatId,
          displayName,
          isGroup,
          otherUserId: otherMemberId || undefined,
          otherUserPhoto: firebasePhotoURL || contactPhotoUri || null,
        })}
        senderInfo={item.lastSenderId && isGroup ? firestoreUsersMap.get(item.lastSenderId) : undefined}
      />
    );
  }, [userId, contactsMap, firestoreUsersMap, privacyPhotoMap, userStatusMap, bevel, textColor, fontFamily, FG.secondary, navigation]);

  return (
    <View style={styles.root}>
      <AppBg />
      
      {/* ── Bottom sheet modal ── */}
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

      {/* ── Header ── */}
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

      {/* ── Tabs ── */}
      <View style={styles.tabBar}>
        {(['Chats', 'Groups','Broadcast'] as TabType[]).map((t) => {
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
      </View>

      {/* ── Chat list / Broadcast tab ── */}
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
              <AppText style={styles.emptyText}>No {tab.toLowerCase()} yet</AppText>
            </View>
          }
        />
      )}

      {/* ── FAB — hidden on Broadcast tab (BroadcastScreen has its own FAB) ── */}
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

  // ── Avatar ───────────────────────────────────────────────────────────────
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

  // ── Header ───────────────────────────────────────────────────────────────
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
  searchIconBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(180,225,245,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.45)',
    borderTopColor: 'rgba(255,255,255,0.60)',
    shadowColor: '#0e6ea8',
    shadowOffset: { width: 2, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 8,
    elevation: 3,
    alignItems: 'center', 
    justifyContent: 'center',
  },

  // ── Tabs ─────────────────────────────────────────────────────────────────
  tabBar:          { flexDirection: 'row', paddingHorizontal: 14, marginBottom: 10, gap: 6 },
  tabPillActive:   { paddingHorizontal: 22, paddingVertical: 9, borderRadius: RADIUS.full, ...SHADOW.button },
  tabPillInactive: { 
    paddingHorizontal: 22, 
    paddingVertical: 9, 
    borderRadius: RADIUS.full, 
  },
  tabLabel:        { fontSize: 14, fontWeight: '600', color: COLORS.sub },
  tabLabelActive:  { fontSize: 14, fontWeight: '700', color: '#fff' },

  // ── Chat cards ────────────────────────────────────────────────────────────
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
    backgroundColor: '#25D366', // WhatsApp green
    alignItems: 'center', 
    justifyContent: 'center', 
    flexShrink: 0,
    paddingHorizontal: 6,
  },
  badgeText:      { color: '#fff', fontSize: 11, fontWeight: '700' },

  // ── FAB ──────────────────────────────────────────────────────────────────
  fab:      { position: 'absolute', right: 20, bottom: 130, width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  fabWeb:   { right: 16, bottom: 120 },
  fabInner: { flex: 1, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },

  // ── Bottom sheet ──────────────────────────────────────────────────────────
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

  // ── Sheet shared ──────────────────────────────────────────────────────────
  sheetSubHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12, gap: 10,
  },
  iconPad:    { padding: 4 },
  sheetTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: COLORS.text },
  sheetSub:   { fontSize: 12, color: COLORS.sub, marginTop: 1 },

  // Action rows
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

  // Contact rows in sheet
  contactRow: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    marginHorizontal: 14, marginBottom: 8,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 11,
  },
  contactMeta: { flex: 1 },
  contactName: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  contactSub:  { fontSize: 12, color: COLORS.sub, marginTop: 2 },

  // Group checkbox
  checkbox:   { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: COLORS.sub, alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },

  // Error text for group name
  nameError: {
    fontSize: 12, color: COLORS.missed,
    marginHorizontal: 14, marginTop: -6, marginBottom: 8,
  },

  // Retry button
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

  // Group chips
  chipsRow: { paddingHorizontal: 14, paddingBottom: 10, gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: RADIUS.full,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  chipDot:  { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  chipInit: { fontSize: 9, color: '#fff', fontWeight: '700' },
  chipName: { fontSize: 12, fontWeight: '600', color: COLORS.text },

  // Create group button
  nextBtnGrad: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: RADIUS.full,
    ...SHADOW.button,
  },
  nextBtnText: { fontSize: 13, fontWeight: '700', color: '#fff' },

  // Glass text input
  glassInput: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 14, marginBottom: 10,
    borderRadius: RADIUS.md,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  inputField: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0 },

  // Keypad number display
  numberRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    marginHorizontal: 20, marginBottom: 12, minHeight: 52,
  },
  numberText: {
    flex: 1, textAlign: 'center',
    fontSize: 34, fontWeight: '200', color: COLORS.text, letterSpacing: 5,
  },

  // Keypad grid
  keyGrid: { marginHorizontal: 14, gap: 10, marginBottom: 16 },
  keyRow:  { flexDirection: 'row', gap: 10 },
  keyBtn:  {
    flex: 1, paddingVertical: 14,
    borderRadius: RADIUS.lg,
    alignItems: 'center', justifyContent: 'center',
  },
  keyDigit: { fontSize: 26, fontWeight: '300', color: COLORS.text, lineHeight: 30 },
  keySub:   { fontSize: 9, fontWeight: '600', color: COLORS.sub, letterSpacing: 1 },

  // Action buttons row
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

  // Empty state
  emptyWrap: { alignItems: 'center', paddingTop: 80, gap: 12 },
  emptyText: { fontSize: 15, color: COLORS.sub },

  // Status ring (for future stories feature)
  ring: {
    width: 54, height: 54, borderRadius: 27,
    padding: 2, alignItems: 'center', justifyContent: 'center',
  },
  ringInner: {
    width: 50, height: 50, borderRadius: 25,
    backgroundColor: 'rgba(255,255,255,0.95)', overflow: 'hidden',
  },

  // Dropdown menu
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

  // Sheet search bubble
  sheetSearchBubble: {
    flex: 1,
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: RADIUS.full, borderWidth: 1,
    paddingHorizontal: 14, height: 42,
    overflow: 'hidden',
  },
  sheetSearchInput: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0 },

  // Selected avatars row
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

  // Selected contact state
  contactRowSelected: {
    backgroundColor: 'rgba(30,156,240,0.12)',
    borderColor: 'rgba(30,156,240,0.30)',
  },
  contactRowDisabled: {
    opacity: 0.55,
  },
  selectedIndicator: { marginLeft: 8 },
});
