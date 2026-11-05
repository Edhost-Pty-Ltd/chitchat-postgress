// ─── Screen: Chat ────────────────────────────────────────────────────────────
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, FlatList, TouchableOpacity, ScrollView,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform,
  ActivityIndicator, PanResponder, Linking, Modal, Alert,
  GestureResponderEvent, PanResponderGestureState, Image, Dimensions,
  Animated, Easing, Share, Switch, Pressable,
} from 'react-native';
import { useNavigation, useRoute, RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy'; // use 'expo-file-system' on Expo SDK < 54
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import AsyncStorage from '@react-native-async-storage/async-storage';
import QRCode from 'react-native-qrcode-svg';
import { NotificationTestPanel } from '../components/NotificationTestPanel';

// Platform-specific imports for native-only modules
let CameraView: any = null;
let useCameraPermissions: any = null;
let useMediaLibraryPermissions: any = null;
let useVideoPlayer: any = (_src: any, _setup?: (p: any) => void) => ({ replace: () => {}, play: () => {}, pause: () => {} });
let VideoView: any = 'View';

if (Platform.OS !== 'web') {
  try {
    const camera = require('expo-camera');
    CameraView = camera.CameraView;
    useCameraPermissions = camera.useCameraPermissions;
  } catch (err) {
    console.warn('[ChatScreen] expo-camera not available:', err);
  }

  try {
    const mediaLibrary = require('expo-media-library');
    useMediaLibraryPermissions = mediaLibrary.usePermissions;
  } catch (err) {
    console.warn('[ChatScreen] expo-media-library not available:', err);
  }

  try {
    const video = require('expo-video');
    useVideoPlayer = video.useVideoPlayer;
    VideoView = video.VideoView;
  } catch (err) {
    console.warn('[ChatScreen] expo-video not available:', err);
  }
} else {
  // Web fallbacks
  useCameraPermissions = () => [null, () => Promise.resolve({ status: 'denied' })];
  useMediaLibraryPermissions = () => [null, () => Promise.resolve({ status: 'denied' })];
}

import { endpoints } from '../api/endpoints';
import { mediaService, fileSize } from '../services/mediaService';
import { getFileExtension } from '../utils/fileUtils';
import { Avatar, BottomNav } from '../components';
import { VoiceMessageBubble } from '../components/VoiceMessageBubble';
import { FileMessageBubble } from '../components/FileMessageBubble';
import { OrderBubble } from '../components/OrderBubble';
import { ContactBubble } from '../components/ContactBubble';
import { PollBubble } from '../components/PollBubble';
import { MeetingBubble } from '../components/MeetingBubble';
import { CreatePollModal } from '../components/CreatePollModal';
import { MediaUploadOverlay } from '../components/MediaUploadOverlay';

import { VoiceRecordingOverlay } from '../components/VoiceRecordingOverlay';
import { ForwardModal } from '../components/ForwardModal';
import { MessageInfoModal } from '../components/MessageInfoModal';
import { CatalogBubble } from '../components/CatalogBubble';
import { PaymentSheet, PaymentOrderItem } from '../components/PaymentSheet';
import { useAuth } from '../hooks/useAuth';
import { useMessages, FireMessage } from '../hooks/useMessages';
import { useVoicePlayer } from '../hooks/useVoicePlayer';
import { useVoiceRecorder, RecordingResult } from '../hooks/useVoiceRecorder';
import { useOutgoingCall } from '../hooks/useOutgoingCall';
import { useNetworkState } from '../hooks/useNetworkState';


import { usePhoneBook } from '../hooks/usePhoneBook';
import { useOtherUserPresence } from '../hooks/usePresence';
import { fetchUserPrivacySettings } from '../hooks/usePrivacySettings';
import { useContacts, AppContact } from '../hooks/useContacts';

import { uploadVoiceNote, UploadProgress } from '../utils/voiceNoteStorage';
import { sendVoiceMessage, sendImageMessage, sendFileMessage, sendVideoMessage, sendOrderMessage, sendContactMessage, sendContactsMessage, sendPollMessage, votePollOption, getOrCreateDirectChat } from '../hooks/useChatActions';
import { parseSystemMessage } from '../utils/systemMessageParser';
import { normalizePhone } from '../utils/phoneUtils';
import { getDateLabel, groupMessagesByDate } from '../utils/dateUtils';
import { useTypingIndicator } from '../hooks/useTypingIndicator';
import { TypingIndicator } from '../components/TypingIndicator';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList, INDUSTRY_CATEGORIES } from '../types';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useCart } from '../context/CartContext';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
// NEW: profile-view tracking for the live dashboard analytics.
import { trackProfileView } from '../utils/trackProfileView';
import { muteStore } from '../state/muteStore';
import { socketClient } from '../realtime/socket';
import IdentityVerificationBadge from '../components/IdentityVerificationBadge';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Chat'>;
type RoutePropType = RouteProp<RootStackParamList, 'Chat'>;

// ── Constants ────────────────────────────────────────────────────────────────
const CANCEL_THRESHOLD_DP = 50;
const MAX_UPLOAD_RETRIES = 3;
const PERMISSION_MESSAGE_DURATION_MS = 3000;
const MUTE_STORAGE_KEY_PREFIX = 'chat_mute_';
const BUSINESS_LINK_BASE = 'https://www.chitchatbusiness.com';

// Common emoji picks
const EMOJI_LIST = [
  '😀', '😂', '😍', '🥰', '😎', '😢', '😡', '👍', '👎', '❤️',
  '🔥', '🎉', '🙏', '💯', '✅', '🤣', '😅', '🤔', '👀', '💪',
  '🥳', '😭', '🫡', '💀', '🤯', '🫶', '😴', '🤩', '😏', '🙈',
];

// ── Group Member Interface ────────────────────────────────────────────────────
interface GroupMember {
  userId: string;
  displayName: string;
  photoURL: string | null;
  status: 'online' | 'away' | 'offline';
}

interface PendingMediaItem {
  uri: string;
  kind: 'image' | 'video';
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string | null;
}

interface MediaUploadJob extends PendingMediaItem {
  clientId: string;
  caption: string | null;
}

function createMediaClientId(index: number): string {
  return `media_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Past Member Interface ──────────────────────────────────────────────────────
interface PastMember {
  userId: string;
  displayName: string;
  photoURL: string | null;
  leftAt: Date;
}

// ── Business Profile Interface ────────────────────────────────────────────────
interface DaySchedule { open: string; close: string; }
interface BusinessAddress {
  street:     string;
  city:       string;
  province:   string;
  postalCode: string;
  country:    string;
}
interface BusinessProfileData {
  email:        string;
  website:      string;
  phone:        string;
  workSchedule: Record<string, DaySchedule>;
  catalogCount:     number;
  collectionsCount: number;
  description:  string;
  industry:     string;
  address:      BusinessAddress | null;
  identityVerified: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract up to 2-char initials from a display name */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Format a Date to a short time string like "14:32" */
function formatTime(date: Date | null): string {
  if (!date) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Format a past member's left date to "Left [date]" */
function formatLeftDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `Left today`;
  } else if (diffDays === 1) {
    return `Left yesterday`;
  } else if (diffDays < 7) {
    return `Left ${diffDays} days ago`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `Left ${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`;
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `Left ${months} ${months === 1 ? 'month' : 'months'} ago`;
  } else {
    return `Left ${date.toLocaleDateString([], { year: 'numeric', month: 'short' })}`;
  }
}

/** Determine message tick status */
type TickStatus = 'sent' | 'delivered' | 'read';
function getTickStatus(
  message: FireMessage,
  currentUserId: string | null,
  isGroup: boolean
): TickStatus {
  // Only show ticks for outgoing messages
  if (message.senderId !== currentUserId) return 'read';

  const deliveredTo = message.deliveredTo || [];
  const readBy = message.readBy || [];

  // Remove sender from counts
  const deliveredCount = deliveredTo.filter(id => id !== currentUserId).length;
  const readCount = readBy.filter(id => id !== currentUserId).length;

  // For direct chats
  if (!isGroup) {
    if (readCount > 0) return 'read';
    if (deliveredCount > 0) return 'delivered';
    return 'sent';
  }

  // For group chats - any member read = blue ticks
  if (readCount > 0) return 'read';
  // All members delivered = grey double tick
  if (deliveredCount > 0) return 'delivered';
  // Otherwise single tick
  return 'sent';
}

/** Get tick icon and color based on status */
function getTickIcon(status: TickStatus): {
  icon: 'checkmark' | 'checkmark-done';
  color: string;
} {
  switch (status) {
    case 'sent':
      return { icon: 'checkmark', color: COLORS.sub };
    case 'delivered':
      return { icon: 'checkmark-done', color: COLORS.sub };
    case 'read':
      return { icon: 'checkmark-done', color: COLORS.blue };
  }
}

/** iOS media-library asset URIs can carry a "#<base64>" fragment (e.g. IMG_0007.MOV#YnBsaXN0...)
 *  which makes Firebase Storage putFile report "file-not-found" and pollutes the
 *  object name / extension. Always strip it from file:// URIs. */
function stripFragment(uri: string): string {
  return uri.startsWith('file://') ? uri.split('#')[0] : uri;
}

/** Return { ok, size } describing whether a file:// URI points at a real,
 *  non-empty file on disk. Firebase Storage's putFile() on iOS reports
 *  storage/unknown when it's handed an empty or missing file, so we verify
 *  every candidate before upload. */
async function isFileReadable(uri: string): Promise<{ ok: boolean; size: number }> {
  try {
    if (!uri || !uri.startsWith('file://')) return { ok: false, size: 0 };
    const info: any = await FileSystem.getInfoAsync(uri);
    if (!info || !info.exists) return { ok: false, size: 0 };
    const size = typeof info.size === 'number' ? info.size : 0;
    return { ok: size > 0, size };
  } catch (err) {
    console.warn('[isFileReadable] getInfoAsync failed:', err);
    return { ok: false, size: 0 };
  }
}

/** Copy picked/captured/library media into the app's cache folder so uploads
 *  always read a clean, sandboxed path instead of a raw Photos-library path.
 *
 *  iOS note: `expo-file-system`'s copyAsync can silently produce a zero-byte
 *  destination file when the source is a Photos-library cached asset (which
 *  is exactly what MediaLibrary.getAssetInfoAsync().localUri returns). We
 *  therefore verify the result and, if it's empty/missing, re-write the bytes
 *  via a base64 read → write round-trip (which does not rely on native
 *  file-to-file copy and works reliably in every case). */
async function toUploadableUri(uri: string, kind: 'image' | 'video'): Promise<string> {
  const clean = stripFragment(uri);
  if (!clean) throw new Error('toUploadableUri: empty URI after stripFragment');

  // Already in our cache and non-empty? Use it as-is.
  if (FileSystem.cacheDirectory && clean.startsWith(FileSystem.cacheDirectory)) {
    const existing = await isFileReadable(clean);
    if (existing.ok) return clean;
    console.warn('[toUploadableUri] cache file is empty, re-copying:', clean);
  }

  const ext =
    clean.split('?')[0].match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() ??
    (kind === 'video' ? 'mp4' : 'jpg');
  const dest = `${FileSystem.cacheDirectory}upload_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}.${ext}`;

  // Attempt #1: native copyAsync (fast, low memory).
  try {
    await FileSystem.copyAsync({ from: clean, to: dest });
    const check = await isFileReadable(dest);
    if (check.ok) {
      console.log('[toUploadableUri] copyAsync OK →', dest, 'size=', check.size);
      return dest;
    }
    console.warn('[toUploadableUri] copyAsync produced empty file (size=' + check.size + '), retrying with base64');
  } catch (err) {
    console.warn('[toUploadableUri] copyAsync threw, retrying with base64:', err);
  }

  // Attempt #2: base64 read → write. Reliable on iOS for Photos-library assets.
  const base64 = await FileSystem.readAsStringAsync(clean, {
    encoding: FileSystem.EncodingType.Base64,
  });
  if (!base64 || base64.length === 0) {
    throw new Error('toUploadableUri: source file could not be read (empty base64)');
  }
  await FileSystem.writeAsStringAsync(dest, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  const finalCheck = await isFileReadable(dest);
  if (!finalCheck.ok) {
    throw new Error(
      `toUploadableUri: base64 fallback produced invalid file (size=${finalCheck.size})`,
    );
  }
  console.log('[toUploadableUri] base64 fallback OK →', dest, 'size=', finalCheck.size);
  return dest;
}

/** Load muted state from AsyncStorage */
async function loadMutedState(chatId: string): Promise<boolean> {
  try {
    const key = `${MUTE_STORAGE_KEY_PREFIX}${chatId}`;
    const value = await AsyncStorage.getItem(key);
    return value === 'true';
  } catch (error) {
    console.error('[ChatScreen] Failed to load muted state:', error);
    return false;
  }
}

/** Save muted state to AsyncStorage (local UI) and the backend (so push
 *  notifications are skipped for this user on this chat). `mutedUntil` is the
 *  ISO instant the mute lapses, or null for an indefinite ("Always") mute. */
async function saveMutedState(
  chatId: string,
  muted: boolean,
  ownerUid?: string | null,
  mutedUntil: string | null = null,
): Promise<void> {
  try {
    const key = `${MUTE_STORAGE_KEY_PREFIX}${chatId}`;
    await AsyncStorage.setItem(key, muted.toString());
  } catch (error) {
    console.error('[ChatScreen] Failed to save muted state:', error);
  }
  // Silence the in-app notification path immediately for this chat.
  if (muted) muteStore.mute(chatId, mutedUntil);
  else muteStore.unmute(chatId);
  if (ownerUid) {
    try {
      await endpoints.setChatMuted(chatId, muted, muted ? mutedUntil : null);
    } catch (error) {
      console.warn('[ChatScreen] Failed to sync muted state to backend:', error);
    }
  }
}

/** Convert a "9:00 AM" string into minutes since midnight. */
function timeToMinutes(t: string): number {
  if (!t || t === 'Closed') return -1;
  const m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return -1;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === 'PM' && h < 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

/** Returns true if the business is open right now, given a work schedule map. */
function isCurrentlyOpen(schedule?: Record<string, DaySchedule>): boolean {
  if (!schedule) return false;
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const now = new Date();
  const today = DAYS[now.getDay()];
  const s = schedule[today];
  if (!s || s.open === 'Closed') return false;
  const openMin = timeToMinutes(s.open);
  const closeMin = timeToMinutes(s.close);
  if (openMin < 0 || closeMin < 0) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= openMin && cur < closeMin;
}

/** Today's hours label, e.g. "9:00 AM – 5:00 PM" or "Closed today". */
function getTodayHoursLabel(schedule?: Record<string, DaySchedule>): string {
  if (!schedule) return 'Hours not set';
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const now = new Date();
  const today = DAYS[now.getDay()];
  const s = schedule[today];
  if (!s || s.open === 'Closed') return 'Closed today';
  return `${s.open} – ${s.close}`;
}

/** Weekday-ordered list of { day, text, isClosed } rows for the work hours block. */
function getWorkHoursSummary(schedule?: Record<string, DaySchedule>) {
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  return DAYS.map((day) => {
    const s = schedule?.[day];
    if (!s || s.open === 'Closed') {
      return { day, text: 'Closed', isClosed: true };
    }
    return { day, text: `${s.open} – ${s.close}`, isClosed: false };
  });
}

// ─── Add Contact Sheet ────────────────────────────────────────────────────────
// Lets the user save an unsaved chat partner. First/last name fields plus a
// "Sync to phone" switch that, when on, also writes to the device address book.
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

  // Seed the name fields when the sheet opens. In edit mode, use the existing
  // saved contact name; otherwise fall back to the suggested display name.
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

        // When editing, remove the existing device entries for this number first
        // so we don't create duplicates.
        if (isEditing) {
          const normalized = normalizePhone(phone);
          const { data } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.PhoneNumbers] });
          await Promise.all(
            data
              .filter((c: any) => (c.phoneNumbers ?? []).some((pn: any) => normalizePhone(pn.number ?? '') === normalized))
              .map((c: any) => c.id ? Contacts.removeContactAsync(c.id) : Promise.resolve())
          );
        }

        // Only write a new device entry when sync is on (edit always keeps it on disk)
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
      <Pressable style={addContactStyles.overlay} onPress={onClose} />
      <View style={[addContactStyles.sheet, { backgroundColor: FG.glassBg, borderColor: FG.glassBorder }]}>
        <AppBg />
        <View style={addContactStyles.handle} />

        <View style={addContactStyles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <AppIcon name="close" size={22} color={COLORS.sub} />
          </TouchableOpacity>
          <AppText style={[addContactStyles.title, { color: textColor }]}>{isEditing ? 'Edit Contact' : 'New Contact'}</AppText>
          <TouchableOpacity onPress={handleSave} disabled={!firstName.trim() || saving} activeOpacity={0.85}>
            {saving
              ? <ActivityIndicator size="small" color={COLORS.blue} />
              : <AppText style={[addContactStyles.save, { opacity: firstName.trim() ? 1 : 0.4 }]}>Save</AppText>}
          </TouchableOpacity>
        </View>

        <View style={{ paddingHorizontal: 18, gap: 12 }}>
          <View style={[addContactStyles.input, bevel]}>
            <AppIcon name="person-outline" size={18} color={COLORS.sub} />
            <TextInput
              style={[addContactStyles.inputField, { color: textColor }]}
              placeholder="First name"
              placeholderTextColor={COLORS.sub}
              value={firstName}
              onChangeText={setFirstName}
              autoFocus
            />
          </View>

          <View style={[addContactStyles.input, bevel]}>
            <AppIcon name="person-outline" size={18} color={COLORS.sub} />
            <TextInput
              style={[addContactStyles.inputField, { color: textColor }]}
              placeholder="Last name"
              placeholderTextColor={COLORS.sub}
              value={lastName}
              onChangeText={setLastName}
            />
          </View>

          <View style={[addContactStyles.input, bevel]}>
            <AppIcon name="call-outline" size={18} color={COLORS.sub} />
            <AppText style={[addContactStyles.inputField, { color: FG.secondary }]}>{phone}</AppText>
          </View>

          <View style={[addContactStyles.switchRow, bevel]}>
            <View style={{ flex: 1 }}>
              <AppText style={[addContactStyles.switchLabel, { color: textColor }]}>Sync to phone</AppText>
              <AppText style={[addContactStyles.switchSub, { color: FG.secondary }]}>
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

/** Paused local video preview used while bytes are still uploading. */
function LocalVideoBubblePreview({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (instance: any) => {
    instance.muted = true;
    instance.loop = false;
    instance.currentTime = 0.01;
    instance.pause();
  });

  if (Platform.OS === 'web') {
    return (
      <View style={[styles.videoThumbImage, styles.videoPlaceholder]}>
        <AppIcon name="videocam" size={34} color="#fff" fixedColor />
      </View>
    );
  }

  return (
    <VideoView
      player={player}
      style={styles.videoThumbImage}
      contentFit="cover"
      nativeControls={false}
    />
  );
}

export default function ChatScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RoutePropType>();
  const insets = useSafeAreaInsets();
  const { chatId, displayName: routeDisplayName, isGroup, otherUserId, otherUserPhoto, openProfile: routeOpenProfile, openAddContact: routeOpenAddContact } = route.params;
  // Local, live display name: starts from the route param but updates when the
  // user saves/edits/deletes a contact (so the header reflects it immediately).
  const [displayName, setDisplayName] = useState(routeDisplayName);
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mediaLibraryPermission, requestMediaLibraryPermission] = useMediaLibraryPermissions();

  // ── Auth — get current user ID ──────────────────────────────────
  const { user } = useAuth();
  const userId = user?.uid ?? null;

  // ── Cart ────────────────────────────────────────────────────────
  const { items: cartItems, totalItems, totalPrice, clearCart } = useCart();
  const [cartSheetVisible, setCartSheetVisible] = useState(false);
  // ── Payment flow ──
  const [paymentVisible, setPaymentVisible] = useState(false);
  const [pendingOrder, setPendingOrder] = useState<{
    items: PaymentOrderItem[];
    currency: string;
    total: string | null;
    /** Full order-line items for sendOrderMessage (includes imageObjectKey). */
    orderItems: { id: string; name: string; price: string; imageUri: string | null; imageObjectKey?: string | null; quantity: number }[];
  } | null>(null);

  // ── Seller catalog (loaded on mount for 1-on-1 chats) ──
  const [sellerCatalog,      setSellerCatalog]      = useState<import('../types').CatalogItem[]>([]);
  const [sellerCollections,  setSellerCollections]  = useState<import('../types').CatalogCollection[]>([]);
  const [loadingCatalog,     setLoadingCatalog]     = useState(false);
  // Full business profile data (contact + hours) for the profile sheet + QR share
  const [businessProfile,    setBusinessProfile]    = useState<BusinessProfileData | null>(null);
  // QR share sheet visibility
  const [qrShareVisible,     setQrShareVisible]     = useState(false);
  // which collection is expanded inside the profile sheet (null = all collapsed)
  const [expandedProfileCol, setExpandedProfileCol] = useState<string | null>(null);
  // catalog full-screen sheet
  const [catalogSheetVisible, setCatalogSheetVisible] = useState(false);
  const [activeCatalogCol,    setActiveCatalogCol]    = useState<string | null>(null); // 'all' | colId

  // ── Messages — real-time Firestore stream ───────────────────────
  const {
    messages,
    loading,
    sendMessage,
    clearMessages,
    deleteMessage,
    addOptimisticMessage,
    updateOptimisticMessage,
    reconcileBackendMessage,
    retryPendingMessage,
  } = useMessages(chatId, userId);

  // ── Network state ────────────────────────────────────────────────
  const { isOnline: deviceOnline } = useNetworkState();

  // ── Filter out blocked messages for recipient ───────────────────
  // If I receive a message that was sent while I was blocked, don't show it
  // Exception: In group chats, show all messages regardless of block status
  const filteredMessages = useMemo(() => {
    // In group chats, show all messages (blocking doesn't affect group messages)
    if (isGroup) {
      return messages;
    }

    // In 1-on-1 chats, filter out blocked messages for recipient
    return messages.filter(msg => {
      // If message has blockedMessage flag and I'm the recipient, hide it
      if (msg.blockedMessage && msg.senderId !== userId) {
        return false;
      }
      return true;
    });
  }, [messages, userId, isGroup]);

  // ── Group messages by date with separators ──────────────────────
  // This creates a flat list of messages with date separator items inserted
  // whenever messages cross a calendar day boundary
  type MessageListItem =
    | { type: 'message'; data: FireMessage }
    | { type: 'dateSeparator'; dateLabel: string; date: Date }
    | { type: 'unreadDivider' };

  const messagesWithDates = useMemo((): MessageListItem[] => {
    if (filteredMessages.length === 0) return [];

    // Find the first message the current user hasn't read (and didn't send).
    // We'll insert an "Unread messages" divider just before it.
    const firstUnreadIndex = filteredMessages.findIndex(
      (m) => m.senderId !== userId && !(m.readBy ?? []).includes(userId ?? ''),
    );

    const items: MessageListItem[] = [];
    let currentDateLabel: string | null = null;
    let dividerInserted = false;

    filteredMessages.forEach((message, msgIndex) => {
      // Insert the unread divider just before the first unread message
      if (!dividerInserted && firstUnreadIndex !== -1 && msgIndex === firstUnreadIndex) {
        items.push({ type: 'unreadDivider' });
        dividerInserted = true;
      }

      if (!message.timestamp) {
        items.push({ type: 'message', data: message });
        return;
      }

      const messageDate = message.timestamp instanceof Date
        ? message.timestamp
        : new Date(message.timestamp);

      if (isNaN(messageDate.getTime())) {
        items.push({ type: 'message', data: message });
        return;
      }

      const dateLabel = getDateLabel(messageDate, 'long');

      if (dateLabel !== currentDateLabel) {
        items.push({ type: 'dateSeparator', dateLabel, date: messageDate });
        currentDateLabel = dateLabel;
      }

      items.push({ type: 'message', data: message });
    });

    return items;
  }, [filteredMessages, userId]);

  // ── Voice player — single-active-player management ─────────────
  const player = useVoicePlayer();

  // ── Typing presence ────────────────────────────────────────────
  const { typingUsers, setTyping } = useTypingIndicator(chatId, userId);

  // ── Voice recorder ─────────────────────────────────────────────
  const recorder = useVoiceRecorder();

  // ── Outgoing call ──────────────────────────────────────────────
  const outgoingCall = useOutgoingCall();



  // ── Phone book name resolver (saved contact name, else phone number) ──
  const { resolveName, contactsMap, reloadPhoneBook } = usePhoneBook();

  /** Resolve a senderId to the name shown in reply previews / reply bubbles. */
  const resolveSenderName = (senderId: string): string => {
    if (senderId === userId) return 'You';
    // For 1-on-1 chats the other person's name is already phone-book-resolved
    // and available as the `displayName` route param.
    if (!isGroup) return displayName;
    // For group chats, look up from the already-resolved groupMembers list.
    const member = groupMembers.find((m) => m.userId === senderId);
    return member?.displayName ?? displayName;
  };

  // ── Presence: watch other user's status ──────────────────────────────────
  // useWritePresence is NOT called here — it lives at the app root in
  // AuthContext so it tracks the full app lifecycle, not just this screen.
  // Calling it here caused online:false to fire whenever the user navigated
  // away from ChatScreen (e.g. to Calls or Updates) — still inside the app.
  // viewerIsContact: true by default — chats only exist between contacts.
  const { statusText: presenceText, isOnline, photoURL: livePhotoURL } = useOtherUserPresence(
    isGroup ? null : otherUserId ?? null,
    isGroup,
    true, // they're in your contacts if you have a chat with them
  );
  // The photo to display for the other user: the live, privacy-filtered value
  // once loaded, otherwise the value passed via navigation params.
  const headerPhoto = isGroup
    ? otherUserPhoto
    : (livePhotoURL === undefined ? otherUserPhoto : livePhotoURL);

  // ── Contacts (for share contact feature) ──────────────────────────────────
  const {
    contacts: phoneContacts,
    loading: contactsLoading,
    hasPermission: contactsPermission,
    error: contactsError,
    reload: reloadContacts,
  } = useContacts();

  // The other user's phone number (from their Firestore profile) and whether it
  // is already saved in this device's address book.
  // Prefer the business profile's phone; fall back to a phone fetched up front
  // from the other user's doc (so "Add to Contacts" works even before the full
  // business profile loads, or for users with no business profile).
  const [resolvedPhone, setResolvedPhone] = useState('');
  // Lets the user dismiss the "Add contact" banner for this chat ("Not now").
  const [addContactBannerDismissed, setAddContactBannerDismissed] = useState(false);
  // Some (legacy/synthetic) chats store the other member as a phone number
  // rather than a Firebase UID. In that case `otherUserId` IS the phone, so use
  // it directly as a last-resort source for the phone number.
  const otherUserIdPhone = otherUserId && otherUserId.startsWith('+') ? otherUserId : '';
  const otherUserPhone = businessProfile?.phone || resolvedPhone || otherUserIdPhone || '';
  const savedContactName = useMemo(() => {
    if (isGroup || !otherUserPhone) return null;
    return contactsMap.get(normalizePhone(otherUserPhone)) ?? null;
  }, [isGroup, otherUserPhone, contactsMap]);
  const isUnsavedContact = !isGroup && !!otherUserPhone && !savedContactName;

  // Keep the header name in sync with the phone book: show the saved contact
  // name if present, otherwise fall back to the phone number.
  useEffect(() => {
    if (isGroup || !otherUserPhone) return;
    setDisplayName(savedContactName ?? otherUserPhone);
  }, [savedContactName, otherUserPhone, isGroup]);

  // Early header name resolver. The sync effect above only runs once the full
  // business profile has loaded (which can be slow or absent). This fetches
  // just the other user's phone number up front so the header shows the saved
  // contact name (or the phone number) immediately instead of an empty "…".
  useEffect(() => {
    if (isGroup || !otherUserId) return;
    // If we already have a non-empty name from the route param, keep it until
    // the phone book / profile resolves — but still fetch so an empty name
    // (common on fresh navigation) gets filled in right away.
    let cancelled = false;
    (async () => {
      try {
        const res = await endpoints.getUser(otherUserId);
        if (cancelled || !res.ok) return;
        const phone: string = res.data.phoneNumber || '';
        if (!phone) return;
        if (!cancelled) setResolvedPhone(phone);
        const resolved = resolveName(normalizePhone(phone), phone);
        if (!cancelled && resolved) setDisplayName(resolved);
      } catch (err) {
        console.warn('[ChatScreen] Failed to resolve header name:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [isGroup, otherUserId, resolveName]);

  // Name shown in the header. Falls back gracefully so it never renders an
  // empty value or a lone placeholder while the real name is still resolving.
  const headerName = (displayName && displayName.trim() && displayName.trim() !== '…')
    ? displayName
    : (otherUserPhone || (isGroup ? 'Group' : 'Chat'));



  const [input, setInput] = useState('');
  const isSendingRef = useRef(false);
  const [isSending, setIsSending] = useState(false);
  const [editingMessage, setEditingMessage] = useState<any | null>(null);
  const listRef = useRef<FlatList>(null);
  const [showScrollBtn, setShowScrollBtn]   = useState(false);
  const scrollBtnOpacity                    = useRef(new Animated.Value(0)).current;
  const distanceFromBottomRef               = useRef(0);

  // Show the scroll-to-bottom button whenever the user is more than 150px
  // away from the newest message. Animate it in/out smoothly.
  const SCROLL_THRESHOLD = 150;
  const handleScroll = useCallback((e: any) => {
    const { contentSize, layoutMeasurement, contentOffset } = e.nativeEvent;
    const dist = contentSize.height - layoutMeasurement.height - contentOffset.y;
    distanceFromBottomRef.current = dist;
    const shouldShow = dist > SCROLL_THRESHOLD;
    setShowScrollBtn((prev) => {
      if (prev !== shouldShow) {
        Animated.timing(scrollBtnOpacity, {
          toValue: shouldShow ? 1 : 0,
          duration: 200,
          useNativeDriver: true,
        }).start();
      }
      return shouldShow;
    });
  }, [scrollBtnOpacity]);

  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, []);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  // Which way the in-app camera faces. Toggled by the flip button.
  const [cameraFacing, setCameraFacing] = useState<'back' | 'front'>('back');
  // Recent device photos shown as a strip under the live camera (WhatsApp-style).
  const [recentPhotos, setRecentPhotos] = useState<{
    id: string;
    uri: string;
    isVideo?: boolean;
    width?: number;
    height?: number;
  }[]>([]);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [addContactOpen, setAddContactOpen] = useState(false);
  // When saving a *shared* contact (from a contact card), the Add-Contact sheet
  // should use that contact's details, not the chat partner's. Null = use the
  // chat partner (the default "add this chat to contacts" flow).
  const [pendingSaveContact, setPendingSaveContact] = useState<{ phone: string; name: string } | null>(null);

  // Honor deep-link params from the chat-list actions menu
  useEffect(() => {
    if (routeOpenProfile) setProfileModalOpen(true);
    if (routeOpenAddContact) setAddContactOpen(true);
  }, [routeOpenProfile, routeOpenAddContact]);

  // ── Search state ────────────────────────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  // Ordered list of messageIds that match the current query (oldest → newest).
  const [searchMatchIds, setSearchMatchIds] = useState<string[]>([]);
  // Index within searchMatchIds of the currently "active" (navigated-to) match.
  const [searchCurrentIndex, setSearchCurrentIndex] = useState(0);
  // The message ID currently being highlighted after a search-result tap.
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightAnim = useRef(new Animated.Value(0)).current;
  const searchInputRef = useRef<TextInput>(null);

  // ── Group members state ─────────────────────────────────────────
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);

  // Resolve typing user display names (depends on groupMembers)
  const typingNames = useMemo(() => {
    return typingUsers.map(({ userId: uid }) => {
      if (!isGroup) return displayName;
      const member = groupMembers.find((m) => m.userId === uid);
      return member?.displayName ?? 'Someone';
    });
  }, [typingUsers, isGroup, displayName, groupMembers]);

  // ── Past members state ──────────────────────────────────────────
  const [pastMembers, setPastMembers] = useState<PastMember[]>([]);
  const [loadingPastMembers, setLoadingPastMembers] = useState(false);

  // ── Block contact state ─────────────────────────────────────────
  const [isBlocked, setIsBlocked] = useState(false);
  const [blockedByMe, setBlockedByMe] = useState(false); // I blocked them
  const [blockedByThem, setBlockedByThem] = useState(false); // They blocked me
  const [checkingBlockedStatus, setCheckingBlockedStatus] = useState(true);
  const [showBlockConfirmation, setShowBlockConfirmation] = useState(false);

  // ── Leave group state ───────────────────────────────────────────
  const [showLeaveGroupConfirmation, setShowLeaveGroupConfirmation] = useState(false);
  const [leavingGroup, setLeavingGroup] = useState(false);

  // ── Upload & retry state ────────────────────────────────────────
  const [uploadProgress, setUploadProgress] = useState<number>(0);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const pendingRecordingRef = useRef<RecordingResult | null>(null);

  // ── Image upload state ──────────────────────────────────────────
  const [uploadingImage, setUploadingImage] = useState(false);
  const [imageUploadProgress, setImageUploadProgress] = useState<number>(0);

  // ── Image viewer state ──────────────────────────────────────────
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerImageUrl, setViewerImageUrl] = useState<string | null>(null);

  // ── Captured/selected media awaiting a caption before sending ────
  // Holds a photo or video the user just captured/picked. We show a preview
  // with a caption field (WhatsApp style) instead of sending immediately.
  const [pendingMedia, setPendingMedia] = useState<PendingMediaItem[] | null>(null);
  const [pendingMediaIndex, setPendingMediaIndex] = useState(0);
  const carouselScrollAnim = useRef(new Animated.Value(0)).current;
  const carouselSwipeStartX = useRef(0);
  const [mediaCaption, setMediaCaption] = useState('');
  const mediaSendInFlightRef = useRef(false);
  const activeMediaUploadsRef = useRef(new Set<string>());

  // ── Full-screen video viewer ─────────────────────────────────────
  const [videoViewerUrl, setVideoViewerUrl] = useState<string | null>(null);

  // ── Selected message state (for long-press actions) ────────────
  // Multi-select (WhatsApp style): long-press enters selection mode, then
  // tapping messages toggles them. `selectedIds` holds all selected message ids.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const selectionMode = selectedIds.length > 0;
  // Convenience single-selection id (for actions that only apply to one message)
  const selectedMessageId = selectedIds.length === 1 ? selectedIds[0] : null;
  const showMessageActions = selectionMode;

  // ── Reply state ─────────────────────────────────────────────────
  const [replyingTo, setReplyingTo] = useState<FireMessage | null>(null);

  // ── Forward state ───────────────────────────────────────────────
  const [forwardModalVisible, setForwardModalVisible] = useState(false);
  const [messagesToForward, setMessagesToForward] = useState<FireMessage[]>([]);

  // ── Message info state ──────────────────────────────────────────
  const [messageInfoVisible, setMessageInfoVisible] = useState(false);
  const [messageForInfo, setMessageForInfo] = useState<FireMessage | null>(null);

  // ── Contact picker state (share contact via 3-dot menu) ─────────
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState('');

  // ── Poll composer state ─────────────────────────────────────────
  const [pollModalOpen, setPollModalOpen] = useState(false);

  // ── Multi-select for the share-contact picker ───────────────────
  // Keyed by `userId || phone` (the same key used for list rows).
  const [selectedContactKeys, setSelectedContactKeys] = useState<string[]>([]);

  // Debug log for contacts
  useEffect(() => {
    if (contactPickerOpen) {
      console.log('[ChatScreen] Contact picker opened. Contacts:', phoneContacts?.length ?? 0, 'Loading:', contactsLoading, 'Permission:', contactsPermission);
    }
  }, [contactPickerOpen, phoneContacts, contactsLoading, contactsPermission]);

  // ── Camera ref ──────────────────────────────────────────────────
  const cameraRef = useRef<any>(null);

  // ── Video players (preview + full-screen viewer) ─────────────────
  // Created once; the source is swapped via player.replace() when the
  // relevant URL changes (same pattern as StatusViewer).
  const previewVideoPlayer = useVideoPlayer(null, (p: any) => { p.loop = true; });
  const viewerVideoPlayer  = useVideoPlayer(null, (p: any) => { p.loop = false; });

  useEffect(() => {
    if (pendingMedia && pendingMedia.length > 0 && pendingMedia[pendingMediaIndex]?.kind === 'video') {
      try { 
        previewVideoPlayer.replace(pendingMedia[pendingMediaIndex].uri); 
        previewVideoPlayer.play(); 
      } catch {}
    } else {
      try { previewVideoPlayer.pause(); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMedia, pendingMediaIndex]);

  useEffect(() => {
    if (videoViewerUrl) {
      try { viewerVideoPlayer.replace(videoViewerUrl); viewerVideoPlayer.play(); } catch {}
    } else {
      try { viewerVideoPlayer.pause(); } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoViewerUrl]);

  // ── Permission message state ────────────────────────────────────
  const [permissionMessage, setPermissionMessage] = useState<string | null>(null);
  const [showSettingsButton, setShowSettingsButton] = useState(false);
  const permissionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Track if recording was cancelled via gesture ─────────────────
  const isCancelledRef = useRef(false);

  // ── Load muted state from AsyncStorage on mount ─────────────────
  useEffect(() => {
    let isMounted = true;

    const loadMuted = async () => {
      const savedMuted = await loadMutedState(chatId);
      if (isMounted) {
        setMuted(savedMuted);
      }
    };

    loadMuted();

    return () => {
      isMounted = false;
    };
  }, [chatId]);

  // ── Track profile view when the profile modal opens (1-on-1 only) ──
  // Fires trackProfileView() once per viewer per day, using AsyncStorage as
  // a debounce so repeated taps don't inflate the counter. Feeds the live
  // dashboard analytics.
  useEffect(() => {
    if (!profileModalOpen) return;
    if (isGroup) return;
    if (!otherUserId) return;
    if (!userId) return;
    if (userId === otherUserId) return;

    const dayKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const storageKey = `pv_${otherUserId}_${dayKey}`;

    (async () => {
      try {
        const already = await AsyncStorage.getItem(storageKey);
        if (already) return;
        // Set the key AFTER a successful write so a failure allows a retry
        await trackProfileView(otherUserId);
        await AsyncStorage.setItem(storageKey, '1');
      } catch (err) {
        console.warn('[ChatScreen] trackProfileView failed:', err);
      }
    })();
  }, [profileModalOpen, isGroup, otherUserId, userId]);

  // ── Fetch group members when profile modal opens ────────────────
  useEffect(() => {
    if (!profileModalOpen || !isGroup || !chatId) return;

    const fetchGroupMembers = async () => {
      setLoadingMembers(true);
      try {
        console.log('[ChatScreen] Fetching group members for chat:', chatId);

        // There is no single "get chat" endpoint; derive member IDs from the
        // chat list.
        const chatsRes = await endpoints.listChats();
        const thisChat = chatsRes.ok ? chatsRes.data.chats.find((c) => c.chatId === chatId) : null;
        const memberIds = thisChat?.members ?? [];

        console.log('[ChatScreen] Found member IDs:', memberIds);

        if (memberIds.length === 0) {
          setGroupMembers([]);
          setLoadingMembers(false);
          return;
        }

        // Fetch each member's public profile.
        const memberPromises = memberIds.map(async (memberId) => {
          try {
            const res = await endpoints.getUser(memberId);
            if (res.ok) {
              const userData = res.data;
              const photoURL = userData.avatarObjectKey
                ? await mediaService.getDownloadUrl(userData.avatarObjectKey)
                : null;
              return {
                userId: memberId,
                displayName: userData.displayName || resolveName(userData.phoneNumber || '', 'Unknown'),
                photoURL,
                // Live presence is tracked separately; default here.
                status: 'offline',
              } as GroupMember;
            }

            // Fallback for users without profile data
            return {
              userId: memberId,
              displayName: 'Unknown User',
              photoURL: null,
              status: 'offline',
            } as GroupMember;
          } catch (error) {
            console.error('[ChatScreen] Error fetching user:', memberId, error);
            return {
              userId: memberId,
              displayName: 'Unknown User',
              photoURL: null,
              status: 'offline',
            } as GroupMember;
          }
        });

        const members = await Promise.all(memberPromises);
        console.log('[ChatScreen] Fetched group members:', members.length);
        setGroupMembers(members);
      } catch (error) {
        console.error('[ChatScreen] Error fetching group members:', error);
        setGroupMembers([]);
      } finally {
        setLoadingMembers(false);
      }
    };

    fetchGroupMembers();
  }, [profileModalOpen, isGroup, chatId]);

  // ── Fetch past members when profile modal opens ─────────────────
  useEffect(() => {
    if (!profileModalOpen || !isGroup || !chatId) return;

    const fetchPastMembers = async () => {
      setLoadingPastMembers(true);
      try {
        // TODO(no-backend): the former chats/{id}.pastMembers array (members who
        // left the group, with a leftAt timestamp) has no REST equivalent yet.
        // The "Past members" section of the profile sheet is preserved and
        // renders empty until a backend source exists. No feature is removed —
        // only its (currently non-existent) data source.
        setPastMembers([]);
      } catch (error) {
        console.error('[ChatScreen] Error fetching past members:', error);
        setPastMembers([]);
      } finally {
        setLoadingPastMembers(false);
      }
    };

    fetchPastMembers();
  }, [profileModalOpen, isGroup, chatId]);

  // ── Load seller catalog + collections (1-on-1 only) ──────────────
  // IMPORTANT: Loads on mount (not just when the profile modal opens) so
  // that the header catalog button and profile catalog entry both have data.
  // Also loads business contact + work hours for the profile sheet and QR.
  useEffect(() => {
    if (isGroup || !otherUserId) {
      setSellerCatalog([]);
      setSellerCollections([]);
      setBusinessProfile(null);
      setLoadingCatalog(false);
      return;
    }
    let cancelled = false;
    setLoadingCatalog(true);
    (async () => {
      try {
        // The public /users/:id surface returns the target's business profile,
        // including their catalog items/collections (image fields hold media
        // OBJECT KEYS) and hours/address. Fetch it, resolve the product images
        // to short-lived download URLs, and populate the catalog + profile sheet.
        const res = await endpoints.getUser(otherUserId);
        if (res.ok && !cancelled) {
          const data = res.data;
          const items: import('../types').CatalogItem[] = (data.catalogItems ?? []).map((i) => ({
            id:              String(i.id),
            name:            i.name,
            price:           i.price,
            description:     i.description ?? undefined,
            // Keep the durable object key separate from the temporary URL that
            // will replace imageUri for display below. Cart/order payloads must
            // use the key; presigned HTTPS URLs expire and cannot be uploaded.
            imageObjectKey:  i.imageUri ?? null,
            imageUri:        i.imageUri ?? null,
            collectionId:    i.collectionId ?? null,
          }));
          const cols: import('../types').CatalogCollection[] = (data.catalogCollections ?? []).map((c) => ({
            id:        String(c.id),
            name:      c.name,
            emoji:     c.emoji ?? null,
            createdAt: c.createdAt ?? 0,
          }));

          // Catalog images are stored as object keys; resolve them to URLs the
          // <Image> components can render. Unresolved keys fall back to a
          // placeholder rather than a broken image.
          const keys = items.map((i) => i.imageUri).filter((k): k is string => !!k);
          let urls: Record<string, string> = {};
          if (keys.length > 0) {
            try { urls = await mediaService.getDownloadUrls(keys); } catch { /* leave keys unresolved */ }
          }
          if (cancelled) return;
          const resolvedItems = items.map((i) => ({
            ...i,
            imageUri: i.imageUri ? (urls[i.imageUri] ?? null) : null,
          }));

          setSellerCatalog(resolvedItems);
          setSellerCollections(cols);
          setBusinessProfile({
            email:            data.email || '',
            website:          data.website || '',
            phone:            data.phoneNumber || '',
            workSchedule:     data.workSchedule ?? {},
            catalogCount:     resolvedItems.length,
            collectionsCount: cols.length,
            description:      data.about || '',
            industry:         data.industry || '',
            address:          data.address ?? null,
            identityVerified: data.identityVerified === true,
          });
        } else if (!cancelled) {
          setSellerCatalog([]);
          setSellerCollections([]);
          setBusinessProfile(null);
        }
      } catch (err) {
        console.warn('[ChatScreen] Failed to load seller catalog/business profile:', err);
        if (!cancelled) {
          setSellerCatalog([]);
          setSellerCollections([]);
          setBusinessProfile(null);
        }
      } finally {
        if (!cancelled) setLoadingCatalog(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isGroup, otherUserId]);

  // Identity badges are server-owned. Update an open profile immediately when
  // a report or successful re-verification changes the other user's status.
  useEffect(() => {
    if (isGroup || !otherUserId) return;
    const unsubscribe = socketClient.subscribe('user:identity-status', (raw) => {
      const payload = raw as { userId?: string; identityVerified?: boolean } | null;
      if (payload?.userId !== otherUserId || typeof payload.identityVerified !== 'boolean') return;
      setBusinessProfile((current) => current
        ? { ...current, identityVerified: payload.identityVerified! }
        : current);
    });
    return unsubscribe;
  }, [isGroup, otherUserId]);

  // ── Check blocked status ─────────────────────────────────────────
  useEffect(() => {
    if (!userId || !otherUserId || isGroup) {
      setCheckingBlockedStatus(false);
      setIsBlocked(false);
      return;
    }

    const checkBlockedStatus = async () => {
      try {
        console.log('[ChatScreen] Checking if contact is blocked:', otherUserId);

        // Whether *I* blocked them comes from my block list.
        const blocksRes = await endpoints.listBlocks();
        const iBlockedThem = blocksRes.ok
          ? blocksRes.data.blocked.some((b) => b.userId === otherUserId)
          : false;
        // TODO(no-backend): there is no endpoint to learn whether the OTHER user
        // blocked me (the old users/{them}/blockedUsers/{me} read). The backend
        // enforces that server-side on send; we default to false here so the
        // composer stays usable.
        const theyBlockedMe = false;

        setBlockedByMe(iBlockedThem);
        setBlockedByThem(theyBlockedMe);
        setIsBlocked(iBlockedThem || theyBlockedMe);

        console.log('[ChatScreen] Blocked status - by me:', iBlockedThem, ', by them:', theyBlockedMe);
      } catch (error) {
        console.error('[ChatScreen] Error checking blocked status:', error);
        setIsBlocked(false);
        setBlockedByMe(false);
        setBlockedByThem(false);
      } finally {
        setCheckingBlockedStatus(false);
      }
    };

    checkBlockedStatus();
  }, [userId, otherUserId, isGroup]);

  // ── Re-check blocked status when screen comes into focus ────────
  useFocusEffect(
    React.useCallback(() => {
      if (!isGroup && userId && otherUserId) {
        (async () => {
          try {
            const blocksRes = await endpoints.listBlocks();
            const iBlockedThem = blocksRes.ok
              ? blocksRes.data.blocked.some((b) => b.userId === otherUserId)
              : false;
            // TODO(no-backend): "they blocked me" is not queryable; see above.
            const theyBlockedMe = false;

            setBlockedByMe(iBlockedThem);
            setBlockedByThem(theyBlockedMe);
            setIsBlocked(iBlockedThem || theyBlockedMe);
          } catch (error) {
            console.error('[ChatScreen] Error re-checking blocked status:', error);
          }
        })();
      }
    }, [userId, otherUserId, isGroup])
  );

  // ── Stop playback on unmount / navigation away ──────────────────
  useEffect(() => {
    return () => {
      player.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Initial scroll: jump to first unread, fall back to bottom ───────────────
  // On first load we find the first message the current user hasn't read yet
  // (senderId !== me AND !readBy.includes(me)) and scroll there so they see
  // new messages immediately. If everything is read, we scroll to the bottom.
  // After the initial scroll we stop interfering — subsequent new-message
  // scrolling is handled by onContentSizeChange (only when near the bottom).
  const initialScrollDoneRef = useRef(false);

  useEffect(() => {
    if (initialScrollDoneRef.current) return;       // already did the initial scroll
    if (filteredMessages.length === 0) return;       // nothing loaded yet

    initialScrollDoneRef.current = true;

    // Find the index of the first unread message in messagesWithDates
    // (we search filteredMessages then map to the messagesWithDates index).
    const firstUnreadMsg = filteredMessages.find(
      (m) => m.senderId !== userId && !(m.readBy ?? []).includes(userId ?? ''),
    );

    setTimeout(() => {
      if (firstUnreadMsg) {
        // Scroll to the unread divider itself (inserted just before the first
        // unread message) so the banner appears at the top of the viewport.
        const dividerIdx = messagesWithDates.findIndex((item) => item.type === 'unreadDivider');
        const targetIdx = dividerIdx !== -1 ? dividerIdx : messagesWithDates.findIndex(
          (item) => item.type === 'message' && item.data.messageId === firstUnreadMsg.messageId,
        );
        if (targetIdx !== -1 && listRef.current) {
          listRef.current.scrollToIndex({ index: targetIdx, animated: false, viewPosition: 0 });
          return;
        }
      }
      // All read → go to the bottom
      listRef.current?.scrollToEnd({ animated: false });
    }, 100);
  }, [filteredMessages.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Handle permission denied states ─────────────────────────────
  useEffect(() => {
    if (recorder.state.permissionDenied) {
      if (recorder.state.permissionDeniedPermanently) {
        setShowSettingsButton(true);
        setPermissionMessage('Microphone access is required for voice notes. Please enable it in Settings.');
      } else {
        setShowSettingsButton(false);
        setPermissionMessage('Microphone access is required for voice notes.');
        if (permissionTimerRef.current) clearTimeout(permissionTimerRef.current);
        permissionTimerRef.current = setTimeout(() => {
          setPermissionMessage(null);
        }, PERMISSION_MESSAGE_DURATION_MS);
      }
    }

    return () => {
      if (permissionTimerRef.current) clearTimeout(permissionTimerRef.current);
    };
  }, [recorder.state.permissionDenied, recorder.state.permissionDeniedPermanently]);

  // ── Search handler ──────────────────────────────────────────────
  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchMatchIds([]);
      setSearchCurrentIndex(0);
      setHighlightedMessageId(null);
      return;
    }
    const q = query.toLowerCase();
    // Collect matching IDs oldest→newest (messages are already sorted asc).
    const ids = messages
      .filter((m) => m.type === 'text' && m.text?.toLowerCase().includes(q))
      .map((m) => m.messageId);
    setSearchMatchIds(ids);
    // Jump to the most recent match (last index) like WhatsApp.
    const startIdx = ids.length > 0 ? ids.length - 1 : 0;
    setSearchCurrentIndex(startIdx);
    if (ids.length > 0) scrollToAndHighlight(ids[startIdx]);
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Navigate up/down through matches. direction: -1 = up (older), +1 = down (newer). */
  const navigateMatch = useCallback((direction: -1 | 1) => {
    setSearchCurrentIndex((prev) => {
      const next = Math.max(0, Math.min(searchMatchIds.length - 1, prev + direction));
      if (searchMatchIds[next]) scrollToAndHighlight(searchMatchIds[next]);
      return next;
    });
  }, [searchMatchIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollToAndHighlight = (messageId: string) => {
    const index = messages.findIndex(m => m.messageId === messageId);
    if (index !== -1 && listRef.current) {
      listRef.current.scrollToIndex({ index, animated: true, viewPosition: 0.4 });
    }
    setHighlightedMessageId(messageId);
    highlightAnim.setValue(1);
    Animated.timing(highlightAnim, {
      toValue: 0,
      duration: 1500,
      useNativeDriver: true,
    }).start(() => setHighlightedMessageId(null));
  };

  // ── Scroll to message handler ───────────────────────────────────
  const scrollToMessage = useCallback((messageId: string) => {
    scrollToAndHighlight(messageId);
  }, [messages, highlightAnim]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-responder is now handled server-side by the `autoResponder` Cloud Function
  // (functions/src/index.ts). It triggers on every new message document creation,
  // checks the recipient's schedule, and writes the reply using Admin SDK —
  // bypassing the Firestore senderId == auth.uid rule that broke the client-side version.
  const checkAndTriggerAutoResponder = useCallback(async () => { /* no-op: moved to Cloud Function */ }, []);


  // ── Upload and send voice note ──────────────────────────────────
  const handleVoiceUploadAndSend = useCallback(async (result: RecordingResult) => {
    if (!userId) return;

    // Stable client id shared between the optimistic bubble and the outbox.
    const clientId = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    // ── 1. Show an optimistic bubble immediately ─────────────────
    // The bubble appears right as the upload starts so the user always sees
    // their voice note. voiceUrl is set to the local file URI so the waveform
    // renders, and uploadStatus:'uploading' drives the loading indicator.
    addOptimisticMessage({
      messageId: clientId,
      clientId,
      senderId: userId,
      type: 'voice',
      voiceUrl: result.uri,       // local URI — renders the waveform placeholder
      duration: result.durationMs,
      timestamp: new Date(),
      uploadStatus: 'uploading',
      uploadProgress: 0,
    });

    setIsUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    pendingRecordingRef.current = result;

    try {
      const uploadResult = await uploadVoiceNote(
        result.uri,
        chatId,
        clientId,
        (progress: UploadProgress) => {
          setUploadProgress(progress.percentage);
          // Keep the bubble's progress indicator in sync.
          updateOptimisticMessage(clientId, {
            uploadProgress: progress.percentage,
          });
        },
      );

      // ── 2. Upload done — mark as 'sending' while REST call runs ─
      updateOptimisticMessage(clientId, { uploadStatus: 'sending', uploadProgress: 100 });

      const res = await endpoints.sendMessage(chatId, {
        clientId,
        type: 'voice',
        mediaObjectKey: uploadResult.downloadUrl,
        durationMs: result.durationMs,
      });

      if (res.ok) {
        // ── 3. Server confirmed — replace optimistic bubble ────────
        await reconcileBackendMessage(res.data.message);
      } else {
        updateOptimisticMessage(clientId, {
          uploadStatus: 'failed',
          uploadError: 'Failed to send. Tap to retry.',
        }, true);
      }

      setIsUploading(false);
      setUploadProgress(0);
      setRetryCount(0);
      pendingRecordingRef.current = null;
      await checkAndTriggerAutoResponder();
    } catch (error: any) {
      console.error('[ChatScreen] Voice upload failed:', error);
      setIsUploading(false);

      const isNetworkError = error.message === 'UPLOAD_TIMEOUT' ||
        error.code === 'storage/retry-limit-exceeded' ||
        error.code === 'storage/canceled';

      // Flip the bubble to failed so the user sees the error inline.
      updateOptimisticMessage(clientId, {
        uploadStatus: 'failed',
        uploadError: isNetworkError && retryCount < MAX_UPLOAD_RETRIES - 1
          ? 'Upload failed. Tap to retry.'
          : 'Upload could not be completed.',
      }, true);

      if (isNetworkError && retryCount < MAX_UPLOAD_RETRIES - 1) {
        setUploadError('Upload failed. Tap to retry.');
      } else {
        setUploadError('Upload could not be completed.');
        pendingRecordingRef.current = null;
      }
    }
  }, [userId, chatId, retryCount, checkAndTriggerAutoResponder, addOptimisticMessage, updateOptimisticMessage, reconcileBackendMessage]);

  // ── Retry upload handler ────────────────────────────────────────
  const handleRetryUpload = useCallback(() => {
    const pendingResult = pendingRecordingRef.current;
    if (!pendingResult || retryCount >= MAX_UPLOAD_RETRIES) return;

    setRetryCount((prev) => prev + 1);
    setUploadError(null);
    handleVoiceUploadAndSend(pendingResult);
  }, [retryCount, handleVoiceUploadAndSend]);

  // ── Send handler ────────────────────────────────────────────────
  const handleSend = async (text?: string) => {
    if (isSendingRef.current) return; // prevent duplicate sends from rapid taps
    const trimmed = (text ?? input).trim();
    if (!trimmed) return;

    isSendingRef.current = true;
    setIsSending(true);
    setTyping(false);

    try {
      // ── Edit existing message ────────────────────────────────────
      if (editingMessage) {
        await endpoints.editMessage(chatId, editingMessage.messageId, trimmed);
        setEditingMessage(null);
        setInput('');
        setShowEmoji(false);
        return;
      }

      // ── Reply branch ─────────────────────────────────────────────
      if (replyingTo) {
        await endpoints.sendMessage(chatId, {
          type: 'text',
          text: trimmed,
          replyTo: {
            messageId: replyingTo.messageId,
            senderId: replyingTo.senderId,
            text: replyingTo.text,
            type: replyingTo.type,
          },
        });

        setReplyingTo(null);
        setInput('');
        setShowEmoji(false);
        await checkAndTriggerAutoResponder();
      } else {
        // The backend enforces block rules on send; the old client-side
        // "blockedMessage" flag has no server equivalent, so a normal send is
        // used in both cases. useMessages echoes the sent message optimistically.
        const success = await sendMessage(trimmed);
        if (success) {
          setInput('');
          setShowEmoji(false);
          await checkAndTriggerAutoResponder();
        }
      }
    } catch (error) {
      console.error('[ChatScreen] Error sending message:', error);
      Alert.alert('Error', 'Failed to send message');
    } finally {
      isSendingRef.current = false;
      setIsSending(false);
    }
  };

  // ── Message selection and actions ───────────────────────────────
  // Long-press enters selection mode and selects that message
  const handleLongPressMessage = (messageId: string) => {
    setSelectedIds((prev) => (prev.includes(messageId) ? prev : [...prev, messageId]));
    setShowEmoji(false); // Close emoji panel if open
  };

  // While in selection mode, tapping a message toggles it in/out of the selection
  const handleToggleSelectMessage = (messageId: string) => {
    setSelectedIds((prev) =>
      prev.includes(messageId) ? prev.filter((id) => id !== messageId) : [...prev, messageId]
    );
  };

  const handleClearSelection = () => {
    setSelectedIds([]);
  };

  const handleEditMessage = () => {
    if (!selectedMessageId) return;
    const message = messages.find(m => m.messageId === selectedMessageId);
    // Allow editing text, image, and video messages (which can have captions)
    if (message && message.senderId === userId && ['text', 'image', 'video'].includes(message.type)) {
      setEditingMessage(message);
      setInput(message.text ?? '');
      setShowEmoji(false);
      handleClearSelection();
    } else {
      handleClearSelection();
    }
  };

  const handleDeleteMessage = async () => {
    if (selectedIds.length === 0) return;
    const idsToDelete = [...selectedIds];
    const n = idsToDelete.length;

    Alert.alert(
      n === 1 ? 'Delete Message' : 'Delete Messages',
      `Delete ${n === 1 ? 'this message' : `these ${n} messages`} for you? The other person will still see ${n === 1 ? 'it' : 'them'}.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete for me',
          style: 'destructive',
          onPress: async () => {
            handleClearSelection();
            try {
              // Removes from the on-screen list + local cache + Firestore in real time
              await Promise.all(idsToDelete.map((id) => deleteMessage(id)));
            } catch (error) {
              console.error('[ChatScreen] Error deleting messages:', error);
              Alert.alert('Error', 'Failed to delete messages.');
            }
          },
        },
      ]
    );
  };

  const handleReplyMessage = () => {
    if (!selectedMessageId) return;
    const message = messages.find(m => m.messageId === selectedMessageId);
    if (message) {
      setReplyingTo(message);
      handleClearSelection();
    }
  };

  const handleForwardMessage = () => {
    if (selectedIds.length === 0) return;
    // Preserve chat order (oldest → newest) for the forwarded batch.
    // Polls are live, chat-bound objects and are never forwardable.
    const selected = messages.filter((m) => selectedIds.includes(m.messageId) && m.type !== 'poll');
    if (selected.length > 0) {
      setMessagesToForward(selected);
      setForwardModalVisible(true);
      handleClearSelection();
    } else {
      handleClearSelection();
    }
  };

  // Share the selected messages' text via the native share sheet
  const handleShareMessages = async () => {
    if (selectedIds.length === 0) return;
    // Polls are never shareable.
    const selected = messages.filter((m) => selectedIds.includes(m.messageId) && m.type !== 'poll');
    const body = selected
      .map((m) => {
        if (m.text) return m.text;
        switch (m.type) {
          case 'image': return '[Photo]';
          case 'voice': return '[Voice message]';
          case 'video': return '[Video]';
          case 'file':  return `[File] ${m.fileName ?? ''}`.trim();
          case 'location': return '[Location]';
          default: return '';
        }
      })
      .filter(Boolean)
      .join('\n');
    handleClearSelection();
    if (!body) {
      Alert.alert('Nothing to share', 'The selected messages have no shareable text.');
      return;
    }
    try {
      await Share.share({ message: body });
    } catch (err) {
      console.warn('[ChatScreen] Share failed:', err);
    }
  };

  const handleCopyMessage = async () => {
    if (!selectedMessageId) return;
    const message = messages.find(m => m.messageId === selectedMessageId);
    if (message?.text) {
      try {
        // Use React Native's built-in Clipboard (available in react-native)
        const { Clipboard } = await import('react-native');
        Clipboard.setString(message.text);
        console.log('[ChatScreen] Message copied to clipboard');
        Alert.alert('Copied', 'Message copied to clipboard');
        handleClearSelection();
      } catch (error) {
        console.error('[ChatScreen] Error copying message:', error);
        Alert.alert('Error', 'Failed to copy message.');
      }
    }
  };

  const handleShowMessageInfo = () => {
    if (!selectedMessageId) return;
    const message = messages.find(m => m.messageId === selectedMessageId);
    if (message) {
      setMessageForInfo(message);
      setMessageInfoVisible(true);
      handleClearSelection();
    }
  };

  // ── Forward selected messages to selected chats ─────────────────
  const handleForwardToChats = async (selectedChatIds: string[]) => {
    if (messagesToForward.length === 0 || !userId) return;

    const previewFor = (m: FireMessage): string =>
      m.type === 'text'  ? (m.text ?? 'Message')
      : m.type === 'voice' ? '🎤 Voice message'
      : m.type === 'image' ? '📷 Image'
      : m.type === 'video' ? '🎥 Video'
      : m.type === 'file'  ? `📎 ${m.fileName || 'File'}`
      : m.type === 'location' ? '📍 Location'
      : m.type === 'catalog' ? `🛍️ ${m.catalogItem?.name || 'Product'}`
      : m.type === 'order' ? '🛒 Order'
      : m.type === 'contact' ? `👤 ${m.contact?.name || 'Contact'}`
      : m.type === 'poll' ? `📊 ${m.poll?.question || 'Poll'}`
      : 'Message';

    try {
      // The backend handles forwarding (copying media/poll, forwarded labelling
      // and per-chat lastMessage updates). Forward each selected message to all
      // target chats in order.
      for (const src of messagesToForward) {
        // previewFor is still used to build the result alert below; call it so
        // the lint/behaviour stays identical even though the backend owns the
        // per-chat lastMessage now.
        void previewFor(src);
        await endpoints.forwardMessage(src.messageId, selectedChatIds);
      }

      const n = messagesToForward.length;
      Alert.alert(
        'Forwarded',
        `${n} message${n === 1 ? '' : 's'} forwarded to ${selectedChatIds.length} ${selectedChatIds.length === 1 ? 'chat' : 'chats'}`
      );

      setMessagesToForward([]);
      setForwardModalVisible(false);
    } catch (error) {
      console.error('[ChatScreen] Error forwarding messages:', error);
      Alert.alert('Error', 'Failed to forward. Please try again.');
    }
  };

  // ── Voice call handler ──────────────────────────────────────────
  // Uses WebRTC signaling for 1:1 calls — navigates to AudioCall screen.
  const startCall = useCallback(async () => {
    if (!userId || !otherUserId) {
      Alert.alert('Cannot make call', 'User information not available.');
      return;
    }

    if (isGroup) {
      Alert.alert('Not Supported', 'Group calls are not available.');
      return;
    }

    try {
      // Check the other user's privacyCalls setting before starting
      const calleePrivacy = await fetchUserPrivacySettings(otherUserId);
      if (calleePrivacy.calls === 'Nobody') {
        Alert.alert("Can't call", `${displayName} has turned off calls.`);
        return;
      }

      const callerInfo = {
        userId,
        displayName: user?.displayName || user?.phoneNumber || 'You',
        photoUrl: user?.photoURL || null,
      };
      const calleeInfo = {
        userId: otherUserId,
        displayName,
        photoUrl: otherUserPhoto || null,
      };

      const callId = await outgoingCall.initiateCall(
        userId,
        otherUserId,
        callerInfo,
        calleeInfo,
        'audio',
      );

      if (callId) {
        navigation.navigate('AudioCall', {
          callId,
          isOutgoing: true,
          otherParty: calleeInfo,
        });
      } else {
        Alert.alert('Error', 'Failed to start call');
      }
    } catch (error) {
      console.error('[ChatScreen] Error initiating call:', error);
      Alert.alert('Error', 'Failed to start call');
    }
  }, [userId, otherUserId, isGroup, displayName, user, outgoingCall, navigation, otherUserPhoto]);

  const handleVoiceCall = useCallback(() => startCall(), [startCall]);

  // ── Video call handler ──────────────────────────────────────────
  const handleVideoCall = useCallback(async () => {
    if (!userId || !otherUserId) {
      Alert.alert('Cannot call', 'User information not available.');
      return;
    }
    if (isGroup) {
      Alert.alert('Not Supported', 'Group calls are not available.');
      return;
    }
    try {
      const calleePrivacy = await fetchUserPrivacySettings(otherUserId);
      if (calleePrivacy.calls === 'Nobody') {
        Alert.alert("Can't call", `${displayName} has turned off calls.`);
        return;
      }
      const callerInfo = {
        userId,
        displayName: user?.displayName || user?.phoneNumber || 'You',
        photoUrl: user?.photoURL || null,
      };
      const calleeInfo = {
        userId: otherUserId,
        displayName,
        photoUrl: otherUserPhoto || null,
      };
      const callId = await outgoingCall.initiateCall(
        userId,
        otherUserId,
        callerInfo,
        calleeInfo,
        'video',
      );
      if (callId) {
        navigation.navigate('VideoCall', {
          callId,
          isOutgoing: true,
          otherParty: calleeInfo,
        });
      } else {
        Alert.alert('Error', 'Failed to start video call');
      }
    } catch (error) {
      console.error('[ChatScreen] Error initiating video call:', error);
      Alert.alert('Error', 'Failed to start video call');
    }
  }, [userId, otherUserId, isGroup, displayName, user, outgoingCall, navigation, otherUserPhoto]);

  // ── PanResponder for mic button ─────────────────────────────────
  const micPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,

    onPanResponderGrant: (_evt: GestureResponderEvent, _gestureState: PanResponderGestureState) => {
      isCancelledRef.current = false;
      recorder.startRecording();
    },

    onPanResponderMove: (_evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
      const distance = Math.sqrt(gestureState.dx * gestureState.dx + gestureState.dy * gestureState.dy);
      if (distance >= CANCEL_THRESHOLD_DP && !isCancelledRef.current) {
        isCancelledRef.current = true;
        recorder.cancelRecording();
      }
    },

    onPanResponderRelease: async (_evt: GestureResponderEvent, _gestureState: PanResponderGestureState) => {
      if (isCancelledRef.current) return;

      const result = await recorder.stopRecording();
      if (result) {
        handleVoiceUploadAndSend(result);
      }
    },

    onPanResponderTerminate: () => {
      if (!isCancelledRef.current) {
        isCancelledRef.current = true;
        recorder.cancelRecording();
      }
    },
  }), [recorder, handleVoiceUploadAndSend]);

  // ── Dismiss permission message ──────────────────────────────────
  const dismissPermissionMessage = useCallback(() => {
    setPermissionMessage(null);
    setShowSettingsButton(false);
  }, []);

  // ── Open device settings ────────────────────────────────────────
  const handleOpenSettings = useCallback(() => {
    Linking.openSettings();
    dismissPermissionMessage();
  }, [dismissPermissionMessage]);

  // ── Image compression helper ────────────────────────────────────
  const compressImage = async (uri: string): Promise<string> => {
    // Always re-encode to JPEG. Firebase Storage's native putFile rejects raw
    // HEIC uploads with "storage/unknown", so no .heic may ever reach Storage.
    // Uses the SDK 57 contextual ImageManipulator API (manipulateAsync is deprecated).
    //
    // IMPORTANT: we verify the output file is a valid, non-empty file before
    // returning it. If ImageManipulator silently produces a 0-byte file (which
    // happens on iOS for certain Photos-library assets), we fall back to the
    // original URI (which has already been verified by toUploadableUri).

    try {
      console.log('[ChatScreen] Compressing image:', uri);
      const context = ImageManipulator.manipulate(uri);
      context.resize({ width: 1200 }); // max 1200px wide, aspect ratio preserved
      const rendered = await context.renderAsync();
      const result = await rendered.saveAsync({
        compress: 0.8,
        format: SaveFormat.JPEG,
      });

      const check = await isFileReadable(result.uri);
      if (check.ok) {
        console.log('[ChatScreen] Compressed OK →', result.uri, 'size=', check.size);
        return result.uri;
      }
      console.warn('[ChatScreen][diag] Resize produced empty file, trying plain JPEG re-encode');
    } catch (error: any) {
      console.warn('[ChatScreen][diag] Resize failed, retrying as plain JPEG re-encode:', error?.message, error);
    }

    // Fallback: re-encode to JPEG without resizing.
    try {
      const context = ImageManipulator.manipulate(uri);
      const rendered = await context.renderAsync();
      const result = await rendered.saveAsync({ format: SaveFormat.JPEG });

      const check = await isFileReadable(result.uri);
      if (check.ok) {
        console.log('[ChatScreen] JPEG re-encode fallback OK →', result.uri, 'size=', check.size);
        return result.uri;
      }
      console.warn('[ChatScreen][diag] JPEG fallback produced empty file');
    } catch (fallbackError: any) {
      console.error('[ChatScreen][diag] JPEG re-encode fallback failed:', fallbackError?.message, fallbackError);
    }

    // Last resort: return the input URI (already verified by toUploadableUri).
    console.warn('[ChatScreen][diag] Using original URI (image manipulation failed):', uri);
    return uri;
  };

  // ── Load the most recent device photos for the camera roll strip ─
  const loadRecentPhotos = async () => {
    try {
      if (Platform.OS === 'web') return;
      const MediaLibrary = require('expo-media-library/legacy');
      const perm = await MediaLibrary.getPermissionsAsync();
      let granted = perm.granted;
      if (!granted) {
        const req = await MediaLibrary.requestPermissionsAsync();
        granted = req.granted;
      }
      if (!granted) { setRecentPhotos([]); return; }
      const res = await MediaLibrary.getAssetsAsync({
        first: 30,
        mediaType: ['photo', 'video'],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      // On iOS, ph:// asset URIs may not render directly; resolve to a localUri.
      const items = await Promise.all(
        res.assets.map(async (a: any) => {
          let uri = a.uri;
          if (Platform.OS === 'ios') {
            try {
              const info = await MediaLibrary.getAssetInfoAsync(a);
              uri = stripFragment(info.localUri || info.uri || a.uri);
            } catch {}
          }
          // Keep the real media type from the library so videos are never mistaken for images
          // (the "#fragment" on iOS video URIs used to defeat the extension check).
          return {
            id: a.id,
            uri: stripFragment(uri),
            isVideo: a.mediaType === 'video',
            width: a.width,
            height: a.height,
          };
        }),
      );
      setRecentPhotos(items);
    } catch (err) {
      console.warn('[ChatScreen] Failed to load recent photos:', err);
      setRecentPhotos([]);
    }
  };

  // ── Upload single image helper ─────────────────────────────────
  // ── Camera / gallery / documents ────────────────────────────────
  const openCamera = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Camera', 'Camera is not available on web.');
      return;
    }

    // Check if permission is already granted
    if (cameraPermission?.granted) {
      setCameraOpen(true);
      loadRecentPhotos();
      return;
    }

    // Request permission
    const { granted } = await requestCameraPermission();
    if (granted) {
      setCameraOpen(true);
      loadRecentPhotos();
    } else {
      Alert.alert('Permission needed', 'Allow camera access to take photos.');
    }
  };

  const takePicture = async () => {
    if (!cameraRef.current || !userId) return;

    try {
      console.log('[ChatScreen] Taking picture...');
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.85,
      });

      console.log('[ChatScreen] Picture taken:', photo.uri);
      setCameraOpen(false);
      // Show the preview + caption screen instead of sending immediately.
      setMediaCaption('');
      setPendingMedia([{
        uri: photo.uri,
        kind: 'image',
        width: photo.width,
        height: photo.height,
      }]);
      setPendingMediaIndex(0);
    } catch (error) {
      console.error('[ChatScreen] Camera error:', error);
      Alert.alert('Error', 'Failed to take picture.');
    }
  };

  /** Prepare, upload, and reconcile one optimistic media bubble. */
  const runMediaUpload = async (job: MediaUploadJob): Promise<boolean> => {
    if (activeMediaUploadsRef.current.has(job.clientId)) return false;
    activeMediaUploadsRef.current.add(job.clientId);

    updateOptimisticMessage(
      job.clientId,
      {
        uploadStatus: 'preparing',
        uploadProgress: 0,
        uploadBytesSent: 0,
        uploadBytesTotal: job.fileSize ?? 0,
        uploadError: null,
      },
      true,
    );

    try {
      const localUri = await toUploadableUri(job.uri, job.kind);
      const preflight = await isFileReadable(localUri);
      if (!preflight.ok) {
        throw new Error(`Media file is not readable (size=${preflight.size})`);
      }

      let uploadUri = localUri;
      if (job.kind === 'image') {
        const compressedUri = await compressImage(localUri);
        const finalCheck = await isFileReadable(compressedUri);
        uploadUri = finalCheck.ok ? compressedUri : localUri;
      }

      const uploadSize = await fileSize(uploadUri);
      updateOptimisticMessage(
        job.clientId,
        {
          uploadStatus: 'uploading',
          uploadBytesTotal: uploadSize,
          uploadBytesSent: 0,
          uploadProgress: 0,
        },
        true,
      );

      const onProgress = (
        percentage: number,
        detail: { bytesSent: number; totalBytes: number },
      ) => {
        const status = percentage >= 100 ? 'sending' as const : 'uploading' as const;
        updateOptimisticMessage(job.clientId, {
          uploadStatus: status,
          uploadProgress: percentage,
          uploadBytesSent: detail.bytesSent,
          uploadBytesTotal: detail.totalBytes,
        });
      };

      const result = job.kind === 'video'
        ? await sendVideoMessage(
            chatId,
            userId!,
            uploadUri,
            undefined,
            onProgress,
            job.caption,
            job.clientId,
          )
        : await sendImageMessage(
            chatId,
            userId!,
            uploadUri,
            onProgress,
            job.caption,
            job.clientId,
          );

      if (!result.success || !result.message) {
        throw new Error(result.error || 'The media could not be sent.');
      }

      // The server does not echo message:new back to the sender. Apply the
      // HTTP response locally; clientId replaces the optimistic bubble in-place.
      await reconcileBackendMessage(result.message);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Media upload failed';
      console.error(`[ChatScreen] Media upload failed (${job.clientId}):`, error);
      updateOptimisticMessage(
        job.clientId,
        {
          uploadStatus: 'failed',
          uploadError: message,
        },
        true,
      );
      return false;
    } finally {
      activeMediaUploadsRef.current.delete(job.clientId);
    }
  };

  const retryMediaUpload = (item: FireMessage) => {
    if (
      item.uploadStatus !== 'failed' ||
      !item.localMediaUri ||
      (item.type !== 'image' && item.type !== 'video')
    ) return;

    void runMediaUpload({
      clientId: item.clientId ?? item.messageId,
      uri: item.localMediaUri,
      kind: item.type,
      caption: item.text,
      width: item.mediaWidth ?? undefined,
      height: item.mediaHeight ?? undefined,
      fileSize: item.uploadBytesTotal,
    });
  };

  // Insert every selected item immediately, then upload them serially so the
  // user sees all reserved media spaces and per-item progress at once.
  const sendPendingMedia = async () => {
    if (!pendingMedia || pendingMedia.length === 0 || !userId || mediaSendInFlightRef.current) return;
    mediaSendInFlightRef.current = true;

    const caption = mediaCaption.trim() || null;
    const jobs: MediaUploadJob[] = pendingMedia.map((media, index) => ({
      ...media,
      clientId: createMediaClientId(index),
      caption: index === 0 ? caption : null,
    }));

    for (const job of jobs) {
      addOptimisticMessage({
        messageId: job.clientId,
        clientId: job.clientId,
        senderId: userId,
        type: job.kind,
        text: job.caption,
        imageUrl: job.kind === 'image' ? job.uri : null,
        videoUrl: job.kind === 'video' ? job.uri : null,
        localMediaUri: job.uri,
        timestamp: new Date(),
        readBy: [userId],
        deliveredTo: [],
        uploadStatus: 'preparing',
        uploadProgress: 0,
        uploadBytesSent: 0,
        uploadBytesTotal: job.fileSize ?? 0,
        mediaWidth: job.width ?? null,
        mediaHeight: job.height ?? null,
      });
    }

    // Close the preview only after the optimistic records exist.
    setPendingMedia(null);
    setPendingMediaIndex(0);
    setMediaCaption('');

    try {
      let sentAny = false;
      for (const job of jobs) {
        sentAny = (await runMediaUpload(job)) || sentAny;
      }
      if (sentAny) await checkAndTriggerAutoResponder();
    } finally {
      mediaSendInFlightRef.current = false;
    }
  };

  const openGallery = async () => {
    try {
      // expo-image-picker's system gallery manages its own access prompt, so we
      // only need the picker's own permission (not media-library read access).
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Permission needed', 'Allow photo access to select images from your gallery.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'], // allow photos AND videos
        allowsMultipleSelection: true,    // multiple selection
        quality: 0.85,
      });

      if (result.canceled || result.assets.length === 0 || !userId) return;
      setShowAttach(false);

      // Convert assets to pending media format
      const assets: PendingMediaItem[] = result.assets.map((asset) => ({
        uri: asset.uri,
        kind: asset.type === 'video' ? 'video' : 'image',
        width: asset.width,
        height: asset.height,
        fileSize: asset.fileSize,
        mimeType: asset.mimeType ?? null,
      }));

      // Show carousel preview for any number of items
      setMediaCaption('');
      setPendingMedia(assets);
      setPendingMediaIndex(0);
      return;
    } catch (error) {
      console.error('[ChatScreen] Gallery error:', error);
      setUploadingImage(false);
      setImageUploadProgress(0);
      Alert.alert('Error', 'Failed to select or upload images.');
    }
  };

  const openDocuments = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        multiple: true,
        type: '*/*', // Allow all file types
      });

      if (!result.canceled && result.assets.length > 0 && userId) {
        setShowAttach(false);
        setUploadingImage(true);
        setImageUploadProgress(0);

        for (let i = 0; i < result.assets.length; i++) {
          const file = result.assets[i];
          console.log(`[ChatScreen] Uploading file ${i + 1}/${result.assets.length}:`, file.name, file.mimeType);

          try {
            // Reset progress for each file
            setImageUploadProgress(0);

            // DocumentPicker returns a readable file:// in the app's tmp/cache.
            // Still normalise (strip iOS fragments) before handing it to Storage.
            const cleanUri = stripFragment(file.uri);

            const uploadResult = await sendFileMessage(
              chatId,
              userId,
              cleanUri,
              file.name,
              file.size || 0,
              file.mimeType || 'application/octet-stream',
              (progress) => {
                setImageUploadProgress(progress);
                console.log(`[ChatScreen] File ${i + 1} upload progress:`, progress);
              }
            );

            if (!uploadResult.success) {
              console.error(`[ChatScreen] File ${i + 1} upload failed`);
              Alert.alert('Upload Failed', `${file.name} could not be sent. Continuing with others...`);
            } else {
              console.log(`[ChatScreen] File ${i + 1} uploaded successfully`);
            }
          } catch (error) {
            console.error(`[ChatScreen] File ${i + 1} upload error:`, error);
            Alert.alert('Error', `Failed to upload ${file.name}. Continuing with others...`);
          }
        }

        console.log('[ChatScreen] All files processed');
        setUploadingImage(false);
        setImageUploadProgress(0);
        await checkAndTriggerAutoResponder();
      }
    } catch (error) {
      console.error('[ChatScreen] Document picker error:', error);
      setUploadingImage(false);
      setImageUploadProgress(0);
      Alert.alert('Error', 'Failed to select files.');
    }
  };

  const openAudioPicker = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'audio/*', // Only audio files
        multiple: false,
      });

      if (!result.canceled && result.assets.length > 0 && userId) {
        setShowAttach(false);
        const audioFile = result.assets[0];
        console.log('[ChatScreen] Selected audio file:', audioFile.name, audioFile.mimeType);

        setUploadingImage(true);
        setImageUploadProgress(0);

        try {
          const cleanUri = stripFragment(audioFile.uri);
          const uploadResult = await sendFileMessage(
            chatId,
            userId,
            cleanUri,
            audioFile.name,
            audioFile.size || 0,
            audioFile.mimeType || 'audio/mpeg',
            (progress) => {
              setImageUploadProgress(progress);
              console.log('[ChatScreen] Audio file upload progress:', progress);
            }
          );

          if (uploadResult.success) {
            console.log('[ChatScreen] Audio file sent successfully');
            await checkAndTriggerAutoResponder();
          } else {
            Alert.alert('Upload Failed', 'Could not send the audio file. Please try again.');
          }
        } catch (error) {
          console.error('[ChatScreen] Audio upload error:', error);
          Alert.alert('Error', 'Failed to upload audio file.');
        } finally {
          setUploadingImage(false);
          setImageUploadProgress(0);
        }
      }
    } catch (error) {
      console.error('[ChatScreen] Audio picker error:', error);
      Alert.alert('Error', 'Failed to select audio file.');
    }
  };

  // Open the Add-Contact sheet prefilled for a shared contact card.
  const handleSaveSharedContact = useCallback((name: string, phone: string) => {
    setPendingSaveContact({ name, phone });
    setAddContactOpen(true);
  }, []);

  // Toggle a contact in the share-contact multi-select.
  const toggleContactSelect = (key: string) => {
    setSelectedContactKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  // Send every selected contact as its own contact card.
  const sendSelectedContacts = async () => {
    if (!userId || selectedContactKeys.length === 0) return;
    const chosen = phoneContacts.filter((c) => selectedContactKeys.includes(c.userId || c.phone));
    setContactPickerOpen(false);
    setSelectedContactKeys([]);
    setContactQuery('');

    const sharedContacts = chosen.map((c) => ({
      name: c.displayName,
      phone: c.phone,
      userId: c.isSaved ? c.userId : null,
      registered: !!c.isSaved,
      photoURL: c.firebasePhotoURL ?? null,
    }));

    try {
      if (sharedContacts.length === 1) {
        const result = await sendContactMessage(chatId, userId, sharedContacts[0]);
        if (result.success) {
          addOptimisticMessage({
            messageId: result.messageId,
            senderId: userId,
            type: 'contact',
            contact: sharedContacts[0],
          });
        }
      } else {
        // Multiple → one grouped bubble with a "View all" sheet.
        const result = await sendContactsMessage(chatId, userId, sharedContacts);
        if (result.success) {
          addOptimisticMessage({
            messageId: result.messageId,
            senderId: userId,
            type: 'contact',
            contact: { ...sharedContacts[0], contacts: sharedContacts },
          });
        }
      }
    } catch (err) {
      console.error('[ChatScreen] Failed to share contacts:', err);
    }
    await checkAndTriggerAutoResponder();
  };


  // ── Delete contact handler ──────────────────────────────────────
  // Removes the device address-book entry for this number (so the name/surname
  // disappears and the header falls back to the phone number). The chat and its
  // messages are untouched.
  const handleDeleteContact = useCallback(() => {
    if (isGroup || !otherUserPhone) return;
    setProfileModalOpen(false);
    Alert.alert(
      'Delete Contact',
      'Remove this contact from your phone? Your chat history stays, but the saved name will be removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (Platform.OS === 'web') return;
              const Contacts = await import('expo-contacts/legacy');
              const { status } = await Contacts.requestPermissionsAsync();
              if (status !== 'granted') return;
              const normalized = normalizePhone(otherUserPhone);
              const { data } = await Contacts.getContactsAsync({
                fields: [Contacts.Fields.PhoneNumbers],
              });
              // Delete every contact whose number matches this phone
              await Promise.all(
                data
                  .filter((c: any) =>
                    (c.phoneNumbers ?? []).some((pn: any) => normalizePhone(pn.number ?? '') === normalized)
                  )
                  .map((c: any) => c.id ? Contacts.removeContactAsync(c.id) : Promise.resolve())
              );
              reloadPhoneBook();
            } catch (err) {
              console.error('[ChatScreen] Failed to delete contact:', err);
              Alert.alert('Could not delete', 'Failed to delete the contact. Please try again.');
            }
          },
        },
      ],
    );
  }, [isGroup, otherUserPhone, reloadPhoneBook]);

  // ── Clear chat handler ──────────────────────────────────────────
  // Delegates to useMessages.clearMessages, which empties the on-screen list
  // instantly, wipes the local cache, and deletes the Firestore docs.
  const handleClearChat = useCallback(async () => {
    if (!chatId) return;
    try {
      await clearMessages();
    } catch (error) {
      console.error('[ChatScreen] Error clearing chat:', error);
      Alert.alert('Error', 'Failed to clear chat. Please try again.');
    }
  }, [chatId, clearMessages]);

  // ── Block contact handler ───────────────────────────────────────
  const handleBlockContact = useCallback(async () => {
    if (!userId || !otherUserId || isGroup) {
      console.error('[ChatScreen] Cannot block: missing user info or is group chat');
      return;
    }

    try {
      console.log('[ChatScreen] Blocking contact:', otherUserId);

      // Block via the backend. otherUserPhoto may be a resolved URL or object
      // key; pass it as the stored photo object key best-effort.
      await endpoints.blockUser(otherUserId, {
        displayName,
        photoObjectKey: otherUserPhoto || null,
        phone: resolvedPhone || otherUserPhone || null,
      });

      console.log('[ChatScreen] Contact blocked successfully');
      setIsBlocked(true);
      setShowBlockConfirmation(false);
      setProfileModalOpen(false);

      // Show confirmation
      Alert.alert('Contact Blocked', `${displayName} has been blocked. You won't receive messages from this contact.`);
    } catch (error) {
      console.error('[ChatScreen] Error blocking contact:', error);
      Alert.alert('Error', 'Failed to block contact. Please try again.');
    }
  }, [userId, otherUserId, isGroup, displayName, otherUserPhoto, resolvedPhone, otherUserPhone]);

  // ── Unblock contact handler ─────────────────────────────────────
  const handleUnblockContact = useCallback(async () => {
    if (!userId || !otherUserId || isGroup) {
      console.error('[ChatScreen] Cannot unblock: missing user info or is group chat');
      return;
    }

    try {
      console.log('[ChatScreen] Unblocking contact:', otherUserId);

      await endpoints.unblockUser(otherUserId);

      console.log('[ChatScreen] Contact unblocked successfully');
      setIsBlocked(false);
      setBlockedByMe(false);

      // Show confirmation
      Alert.alert('Contact Unblocked', `You can now send and receive messages from ${displayName}.`);
    } catch (error) {
      console.error('[ChatScreen] Error unblocking contact:', error);
      Alert.alert('Error', 'Failed to unblock contact. Please try again.');
    }
  }, [userId, otherUserId, isGroup, displayName]);

  // ── Leave group handler ─────────────────────────────────────────
  const handleLeaveGroup = useCallback(async () => {
    if (!userId || !chatId || !isGroup) {
      console.error('[ChatScreen] Cannot leave: missing user info or not a group chat');
      return;
    }

    setLeavingGroup(true);

    try {
      console.log('[ChatScreen] Leaving group:', chatId);

      const userDisplayName = user?.displayName || user?.phoneNumber || 'User';

      // Remove myself from the group members on the backend.
      // TODO(no-backend): the old chats/{id}.pastMembers array (who left + when)
      // has no REST equivalent, so leaving no longer records a past-member
      // entry. The leave itself and the system notice are preserved.
      const res = await endpoints.updateChat(chatId, { removeMembers: [userId] });
      if (!res.ok) {
        Alert.alert('Error', 'Failed to leave group. Please try again.');
        setLeavingGroup(false);
        return;
      }

      // Post the "left the group" system notice.
      await endpoints.sendMessage(chatId, {
        type: 'system',
        text: `${userDisplayName} left the group`,
        subtype: 'member-left',
      });

      console.log('[ChatScreen] Left group successfully');
      setLeavingGroup(false);
      setShowLeaveGroupConfirmation(false);
      setProfileModalOpen(false);

      // Navigate back to ChatsScreen
      navigation.goBack();

      // Show confirmation
      setTimeout(() => {
        Alert.alert('Left Group', `You have left ${displayName}.`);
      }, 500);
    } catch (error) {
      console.error('[ChatScreen] Error leaving group:', error);
      setLeavingGroup(false);
      Alert.alert('Error', 'Failed to leave group. Please try again.');
    }
  }, [userId, chatId, isGroup, displayName, user, navigation]);

  // ── Open QR share sheet ─────────────────────────────────────────
  // Closes the profile sheet first, then presents the QR share sheet so the
  // two modals don't stack awkwardly on iOS.
  const openQrShare = useCallback(() => {
    if (!otherUserId) {
      Alert.alert('Cannot share', 'Business information is not available yet.');
      return;
    }
    setProfileModalOpen(false);
    setTimeout(() => setQrShareVisible(true), 60);
  }, [otherUserId]);

  // ── Check if recording is active ────────────────────────────────
  const isRecording = recorder.state.status === 'recording';

  // ── Render a single message bubble or date separator ────────────
  const memoizedRenderItem = useCallback(({ item }: { item: MessageListItem }) => {
    // Handle date separators
    if (item.type === 'dateSeparator') {
      return (
        <View style={styles.datePillWrap}>
          <View style={styles.datePill}>
            <AppText style={styles.datePillText}>{item.dateLabel}</AppText>
          </View>
        </View>
      );
    }

    // Handle unread divider — the "Unread messages" banner WhatsApp-style
    if (item.type === 'unreadDivider') {
      return (
        <View style={styles.unreadDividerWrap}>
          <View style={styles.unreadDividerLine} />
          <View style={styles.unreadDividerPill}>
            <AppText style={styles.unreadDividerText}>Unread messages</AppText>
          </View>
          <View style={styles.unreadDividerLine} />
        </View>
      );
    }

    // Handle messages
    return renderMessage({ item: item.data });
  }, [
    selectedIds,
    searchQuery,
    searchMatchIds,
    searchCurrentIndex,
    selectionMode,
    userId,
    isGroup,
    messages,
    isRecording,
    player.state,
    groupMembers,
    displayName,
  ]);

  // ── Render a single message bubble ──────────────────────────────
  const renderMessage = ({ item }: { item: FireMessage }) => {
    // ── System messages (block/unblock notifications) ───────────────
    if (item.type === 'system') {
      const displayText = parseSystemMessage(item.text || '', userId);
      return (
        <View style={styles.systemMessageContainer}>
          <View style={[styles.systemMessageBubble, { backgroundColor: FG.glassBg }]}>
            <AppText style={[styles.systemMessageText, { color: FG.secondary }]}>
              {displayText}
            </AppText>
          </View>
        </View>
      );
    }

    const isOut = item.senderId === userId;
    const isSelected = selectedIds.includes(item.messageId);
    // While in selection mode, a plain tap toggles selection instead of its
    // normal action (opening an image, jumping to a reply, etc.).
    const onBubblePress = selectionMode ? () => handleToggleSelectMessage(item.messageId) : undefined;
    const isSearchMatch = searchQuery.trim().length > 0 &&
      item.type === 'text' &&
      item.text?.toLowerCase().includes(searchQuery.toLowerCase());
    const isActiveMatch = searchMatchIds[searchCurrentIndex] === item.messageId;

    // Get tick status for outgoing messages
    const tickStatus = getTickStatus(item, userId, isGroup);
    const tickIcon = getTickIcon(tickStatus);

    // ── Catalog product card — standalone render, no msgRow wrapper ──
    // Rendered here (before messageContent) so it bypasses the chat bubble
    // layout entirely and avoids the duplicate-timestamp problem.
    if (item.type === 'catalog' && item.catalogItem) {
      return (
        <TouchableOpacity
          activeOpacity={1}
          onPress={onBubblePress}
          onLongPress={() => handleLongPressMessage(item.messageId)}
          delayLongPress={300}
        >
          <View style={[isSelected && styles.selectedMessage]}>
            <CatalogBubble
              item={item.catalogItem}
              isOutgoing={isOut}
              sellerUid={item.senderId}
              timestamp={formatTime(item.timestamp)}
              tickIcon={tickIcon}
            />
          </View>
        </TouchableOpacity>
      );
    }

    // ── Order card — standalone render (bypasses msgRow bubble) ──
    if (item.type === 'order' && item.order) {
      return (
        <TouchableOpacity
          activeOpacity={1}
          onPress={onBubblePress}
          onLongPress={() => handleLongPressMessage(item.messageId)}
          delayLongPress={300}
        >
          <View style={[isSelected && styles.selectedMessage]}>
            <OrderBubble
              order={item.order}
              isOutgoing={isOut}
              timestamp={formatTime(item.timestamp)}
              tickIcon={tickIcon}
            />
          </View>
        </TouchableOpacity>
      );
    }

    // ── Shared contact card — standalone render ──
    if (item.type === 'contact' && item.contact) {
      return (
        <TouchableOpacity
          activeOpacity={1}
          onPress={onBubblePress}
          onLongPress={() => handleLongPressMessage(item.messageId)}
          delayLongPress={300}
        >
          <View style={[isSelected && styles.selectedMessage]}>
            <ContactBubble
              contact={item.contact}
              isOutgoing={isOut}
              timestamp={formatTime(item.timestamp)}
              tickIcon={tickIcon}
              onSaveContact={handleSaveSharedContact}
            />
          </View>
        </TouchableOpacity>
      );
    }

    // ── Poll card — standalone render ──
    if (item.type === 'poll' && item.poll) {
      return (
        <TouchableOpacity
          activeOpacity={1}
          onPress={onBubblePress}
          onLongPress={() => handleLongPressMessage(item.messageId)}
          delayLongPress={300}
        >
          <View style={[isSelected && styles.selectedMessage]}>
            <PollBubble
              poll={item.poll}
              isOutgoing={isOut}
              currentUserId={userId}
              onVote={(optionId) => {
                if (!userId) return;
                votePollOption(chatId, item.messageId, userId, optionId).catch(() => {});
              }}
              timestamp={formatTime(item.timestamp)}
              tickIcon={tickIcon}
            />
          </View>
        </TouchableOpacity>
      );
    }

    // ── Meeting invite card — standalone render ──
    if (item.type === 'meeting' && item.meeting) {
      return (
        <TouchableOpacity
          activeOpacity={1}
          onPress={onBubblePress}
          onLongPress={() => handleLongPressMessage(item.messageId)}
          delayLongPress={300}
        >
          <View style={[isSelected && styles.selectedMessage]}>
            <MeetingBubble
              meeting={item.meeting}
              isOutgoing={isOut}
              timestamp={formatTime(item.timestamp)}
              tickIcon={tickIcon}
            />
          </View>
        </TouchableOpacity>
      );
    }

    // Debug logging for file messages
    if (item.type === 'file') {
      console.log('[ChatScreen] Rendering file message:', {
        type: item.type,
        fileName: item.fileName,
        fileUrl: item.fileUrl,
        fileSize: item.fileSize,
        mimeType: item.mimeType,
      });
    }

    const messageContent = (
      <View style={[styles.msgRow, isOut ? styles.msgRowOut : styles.msgRowIn]}>
        {!isOut && (
          item.type === 'voice' && item.voiceUrl && item.duration ? (
            <VoiceMessageBubble
              messageId={item.messageId}
              voiceUrl={item.voiceUrl}
              durationMs={item.duration}
              isOutgoing={false}
              playerState={player.state}
              onPlay={() => {
                if (player.state.activeMessageId === item.messageId && player.state.status === 'paused') {
                  player.resume();
                } else {
                  player.play(item.voiceUrl!, item.messageId, item.duration!);
                }
              }}
              onPause={() => player.pause()}
              onSeek={(positionMs) => player.seek(positionMs)}
              timestamp={item.timestamp}
            />
          ) : item.type === 'file' && item.fileUrl && item.fileName ? (
            <FileMessageBubble
              fileName={item.fileName!}
              fileSize={item.fileSize ?? undefined}
              fileUrl={item.fileUrl!}
              mimeType={item.mimeType ?? undefined}
              isOutgoing={false}
            />
          ) : item.type === 'video' && item.videoUrl ? (
            <LinearGradient colors={GRADIENTS.chatSent} style={[styles.bubble, styles.bubbleIn, styles.imageBubble]}>
              {item.forwarded && (
                <View style={styles.forwardedRow}>
                  <AppIcon name="arrow-redo-outline" size={12} color="rgba(255,255,255,0.7)" fixedColor />
                  <AppText fixedColor style={styles.forwardedLabelIn}>Forwarded</AppText>
                </View>
              )}
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => setVideoViewerUrl(item.videoUrl!)}
              >
                <View style={styles.videoThumbWrap}>
                  {item.thumbnailUrl ? (
                    <Image source={{ uri: item.thumbnailUrl }} style={styles.videoThumbImage} resizeMode="cover" />
                  ) : (
                    <View style={[styles.videoThumbImage, styles.videoPlaceholder]} />
                  )}
                  <View style={styles.videoPlayOverlay}>
                    <AppIcon name="play" size={30} color="#fff" fixedColor />
                  </View>
                  {/* Time overlay only when there is NO caption — otherwise
                      the footer row below handles it to avoid overlap. */}
                  {!item.text && (
                    <View style={styles.imageTimeOverlay}>
                      <AppText fixedColor style={styles.timeIn}>{formatTime(item.timestamp)}</AppText>
                    </View>
                  )}
                </View>
              </TouchableOpacity>
              {item.text ? (
                <View style={styles.mediaCaptionBlock}>
                  <AppText fixedColor style={styles.mediaCaptionIn}>{item.text}</AppText>
                  <View style={styles.mediaCaptionTimeRow}>
                    <AppText fixedColor style={styles.timeIn}>
                      {formatTime(item.timestamp)}
                    </AppText>
                  </View>
                </View>
              ) : null}
            </LinearGradient>
          ) : item.type === 'image' && item.imageUrl ? (
            <LinearGradient colors={GRADIENTS.chatSent} style={[styles.bubble, styles.bubbleIn, styles.imageBubble]}>
              {item.forwarded && (
                <View style={styles.forwardedRow}>
                  <AppIcon name="arrow-redo-outline" size={12} color="rgba(255,255,255,0.7)" fixedColor />
                  <AppText fixedColor style={styles.forwardedLabelIn}>Forwarded</AppText>
                </View>
              )}
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => {
                  setViewerImageUrl(item.imageUrl!);
                  setViewerVisible(true);
                }}
              >
                <Image
                  source={{ uri: item.imageUrl }}
                  style={styles.messageImage}
                  resizeMode="cover"
                />
              </TouchableOpacity>
              {item.text ? <AppText fixedColor style={styles.mediaCaptionIn}>{item.text}</AppText> : null}
              <View style={styles.imageTimeOverlay}>
                <AppText fixedColor style={styles.timeIn}>{formatTime(item.timestamp)}</AppText>
              </View>
            </LinearGradient>
          ) : (
            <LinearGradient colors={GRADIENTS.chatSent} style={[styles.bubble, styles.bubbleIn]}>
              {item.replyTo && (
                <TouchableOpacity
                  style={styles.replyBubble}
                  onPress={() => {
                    const originalMsg = messages.find(m => m.messageId === item.replyTo!.messageId);
                    if (originalMsg) {
                      const index = messages.findIndex(m => m.messageId === item.replyTo!.messageId);
                      if (index !== -1 && listRef.current) {
                        listRef.current.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
                      }
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <View style={styles.replyBubbleBar} />
                  <View style={{ flex: 1 }}>
                    <AppText fixedColor style={styles.replyBubbleSender}>
                      {item.replyTo.senderId === userId ? 'You' : resolveSenderName(item.replyTo.senderId)}
                    </AppText>
                    <AppText fixedColor style={styles.replyBubbleText} numberOfLines={1}>
                      {item.replyTo.type === 'text' && item.replyTo.text
                        ? item.replyTo.text
                        : item.replyTo.type === 'voice'
                          ? '🎤 Voice message'
                          : item.replyTo.type === 'image'
                            ? '📷 Image'
                            : item.replyTo.type === 'file'
                              ? '📎 File'
                              : item.replyTo.type === 'location'
                                ? '📍 Location'
                                : 'Message'}
                    </AppText>
                  </View>
                </TouchableOpacity>
              )}
              {item.forwarded && (
                <View style={styles.forwardedRow}>
                  <AppIcon name="arrow-redo-outline" size={12} color="rgba(255,255,255,0.7)" fixedColor />
                  <AppText fixedColor style={styles.forwardedLabelIn}>Forwarded</AppText>
                </View>
              )}
              {item.text && <AppText fixedColor style={styles.bubbleTextIn}>{item.text}</AppText>}
              <View style={styles.timeInRow}>
                {item.edited && (
                  <AppText fixedColor style={styles.editedLabel}>Edited</AppText>
                )}
                <AppText fixedColor style={styles.timeIn}>{formatTime(item.timestamp)}</AppText>
              </View>
            </LinearGradient>
          )
        )}
        {isOut && (
          item.type === 'voice' && (item.voiceUrl || item.uploadStatus) && item.duration ? (
            <View style={{ opacity: item.uploadStatus === 'uploading' || item.uploadStatus === 'sending' ? 0.75 : 1 }}>
              <VoiceMessageBubble
                messageId={item.messageId}
                voiceUrl={item.voiceUrl ?? ''}
                durationMs={item.duration}
                isOutgoing={true}
                playerState={
                  // Prevent playback on a bubble that is still uploading
                  item.uploadStatus ? { ...player.state, activeMessageId: null } : player.state
                }
                onPlay={() => {
                  if (item.uploadStatus) return; // can't play until upload done
                  if (player.state.activeMessageId === item.messageId && player.state.status === 'paused') {
                    player.resume();
                  } else {
                    player.play(item.voiceUrl!, item.messageId, item.duration!);
                  }
                }}
                onPause={() => player.pause()}
                onSeek={(positionMs) => player.seek(positionMs)}
                timestamp={item.timestamp}
                tickIcon={
                  item.uploadStatus === 'uploading' || item.uploadStatus === 'sending'
                    ? { icon: 'checkmark', color: 'transparent' } // placeholder — hide ticks while uploading
                    : item.uploadStatus === 'failed'
                      ? { icon: 'checkmark', color: COLORS.sub }
                      : tickIcon
                }
                uploadStatus={item.uploadStatus}
                uploadProgress={item.uploadProgress}
              />
            </View>
          ) : item.type === 'file' && item.fileUrl && item.fileName ? (
            <FileMessageBubble
              fileName={item.fileName!}
              fileSize={item.fileSize ?? undefined}
              fileUrl={item.fileUrl!}
              mimeType={item.mimeType ?? undefined}
              isOutgoing={true}
            />
          ) : item.type === 'video' && (item.localMediaUri || item.videoUrl) ? (
            <View style={[styles.bubble, styles.bubbleOut, styles.imageBubble]}>
              <View style={styles.videoThumbWrap}>
                <TouchableOpacity
                  style={styles.mediaFill}
                  activeOpacity={0.9}
                  disabled={!!item.uploadStatus}
                  onPress={() => setVideoViewerUrl(item.videoUrl ?? item.localMediaUri ?? null)}
                >
                  {item.localMediaUri ? (
                    <LocalVideoBubblePreview key={item.localMediaUri} uri={item.localMediaUri} />
                  ) : item.thumbnailUrl ? (
                    <Image source={{ uri: item.thumbnailUrl }} style={styles.videoThumbImage} resizeMode="cover" />
                  ) : (
                    <View style={[styles.videoThumbImage, styles.videoPlaceholder]} />
                  )}
                  {!item.uploadStatus && (
                    <View style={styles.videoPlayOverlay}>
                      <AppIcon name="play" size={30} color="#fff" fixedColor />
                    </View>
                  )}
                  {!item.text && !item.uploadStatus && (
                    <View style={styles.imageTimeOverlay}>
                      <AppText style={styles.timeOut}>{formatTime(item.timestamp)}</AppText>
                      <AppIcon name={tickIcon.icon} size={13} color={tickIcon.color} fixedColor />
                    </View>
                  )}
                </TouchableOpacity>
                {item.uploadStatus && (
                  <MediaUploadOverlay
                    status={item.uploadStatus}
                    progress={item.uploadProgress}
                    bytesSent={item.uploadBytesSent}
                    totalBytes={item.uploadBytesTotal}
                    onRetry={() => retryMediaUpload(item)}
                  />
                )}
              </View>
              {item.text ? (
                <View style={styles.mediaCaptionBlock}>
                  <AppText style={[styles.mediaCaptionOut, { color: textColor }]}>{item.text}</AppText>
                  {!item.uploadStatus && (
                    <View style={styles.mediaCaptionTimeRow}>
                      <AppText style={styles.timeOut}>{formatTime(item.timestamp)}</AppText>
                      <AppIcon name={tickIcon.icon} size={13} color={tickIcon.color} fixedColor />
                    </View>
                  )}
                </View>
              ) : null}
            </View>
          ) : item.type === 'image' && (item.localMediaUri || item.imageUrl) ? (
            <View style={[styles.bubble, styles.bubbleOut, styles.imageBubble]}>
              <View style={styles.mediaFrame}>
                <TouchableOpacity
                  style={styles.mediaFill}
                  activeOpacity={0.9}
                  disabled={!!item.uploadStatus}
                  onPress={() => {
                    setViewerImageUrl(item.imageUrl ?? item.localMediaUri ?? null);
                    setViewerVisible(true);
                  }}
                >
                  <Image
                    source={{ uri: item.localMediaUri ?? item.imageUrl! }}
                    style={styles.messageImage}
                    resizeMode="cover"
                  />
                </TouchableOpacity>
                {item.uploadStatus && (
                  <MediaUploadOverlay
                    status={item.uploadStatus}
                    progress={item.uploadProgress}
                    bytesSent={item.uploadBytesSent}
                    totalBytes={item.uploadBytesTotal}
                    onRetry={() => retryMediaUpload(item)}
                  />
                )}
              </View>
              {item.text ? <AppText style={[styles.mediaCaptionOut, { color: textColor }]}>{item.text}</AppText> : null}
              {!item.uploadStatus && (
                <View style={styles.imageTimeOverlay}>
                  <AppText style={styles.timeOut}>{formatTime(item.timestamp)}</AppText>
                  <AppIcon
                    name={tickIcon.icon}
                    size={13}
                    color={tickIcon.color}
                    fixedColor
                  />
                </View>
              )}
            </View>
          ) : (
            <View style={[styles.bubble, styles.bubbleOut]}>
              {/* Forwarded label is only shown for received messages, not sent ones */}
              {item.replyTo && (
                <TouchableOpacity
                  style={[styles.replyBubble, { backgroundColor: 'rgba(30,156,240,0.08)' }]}
                  onPress={() => {
                    const originalMsg = messages.find(m => m.messageId === item.replyTo!.messageId);
                    if (originalMsg) {
                      const index = messages.findIndex(m => m.messageId === item.replyTo!.messageId);
                      if (index !== -1 && listRef.current) {
                        listRef.current.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
                      }
                    }
                  }}
                  activeOpacity={0.7}
                >
                  <View style={[styles.replyBubbleBar, { backgroundColor: COLORS.blue }]} />
                  <View style={{ flex: 1 }}>
                    <AppText style={[styles.replyBubbleSender, { color: COLORS.blue }]}>
                      {item.replyTo.senderId === userId ? 'You' : resolveSenderName(item.replyTo.senderId)}
                    </AppText>
                    <AppText style={[styles.replyBubbleText, { color: textColor, opacity: 0.7 }]} numberOfLines={1}>
                      {item.replyTo.type === 'text' && item.replyTo.text
                        ? item.replyTo.text
                        : item.replyTo.type === 'voice'
                          ? '🎤 Voice message'
                          : item.replyTo.type === 'image'
                            ? '📷 Image'
                            : item.replyTo.type === 'file'
                              ? '📎 File'
                              : item.replyTo.type === 'location'
                                ? '📍 Location'
                                : 'Message'}
                    </AppText>
                  </View>
                </TouchableOpacity>
              )}
              {/* Forwarded label is only shown for received messages, not sent ones */}
              {item.text && <AppText style={[styles.bubbleTextOut, { color: textColor, fontFamily }]}>{item.text}</AppText>}
              <View style={styles.timeOutRow}>
                {item.edited && (
                  <AppText style={[styles.editedLabel, { color: textColor }]}>Edited</AppText>
                )}
                {/* Pending / failed status indicator for offline-queued messages */}
                {item.uploadStatus === 'pending' && (
                  <AppIcon name="time-outline" size={13} color={COLORS.sub} fixedColor />
                )}
                {item.uploadStatus === 'failed' && (
                  <TouchableOpacity
                    onPress={() => retryPendingMessage(item.messageId, item.text ?? '')}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <AppIcon name="alert-circle-outline" size={13} color="#ef4444" fixedColor />
                  </TouchableOpacity>
                )}
                <AppText style={styles.timeOut}>{formatTime(item.timestamp)}</AppText>
                {!item.uploadStatus && (
                  <AppIcon
                    name={tickIcon.icon}
                    size={13}
                    color={tickIcon.color}
                    fixedColor
                  />
                )}
              </View>
            </View>
          )
        )}
      </View>
    );

    return (
      <TouchableOpacity
        activeOpacity={1}
        onPress={onBubblePress}
        onLongPress={item.uploadStatus ? undefined : () => handleLongPressMessage(item.messageId)}
        delayLongPress={300}
      >
        <View style={[isSelected && styles.selectedMessage]}>
          {messageContent}
          {/* Search match highlight — active match is orange-tinted, others blue-tinted */}
          {isSearchMatch && (
            <View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.searchHighlightOverlay,
                isActiveMatch && styles.searchHighlightOverlayActive,
              ]}
            />
          )}
          {/* Flash highlight after navigating from search */}
          {item.messageId === highlightedMessageId && (
            <Animated.View
              pointerEvents="none"
              style={[
                StyleSheet.absoluteFill,
                styles.searchHighlightOverlay,
                styles.searchHighlightOverlayActive,
                { opacity: highlightAnim },
              ]}
            />
          )}
        </View>
      </TouchableOpacity>
    );
  };

  // ── Loading state ───────────────────────────────────────────────
  const renderLoading = () => (
    <View style={styles.centerState}>
      <ActivityIndicator size="large" color={COLORS.blue} />
    </View>
  );

  // ── Empty state ─────────────────────────────────────────────────
  const renderEmpty = () => (
    <View style={styles.centerState}>
      <AppText style={styles.emptyEmoji}>👋</AppText>
      <AppText style={styles.emptyText}>Say hello!</AppText>
    </View>
  );

  // ── Open catalog helper (always closes profile sheet first) ────
  const openCatalogSheet = useCallback(() => {
    setProfileModalOpen(false);
    setActiveCatalogCol(null);
    // Defer slightly so the profile modal dismisses before catalog modal presents.
    setTimeout(() => setCatalogSheetVisible(true), 50);
  }, []);

  return (
    <>
      <SafeAreaView style={[styles.root, { backgroundColor: COLORS.sky1 }]} edges={['left', 'right', 'bottom']}>
        <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <AppBg />

          {/* ── Offline banner ── */}
          {!deviceOnline && (
            <View style={styles.offlineBanner}>
              <AppIcon name="cloud-offline-outline" size={15} color="#fff" fixedColor />
              <AppText fixedColor style={styles.offlineBannerText}>
                No connection — messages will send when back online
              </AppText>
            </View>
          )}

          {/* ── Top bar ── */}
          {searchOpen ? (
            /* ── Inline search bar (replaces top bar while search is active) ── */
            <View style={[styles.topBar, styles.searchBar]}>
              <TouchableOpacity
                onPress={() => {
                  setSearchOpen(false);
                  setSearchQuery('');
                  setSearchMatchIds([]);
                  setSearchCurrentIndex(0);
                  setHighlightedMessageId(null);
                }}
                style={styles.backBtn}
              >
                <AppIcon name="arrow-back" size={24} color={COLORS.blue} fixedColor />
              </TouchableOpacity>

              <TextInput
                ref={searchInputRef}
                style={[styles.searchBarInput, { color: textColor }]}
                placeholder="Search messages…"
                placeholderTextColor={COLORS.sub}
                value={searchQuery}
                onChangeText={handleSearch}
                autoFocus
                returnKeyType="search"
              />

              {/* Match counter */}
              {searchQuery.trim().length > 0 && (
                <AppText style={styles.searchMatchCount}>
                  {searchMatchIds.length === 0
                    ? '0 / 0'
                    : `${searchMatchIds.length - searchCurrentIndex} / ${searchMatchIds.length}`}
                </AppText>
              )}

              {/* Up arrow — older message */}
              <TouchableOpacity
                onPress={() => navigateMatch(-1)}
                disabled={searchMatchIds.length === 0 || searchCurrentIndex === 0}
                style={styles.searchNavBtn}
                hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              >
                <AppIcon
                  name="chevron-up"
                  size={22}
                  color={searchMatchIds.length === 0 || searchCurrentIndex === 0 ? COLORS.sub : COLORS.blue}
                />
              </TouchableOpacity>

              {/* Down arrow — newer message */}
              <TouchableOpacity
                onPress={() => navigateMatch(1)}
                disabled={searchMatchIds.length === 0 || searchCurrentIndex === searchMatchIds.length - 1}
                style={styles.searchNavBtn}
                hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}
              >
                <AppIcon
                  name="chevron-down"
                  size={22}
                  color={
                    searchMatchIds.length === 0 || searchCurrentIndex === searchMatchIds.length - 1
                      ? COLORS.sub
                      : COLORS.blue
                  }
                />
              </TouchableOpacity>
            </View>
          ) : (
          <View style={styles.topBar}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
              <AppIcon name="chevron-back" size={24} color={COLORS.blue} fixedColor />
            </TouchableOpacity>

            {/* Tapping the avatar/name opens Profile Modal */}
            <TouchableOpacity
              style={styles.topBarContact}
              onPress={() => setProfileModalOpen(true)}
              activeOpacity={0.75}
            >
              <Avatar
                initials={getInitials(headerName)}
                color={COLORS.blue}
                size={40}
                imageUrl={headerPhoto}
              />
              <View style={styles.contactInfo}>
                <AppText style={[styles.contactName, { color: textColor, fontFamily }]}>{headerName}</AppText>
                <AppText style={[styles.onlineText, { color: isOnline ? COLORS.blue : FG.secondary }]}>
                  {isGroup
                    ? 'Group chat'
                    : presenceText || 'Tap here for info'}
                </AppText>
              </View>
            </TouchableOpacity>

            {/* Marketplace — opens the other user's product catalog (1-on-1) */}
            {!isGroup && (
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={openCatalogSheet}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <AppIcon name="storefront-outline" size={20} color={COLORS.blue} fixedColor />
              </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.iconBtn} onPress={handleVoiceCall} disabled={outgoingCall.isInitiating}>
              <AppIcon name="call" size={20} color={COLORS.blue} fixedColor />
            </TouchableOpacity>

            {!isGroup && (
              <TouchableOpacity style={styles.iconBtn} onPress={handleVideoCall} disabled={outgoingCall.isInitiating}>
                <AppIcon name="videocam-outline" size={22} color={COLORS.blue} fixedColor />
              </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.iconBtn} onPress={() => setMenuOpen((v) => !v)}>
              <AppIcon name="ellipsis-vertical" size={20} color={COLORS.blue} fixedColor />
            </TouchableOpacity>
          </View>
          )}{/* end searchOpen ternary */}

          {/* ── "Add contact" banner — shown when the chat partner isn't saved ── */}
          {!isGroup && isUnsavedContact && !addContactBannerDismissed && !searchOpen && (
            <View style={[styles.addContactBanner, bevel]}>
              <View style={styles.addContactBannerIcon}>
                <AppIcon name="person-add-outline" size={18} color={COLORS.blue} fixedColor />
              </View>
              <View style={{ flex: 1 }}>
                <AppText style={[styles.addContactBannerTitle, { color: textColor }]} numberOfLines={1}>
                  {otherUserPhone}
                </AppText>
                <AppText style={[styles.addContactBannerSub, { color: FG.secondary }]} numberOfLines={1}>
                  Not in your contacts
                </AppText>
              </View>
              <TouchableOpacity
                style={styles.addContactBannerGhost}
                onPress={() => setAddContactBannerDismissed(true)}
                activeOpacity={0.8}
              >
                <AppText style={[styles.addContactBannerGhostTxt, { color: FG.secondary }]}>Not now</AppText>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.addContactBannerAdd}
                onPress={() => { setPendingSaveContact(null); setAddContactOpen(true); }}
                activeOpacity={0.85}
              >
                <AppText style={styles.addContactBannerAddTxt} fixedColor>Add contact</AppText>
              </TouchableOpacity>
            </View>
          )}

          {/* ── 3-dot menu dropdown ── */}
          <Modal visible={menuOpen} transparent animationType="none" onRequestClose={() => setMenuOpen(false)}>
            <TouchableOpacity
              style={styles.menuBackdrop}
              activeOpacity={1}
              onPress={() => setMenuOpen(false)}
            />
            <View style={[styles.menuCard, bevel]}>
              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  if (muted) {
                    setMuted(false);
                    void saveMutedState(chatId, false, userId);
                    return;
                  }
                  const until = (ms: number | null) =>
                    ms === null ? null : new Date(Date.now() + ms).toISOString();
                  const mute = (ms: number | null) => {
                    setMuted(true);
                    void saveMutedState(chatId, true, userId, until(ms));
                  };
                  Alert.alert('Mute notifications', 'For how long?', [
                    { text: '8 hours', onPress: () => mute(8 * 60 * 60 * 1000) },
                    { text: '1 week', onPress: () => mute(7 * 24 * 60 * 60 * 1000) },
                    { text: 'Always', onPress: () => mute(null) },
                    { text: 'Cancel', style: 'cancel' },
                  ]);
                }}
                activeOpacity={0.75}
              >
                <AppIcon
                  name={muted ? 'notifications' : 'notifications-off'}
                  size={20}
                  color={COLORS.blue}
                  fixedColor
                />
                <AppText style={[styles.menuItemText, { color: textColor }]}>
                  {muted ? 'Unmute Notifications' : 'Mute Notifications'}
                </AppText>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  setSearchOpen(true);
                }}
                activeOpacity={0.75}
              >
                <AppIcon name="search" size={20} color={COLORS.blue} fixedColor />
                <AppText style={[styles.menuItemText, { color: textColor }]}>Search in chat</AppText>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  setContactQuery('');
                  setContactPickerOpen(true);
                }}
                activeOpacity={0.75}
              >
                <AppIcon name="person-outline" size={20} color={COLORS.blue} fixedColor />
                <AppText style={[styles.menuItemText, { color: textColor }]}>Share Contact</AppText>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.menuItem, styles.menuItemDanger]}
                onPress={() => {
                  setMenuOpen(false);
                  Alert.alert(
                    'Clear Chat',
                    'Are you sure you want to clear all messages in this chat?',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Clear', style: 'destructive', onPress: handleClearChat }
                    ]
                  );
                }}
                activeOpacity={0.75}
              >
                <AppIcon name="trash-outline" size={20} color={COLORS.missed} fixedColor />
                <AppText style={[styles.menuItemText, styles.menuItemTextDanger]}>Clear Chat</AppText>
              </TouchableOpacity>
            </View>
          </Modal>

          {/* ── Messages list ── */}
          {loading ? renderLoading() : messagesWithDates.length === 0 ? renderEmpty() : (
            <FlatList
              ref={listRef}
              data={messagesWithDates}
              keyExtractor={(item) =>
                item.type === 'message'
                  ? (item.data.clientId
                      ? `${item.data.senderId}:${item.data.clientId}`
                      : item.data.messageId)
                  : item.type === 'unreadDivider'
                  ? 'unread-divider'
                  : `date-${item.date.getTime()}`
              }
              renderItem={memoizedRenderItem}
              contentContainerStyle={styles.messageList}
              showsVerticalScrollIndicator={false}
              onScroll={handleScroll}
              scrollEventThrottle={100}
              maxToRenderPerBatch={10}
              updateCellsBatchingPeriod={50}
              windowSize={10}
              removeClippedSubviews={true}
              ListFooterComponent={
                typingNames.length > 0
                  ? <TypingIndicator names={typingNames} />
                  : null
              }
              // Only auto-scroll when the user is already near the bottom so
              // we don't interrupt someone reading older messages.
              onContentSizeChange={() => {
                if (distanceFromBottomRef.current <= SCROLL_THRESHOLD) {
                  listRef.current?.scrollToEnd({ animated: false });
                }
              }}
              // Message rows have variable heights, so a scrollToIndex target
              // that hasn't been rendered yet (e.g. the first-unread jump on a
              // long thread) can't be located and would otherwise throw. Nudge
              // to an approximate offset to force those rows to mount, then
              // retry the exact scroll on the next frame.
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: false,
                });
                setTimeout(() => {
                  if (messagesWithDates.length > info.index) {
                    listRef.current?.scrollToIndex({
                      index: info.index,
                      animated: false,
                      viewPosition: 0,
                    });
                  }
                }, 120);
              }}
            />
          )}

          {/* ── Scroll-to-bottom button ───────────────────────────────────── */}
          {/* Appears with a fade when the user scrolls up away from the latest
              message. Tapping it animates back to the bottom and hides itself. */}
          <Animated.View
            style={[styles.scrollToBottomBtn, { opacity: scrollBtnOpacity }]}
            pointerEvents={showScrollBtn ? 'auto' : 'none'}
          >
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={scrollToBottom}
              style={styles.scrollToBottomInner}
            >
              <AppIcon name="chevron-down" size={22} color="#fff" fixedColor />
            </TouchableOpacity>
          </Animated.View>

          {/* ── Cart floating badge button ─────────────────────────────────── */}
          {totalItems > 0 && (
            <TouchableOpacity
              style={styles.cartFab}
              onPress={() => setCartSheetVisible(true)}
              activeOpacity={0.85}
            >
              <LinearGradient colors={GRADIENTS.primary} style={styles.cartFabInner}>
                <AppIcon name="cart" size={20} color="#fff" fixedColor />
                <AppText fixedColor style={styles.cartFabLabel}>View Cart</AppText>
                <View style={styles.cartBadge}>
                  <AppText fixedColor style={styles.cartBadgeText}>{totalItems}</AppText>
                </View>
              </LinearGradient>
            </TouchableOpacity>
          )}

          {/* ── Permission denied message ── */}
          {permissionMessage && (
            <View style={styles.permissionBanner}>
              <AppText style={styles.permissionText}>{permissionMessage}</AppText>
              {showSettingsButton ? (
                <View style={styles.permissionActions}>
                  <TouchableOpacity onPress={handleOpenSettings} style={styles.permissionBtn}>
                    <AppText fixedColor style={styles.permissionBtnText}>Open Settings</AppText>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={dismissPermissionMessage} style={styles.permissionDismissBtn}>
                    <AppIcon name="close" size={18} color={COLORS.sub} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity onPress={dismissPermissionMessage} style={styles.permissionDismissBtn}>
                  <AppIcon name="close" size={18} color={COLORS.sub} />
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* ── Upload error / retry banner ── */}
          {uploadError && (
            <View style={styles.uploadErrorBanner}>
              <AppIcon name="alert-circle-outline" size={16} color={COLORS.missed} fixedColor />
              <AppText style={styles.uploadErrorText}>{uploadError}</AppText>
              {pendingRecordingRef.current && retryCount < MAX_UPLOAD_RETRIES && (
                <TouchableOpacity onPress={handleRetryUpload} style={styles.retryBtn}>
                  <AppText fixedColor style={styles.retryBtnText}>Retry</AppText>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => { setUploadError(null); pendingRecordingRef.current = null; }} style={styles.permissionDismissBtn}>
                <AppIcon name="close" size={18} color={COLORS.sub} />
              </TouchableOpacity>
            </View>
          )}

          {/* ── Message Action Toolbar ── */}
          {showMessageActions && (
            <View style={[styles.actionToolbar, { backgroundColor: FG.glassBg, borderTopColor: FG.glassBorder }]}>
              {/* Selection count header */}
              <View style={styles.actionToolbarCountRow}>
                <TouchableOpacity style={styles.actionToolbarClose} onPress={handleClearSelection}>
                  <AppIcon name="close" size={22} color={FG.secondary} />
                </TouchableOpacity>
                <AppText style={[styles.actionToolbarCount, { color: textColor }]}>
                  {selectedIds.length} selected
                </AppText>
                <View style={{ width: 22 }} />
              </View>

              <View style={styles.actionToolbarContent}>
                {/* Single-selection-only actions */}
                {selectedIds.length === 1 && (
                  <>
                    <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleReplyMessage}>
                      <AppIcon name="arrow-undo-outline" size={22} color={COLORS.blue} />
                      <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Reply</AppText>
                    </TouchableOpacity>

                    {(() => {
                      const EDIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
                      const msg = messages.find(m => m.messageId === selectedMessageId);
                      // Allow editing text, image, and video messages within the edit window
                      if (!msg || msg.senderId !== userId || !['text', 'image', 'video'].includes(msg.type)) return null;
                      const msgTime = msg.timestamp instanceof Date ? msg.timestamp : msg.timestamp ? new Date(msg.timestamp) : null;
                      if (msgTime && Date.now() - msgTime.getTime() > EDIT_WINDOW_MS) return null;
                      return (
                        <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleEditMessage}>
                          <AppIcon name="pencil-outline" size={22} color={COLORS.blue} />
                          <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Edit</AppText>
                        </TouchableOpacity>
                      );
                    })()}

                    {/* Polls can't be copied — no text content to copy. */}
                    {!messages.some(m => selectedIds.includes(m.messageId) && m.type === 'poll') && (
                      <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleCopyMessage}>
                        <AppIcon name="copy-outline" size={22} color={COLORS.blue} />
                        <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Copy</AppText>
                      </TouchableOpacity>
                    )}

                    <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleShowMessageInfo}>
                      <AppIcon name="information-circle-outline" size={22} color={COLORS.blue} />
                      <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Info</AppText>
                    </TouchableOpacity>
                  </>
                )}

                {/* Multi-selection-capable actions. Polls are live, interactive
                    objects tied to this chat, so they can't be forwarded or
                    shared — hide both when any selected message is a poll. */}
                {!messages.some(m => selectedIds.includes(m.messageId) && m.type === 'poll') && (
                  <>
                    <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleForwardMessage}>
                      <AppIcon name="arrow-redo-outline" size={22} color={COLORS.blue} />
                      <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Forward</AppText>
                    </TouchableOpacity>

                    <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleShareMessages}>
                      <AppIcon name="share-social-outline" size={22} color={COLORS.blue} />
                      <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Share</AppText>
                    </TouchableOpacity>
                  </>
                )}

                <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleDeleteMessage}>
                  <AppIcon name="trash-outline" size={22} color={COLORS.missed} fixedColor />
                  <AppText style={[styles.actionToolbarLabel, { color: COLORS.missed }]}>Delete</AppText>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Emoji panel ── */}
          {showEmoji && (
            <View style={[styles.emojiPanel, { backgroundColor: FG.glassBg, borderTopColor: FG.glassBorder }]}>
              <ScrollView horizontal={false} showsVerticalScrollIndicator={false}>
                <View style={styles.emojiGrid}>
                  {EMOJI_LIST.map((e) => (
                    <TouchableOpacity key={e} style={styles.emojiItem} onPress={() => handleSend(e)}>
                      <AppText fixedColor style={styles.emojiChar}>{e}</AppText>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </View>
          )}

          {/* ── Edit Preview ── */}
          {editingMessage && (
            <View style={[styles.replyPreview, { backgroundColor: FG.glassBg, borderTopColor: FG.glassBorder }]}>
              <View style={[styles.replyPreviewBar, { backgroundColor: '#f59e0b' }]} />
              <View style={styles.replyPreviewContent}>
                <View style={{ flex: 1 }}>
                  <AppText style={[styles.replyPreviewLabel, { color: '#f59e0b' }]}>
                    Editing message
                  </AppText>
                  <AppText style={[styles.replyPreviewText, { color: FG.secondary }]} numberOfLines={1}>
                    {editingMessage.text}
                  </AppText>
                </View>
                <TouchableOpacity
                  onPress={() => { setEditingMessage(null); setInput(''); }}
                  style={styles.replyPreviewClose}
                >
                  <AppIcon name="close-circle" size={22} color={FG.secondary} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {replyingTo && (
            <View style={[styles.replyPreview, { backgroundColor: FG.glassBg, borderTopColor: FG.glassBorder }]}>
              <View style={styles.replyPreviewBar} />
              <View style={styles.replyPreviewContent}>
                <View style={{ flex: 1 }}>
                  <AppText style={[styles.replyPreviewLabel, { color: COLORS.blue }]}>
                    Replying to {replyingTo.senderId === userId ? 'yourself' : resolveSenderName(replyingTo.senderId)}
                  </AppText>
                  <AppText style={[styles.replyPreviewText, { color: FG.secondary }]} numberOfLines={1}>
                    {replyingTo.type === 'text' && replyingTo.text
                      ? replyingTo.text
                      : replyingTo.type === 'voice'
                        ? '🎤 Voice message'
                        : replyingTo.type === 'image'
                          ? '📷 Image'
                          : replyingTo.type === 'file'
                            ? `📎 ${replyingTo.fileName || 'File'}`
                            : replyingTo.type === 'location'
                              ? '📍 Location'
                              : 'Message'}
                  </AppText>
                </View>
                <TouchableOpacity onPress={() => setReplyingTo(null)} style={styles.replyPreviewClose}>
                  <AppIcon name="close-circle" size={22} color={FG.secondary} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Input bar / Blocked banner ── */}
          {isBlocked ? (
            /* Show blocked banner + input bar */
            <View style={styles.inputBarWithBanner}>
              {/* Banner */}
              <TouchableOpacity
                style={[styles.blockedBanner, { backgroundColor: FG.glassBg, borderTopColor: FG.glassBorder }]}
                onPress={blockedByMe ? handleUnblockContact : undefined}
                activeOpacity={blockedByMe ? 0.7 : 1}
                disabled={!blockedByMe}
              >
                <View style={styles.blockedBannerContent}>
                  <AppIcon name="ban-outline" size={20} color={COLORS.missed} fixedColor />
                  <View style={{ flex: 1 }}>
                    {blockedByMe ? (
                      <AppText style={[styles.blockedBannerTitle, { color: textColor, fontFamily }]}>
                        You blocked {displayName}. Tap here to unblock
                      </AppText>
                    ) : (
                      <AppText style={[styles.blockedBannerTitle, { color: textColor, fontFamily }]}>
                        {displayName} blocked you
                      </AppText>
                    )}
                  </View>
                  {blockedByMe && (
                    <AppIcon name="chevron-forward" size={20} color={COLORS.blue} fixedColor />
                  )}
                </View>
              </TouchableOpacity>

              {/* Input bar - always show */}
              <View style={styles.inputBar}>
                {isRecording ? (
                  <View style={styles.recordingOverlayContainer}>
                    <VoiceRecordingOverlay
                      durationMs={recorder.state.durationMs}
                      isWarning={recorder.state.isWarning}
                      onCancel={() => recorder.cancelRecording()}
                    />
                  </View>
                ) : (
                  <>
                    {/* Attachments */}
                    <TouchableOpacity style={styles.inputSideBtn} onPress={() => { setShowEmoji(false); setShowAttach(true); }}>
                      <AppIcon name="add" size={26} color={COLORS.sub} />
                    </TouchableOpacity>

                    {/* Text field + emoji */}
                    <View style={styles.inputFieldWrap}>
                      <TextInput
                        style={[styles.inputField, { color: FG.primary }]}
                        placeholder="Message"
                        placeholderTextColor={FG.faint}
                        value={input}
                        onChangeText={(text) => {
                          setInput(text);
                          setTyping(text.length > 0);
                        }}
                        multiline
                        maxLength={500}
                        onFocus={() => { setShowEmoji(false); setShowAttach(false); }}
                      />
                      <TouchableOpacity style={styles.emojiBtn} onPress={() => { setShowAttach(false); setShowEmoji((e) => !e); }}>
                        <AppIcon name={showEmoji ? 'keypad-outline' : 'happy-outline'} size={22} color={COLORS.sub} />
                      </TouchableOpacity>
                    </View>

                    {/* Camera */}
                    <TouchableOpacity style={styles.inputSideBtn} onPress={openCamera}>
                      <AppIcon name="camera-outline" size={22} color={COLORS.sub} />
                    </TouchableOpacity>
                  </>
                )}

                {/* Mic / Send button */}
                {input.trim() ? (
                  <TouchableOpacity onPress={() => handleSend()} activeOpacity={0.85} style={[styles.sendBtn, isSending && { opacity: 0.5 }]} disabled={isSending}>
                    <LinearGradient colors={GRADIENTS.primary} style={styles.sendBtnInner}>
                      {isSending
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <AppIcon name="send" size={19} color="#fff" fixedColor />}
                    </LinearGradient>
                  </TouchableOpacity>
                ) : (
                  <View {...micPanResponder.panHandlers} style={styles.sendBtn}>
                    <LinearGradient
                      colors={isRecording ? ['#ef4444', '#dc2626'] : ['#7dd3fc', '#38bdf8']}
                      style={styles.sendBtnInner}
                    >
                      <AppIcon name="mic" size={19} color="#fff" fixedColor />
                    </LinearGradient>
                  </View>
                )}
              </View>
            </View>
          ) : (
            /* Normal Input Bar */
            <View style={styles.inputBar}>
            {isRecording ? (
              <View style={styles.recordingOverlayContainer}>
                <VoiceRecordingOverlay
                  durationMs={recorder.state.durationMs}
                  isWarning={recorder.state.isWarning}
                  onCancel={() => recorder.cancelRecording()}
                />
              </View>
            ) : (
              <>
                {/* Attachments */}
                <TouchableOpacity style={styles.inputSideBtn} onPress={() => { setShowEmoji(false); setShowAttach(true); }}>
                  <AppIcon name="add" size={26} color={COLORS.sub} />
                </TouchableOpacity>

                {/* Text field + emoji */}
                <View style={styles.inputFieldWrap}>
                  <TextInput
                    style={[styles.inputField, { color: FG.primary }]}
                    placeholder="Message"
                    placeholderTextColor={FG.faint}
                    value={input}
                    onChangeText={(text) => {
                      setInput(text);
                      setTyping(text.length > 0);
                    }}
                    multiline
                    maxLength={500}
                    onFocus={() => { setShowEmoji(false); setShowAttach(false); }}
                  />
                  <TouchableOpacity style={styles.emojiBtn} onPress={() => { setShowAttach(false); setShowEmoji((e) => !e); }}>
                    <AppIcon name={showEmoji ? 'keypad-outline' : 'happy-outline'} size={22} color={COLORS.sub} />
                  </TouchableOpacity>
                </View>

                {/* Camera */}
                <TouchableOpacity style={styles.inputSideBtn} onPress={openCamera}>
                  <AppIcon name="camera-outline" size={22} color={COLORS.sub} />
                </TouchableOpacity>
              </>
            )}

            {/* Mic / Send button */}
            {input.trim() ? (
              <TouchableOpacity onPress={() => handleSend()} activeOpacity={0.85} style={[styles.sendBtn, isSending && { opacity: 0.5 }]} disabled={isSending}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.sendBtnInner}>
                  {isSending
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <AppIcon name="send" size={19} color="#fff" fixedColor />}
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <View {...micPanResponder.panHandlers} style={styles.sendBtn}>
                <LinearGradient
                  colors={isRecording ? ['#ef4444', '#dc2626'] : ['#7dd3fc', '#38bdf8']}
                  style={styles.sendBtnInner}
                >
                  <AppIcon name="mic" size={19} color="#fff" fixedColor />
                </LinearGradient>
              </View>
            )}
          </View>
          )}

          {/* ── Upload progress indicator ── */}
          {(isUploading || uploadingImage) && (
            <View style={styles.uploadProgressBar}>
              <View style={[styles.uploadProgressFill, { width: `${isUploading ? uploadProgress : imageUploadProgress}%` }]} />
            </View>
          )}
        </KeyboardAvoidingView>
      </SafeAreaView>

      {/* ── Attachments sheet ── */}
      <Modal visible={showAttach} transparent animationType="slide" onRequestClose={() => setShowAttach(false)}>
        <TouchableOpacity style={styles.attachOverlay} activeOpacity={1} onPress={() => setShowAttach(false)} />
        <View style={[styles.attachSheet, { backgroundColor: FG.glassBg }]}>
          <View style={styles.attachHandle} />
          <AppText style={[styles.attachTitle, { color: textColor, fontFamily }]}>Share</AppText>
          <View style={styles.attachGrid}>
            {[
              { icon: 'image-outline'    as const, label: 'Photos',   action: () => { setShowAttach(false); setTimeout(() => openGallery(), 350); } },
              { icon: 'camera-outline'   as const, label: 'Camera',   action: () => { setShowAttach(false); setTimeout(() => openCamera(), 350); } },
              { icon: 'document-outline' as const, label: 'Files',    action: () => { setShowAttach(false); setTimeout(() => openDocuments(), 350); } },
              { icon: 'person-outline'   as const, label: 'Contact',  action: () => { setShowAttach(false); setSelectedContactKeys([]); setContactQuery(''); setTimeout(() => setContactPickerOpen(true), 350); } },
              { icon: 'stats-chart-outline' as const, label: 'Poll',  action: () => { setShowAttach(false); setTimeout(() => setPollModalOpen(true), 350); } },
            ].map((item) => (
              <TouchableOpacity key={item.label} style={[styles.attachItem, bevel]}
                onPress={item.action} activeOpacity={0.8}>
                <View style={styles.attachIconWrap}>
                  <AppIcon name={item.icon} size={26} color={COLORS.blue} fixedColor />
                </View>
                <AppText style={[styles.attachLabel, { color: textColor, fontFamily }]}>{item.label}</AppText>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </Modal>

      {/* ── Contact Picker Modal ── */}
      <Modal visible={contactPickerOpen} transparent animationType="slide" onRequestClose={() => { setContactPickerOpen(false); setSelectedContactKeys([]); }}>
        <TouchableOpacity style={styles.attachOverlay} activeOpacity={1} onPress={() => { setContactPickerOpen(false); setSelectedContactKeys([]); }} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.contactPickerSheet, { backgroundColor: FG.glassBg }]}>
            <AppBg />
            <View style={styles.attachHandle} />
            <AppText style={[styles.attachTitle, { color: textColor, fontFamily }]}>
              {selectedContactKeys.length > 0 ? `${selectedContactKeys.length} selected` : 'Share Contacts'}
            </AppText>

            {/* Search */}
            <View style={[styles.contactSearchWrap, bevel]}>
              <AppIcon name="search-outline" size={16} color={COLORS.sub} />
              <TextInput
                style={[styles.contactSearchInput, { color: textColor }]}
                placeholder="Search contacts…"
                placeholderTextColor={COLORS.sub}
                value={contactQuery}
                onChangeText={setContactQuery}
              />
              {contactQuery.length > 0 && (
                <TouchableOpacity onPress={() => setContactQuery('')}>
                  <AppIcon name="close-circle" size={16} color={COLORS.sub} />
                </TouchableOpacity>
              )}
            </View>

            {/* Contact list */}
            <ScrollView
              showsVerticalScrollIndicator={false}
              style={styles.contactPickerList}
              contentContainerStyle={styles.contactPickerContent}
              keyboardShouldPersistTaps="handled"
            >
              {contactsLoading ? (
                <View style={{ alignItems: 'center', paddingTop: 60, gap: 12 }}>
                  <ActivityIndicator size="large" color={COLORS.blue} />
                  <AppText style={{ color: COLORS.sub, fontSize: 14 }}>Loading contacts...</AppText>
                </View>
              ) : (!phoneContacts || phoneContacts.length === 0) ? (
                <View style={{ alignItems: 'center', paddingTop: 60, gap: 12 }}>
                  <AppIcon name="people-outline" size={48} color={COLORS.sub} />
                  <AppText style={{ color: textColor, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
                    {contactsPermission ? 'No Contacts Found' : 'Contacts Permission Needed'}
                  </AppText>
                  <AppText style={{ color: COLORS.sub, fontSize: 13, textAlign: 'center', paddingHorizontal: 40 }}>
                    {contactsError
                      ? contactsError
                      : contactsPermission
                        ? 'Add contacts to your phone to share them here'
                        : 'Allow contacts access to share people from your phone'}
                  </AppText>
                  <TouchableOpacity style={{ marginTop: 6, borderRadius: 999, overflow: 'hidden' }} onPress={() => reloadContacts()} activeOpacity={0.85}>
                    <LinearGradient colors={GRADIENTS.primary} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 10, paddingHorizontal: 20 }}>
                      <AppIcon name="refresh" size={16} color="#fff" fixedColor />
                      <AppText style={{ color: '#fff', fontSize: 14, fontWeight: '700' }} fixedColor>
                        {contactsPermission ? 'Reload' : 'Grant Permission'}
                      </AppText>
                    </LinearGradient>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  {phoneContacts
                    .filter(c => !contactQuery.trim() || c.displayName.toLowerCase().includes(contactQuery.toLowerCase()) || c.phone.includes(contactQuery))
                    .map((c) => {
                      const key = c.userId || c.phone;
                      const selected = selectedContactKeys.includes(key);
                      return (
                        <TouchableOpacity
                          key={key}
                          style={[styles.contactPickerRow, bevel, selected && { borderColor: COLORS.blue, borderWidth: 1.5 }]}
                          activeOpacity={0.75}
                          onPress={() => toggleContactSelect(key)}
                        >
                          <Avatar
                            initials={c.displayName.slice(0, 2).toUpperCase()}
                            color={COLORS.blue}
                            size={44}
                            imageUrl={c.photoUri || c.firebasePhotoURL || null}
                          />
                          <View style={{ flex: 1, marginLeft: 12 }}>
                            <AppText style={[{ fontSize: 14, fontWeight: '600' }, { color: textColor }]}>{c.displayName}</AppText>
                            <AppText style={{ fontSize: 12, color: COLORS.sub, marginTop: 2 }}>{c.phone}</AppText>
                            {c.isSaved && (
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2 }}>
                                <AppIcon name="checkmark-circle" size={11} color={COLORS.green} fixedColor />
                                <AppText style={{ fontSize: 10.5, color: COLORS.green, fontWeight: '600' }}>On ChitChatBusiness</AppText>
                              </View>
                            )}
                          </View>
                          {/* Selection checkbox */}
                          <View style={[styles.contactCheckbox, selected && styles.contactCheckboxOn]}>
                            {selected && <AppIcon name="checkmark" size={14} color="#fff" fixedColor />}
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  {phoneContacts.filter(c => !contactQuery.trim() || c.displayName.toLowerCase().includes(contactQuery.toLowerCase()) || c.phone.includes(contactQuery)).length === 0 && contactQuery.trim() && (
                    <View style={{ alignItems: 'center', paddingTop: 40, gap: 10 }}>
                      <AppIcon name="search-outline" size={44} color={COLORS.sub} />
                      <AppText style={{ color: COLORS.sub, fontSize: 14 }}>No contacts match "{contactQuery}"</AppText>
                    </View>
                  )}
                </>
              )}
            </ScrollView>

            {/* Send button — appears once one or more contacts are selected */}
            {selectedContactKeys.length > 0 && (
              <TouchableOpacity activeOpacity={0.85} onPress={sendSelectedContacts} style={styles.contactSendBtn}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.contactSendBtnGrad}>
                  <AppIcon name="send" size={18} color="#fff" fixedColor />
                  <AppText style={styles.contactSendBtnText} fixedColor>
                    Send {selectedContactKeys.length} contact{selectedContactKeys.length === 1 ? '' : 's'}
                  </AppText>
                </LinearGradient>
              </TouchableOpacity>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── In-app camera ── */}
      {cameraOpen && Platform.OS !== 'web' && (
        <Modal visible animationType="slide" onRequestClose={() => setCameraOpen(false)}>
          <View style={{ flex: 1, backgroundColor: '#000' }}>
            <CameraView ref={cameraRef} style={{ flex: 1 }} facing={cameraFacing}>
              {/* Close (X) — top-right corner */}
              <TouchableOpacity
                onPress={() => setCameraOpen(false)}
                style={styles.cameraTopCloseBtn}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <AppIcon name="close" size={26} color="#fff" fixedColor />
              </TouchableOpacity>

              {/* Recent photos strip — tap one to caption & send (WhatsApp-style) */}
              {recentPhotos.length > 0 && (
                <View style={styles.cameraRollStrip}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.cameraRollContent}
                  >
                    {recentPhotos.map((p) => (
                      <TouchableOpacity
                        key={p.id}
                        activeOpacity={0.85}
                        style={styles.cameraRollThumbWrap}
                        onPress={() => {
                          setCameraOpen(false);
                          setMediaCaption('');
                          const isVid = p.isVideo ?? /\.(mp4|mov|m4v|3gp|avi)$/i.test(p.uri);
                          setPendingMedia([{
                            uri: p.uri,
                            kind: isVid ? 'video' : 'image',
                            width: p.width,
                            height: p.height,
                          }]);
                          setPendingMediaIndex(0);
                        }}
                      >
                        <Image source={{ uri: p.uri }} style={styles.cameraRollThumb} resizeMode="cover" />
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}
              <View style={styles.cameraControls}>
                {/* Gallery — opens the photo/video picker */}
                <TouchableOpacity
                  onPress={() => { setCameraOpen(false); setTimeout(() => openGallery(), 350); }}
                  style={styles.cameraCloseBtn}
                >
                  <AppIcon name="images-outline" size={26} color="#fff" fixedColor />
                </TouchableOpacity>
                <TouchableOpacity style={styles.cameraShutterBtn} onPress={takePicture}>
                  <View style={styles.cameraShutter} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setCameraFacing((f) => (f === 'back' ? 'front' : 'back'))}
                  style={styles.cameraFlipBtn}
                >
                  <AppIcon name="camera-reverse-outline" size={28} color="#fff" fixedColor />
                </TouchableOpacity>
              </View>
            </CameraView>
          </View>
        </Modal>
      )}

      {/* ── Media preview + caption (before sending) ── */}
      {pendingMedia && pendingMedia.length > 0 && (
        <Modal visible animationType="slide" onRequestClose={() => { setPendingMedia(null); setPendingMediaIndex(0); setMediaCaption(''); }}>
          <KeyboardAvoidingView
            style={{ flex: 1, backgroundColor: '#000' }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            {/* Close button */}
            <TouchableOpacity
              style={styles.mediaPreviewClose}
              onPress={() => { setPendingMedia(null); setPendingMediaIndex(0); setMediaCaption(''); }}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <AppIcon name="close" size={28} color="#fff" fixedColor />
            </TouchableOpacity>

            {/* Full-Screen Carousel Preview */}
            {pendingMedia && pendingMedia.length > 0 && (
              <View style={styles.carouselContainer}>
                {/* Main Carousel - Full Screen with Swipe */}
                <Animated.View
                  style={[
                    styles.carouselViewport,
                    {
                      transform: [{ translateX: carouselScrollAnim }],
                    },
                  ]}
                  onTouchStart={(e) => {
                    carouselSwipeStartX.current = e.nativeEvent.pageX;
                  }}
                  onTouchEnd={(e) => {
                    const endX = e.nativeEvent.pageX;
                    const distance = endX - carouselSwipeStartX.current;
                    const threshold = 50;
                    
                    if (Math.abs(distance) > threshold) {
                      let newIndex = pendingMediaIndex;
                      if (distance > 0) {
                        // Swiped right - show previous
                        newIndex = pendingMediaIndex === 0 ? pendingMedia.length - 1 : pendingMediaIndex - 1;
                      } else {
                        // Swiped left - show next
                        newIndex = pendingMediaIndex === pendingMedia.length - 1 ? 0 : pendingMediaIndex + 1;
                      }
                      
                      // Animate to new position
                      Animated.timing(carouselScrollAnim, {
                        toValue: 0,
                        duration: 300,
                        useNativeDriver: true,
                        easing: Easing.out(Easing.cubic),
                      }).start();
                      
                      setPendingMediaIndex(newIndex);
                    } else {
                      // Reset animation
                      Animated.timing(carouselScrollAnim, {
                        toValue: 0,
                        duration: 150,
                        useNativeDriver: true,
                      }).start();
                    }
                  }}
                >
                  {pendingMedia[pendingMediaIndex].kind === 'video' ? (
                    <VideoView
                      player={previewVideoPlayer}
                      style={styles.carouselFullMedia}
                      contentFit="contain"
                      nativeControls
                    />
                  ) : (
                    <Image 
                      source={{ uri: pendingMedia[pendingMediaIndex].uri }} 
                      style={styles.carouselFullMedia} 
                      resizeMode="contain" 
                    />
                  )}
                </Animated.View>

                {/* Thumbnail row at bottom with delete button overlay */}
                {pendingMedia.length > 1 && (
                  <View style={styles.carouselThumbnailRowContainer}>
                    {/* Delete button overlay */}
                    <TouchableOpacity
                      style={styles.deleteMediaBtn}
                      onPress={() => {
                        const newMedia = pendingMedia.filter((_, i) => i !== pendingMediaIndex);
                        if (newMedia.length === 0) {
                          setPendingMedia(null);
                          setPendingMediaIndex(0);
                        } else {
                          setPendingMedia(newMedia);
                          setPendingMediaIndex(Math.min(pendingMediaIndex, newMedia.length - 1));
                        }
                      }}
                    >
                      <AppIcon name="trash-outline" size={24} color="#fff" fixedColor />
                    </TouchableOpacity>
                    
                    {/* Thumbnails row */}
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={styles.carouselThumbnailContent}
                    >
                      {pendingMedia.map((media, idx) => (
                        <TouchableOpacity
                          key={idx}
                          style={[
                            styles.carouselThumbnail,
                            idx === pendingMediaIndex && styles.carouselThumbnailActive,
                          ]}
                          onPress={() => setPendingMediaIndex(idx)}
                        >
                          {media.kind === 'video' ? (
                            <>
                              <Image
                                source={{ uri: media.uri }}
                                style={styles.carouselThumbnailImage}
                                resizeMode="cover"
                              />
                              <View style={styles.carouselVideoPlayIcon}>
                                <AppIcon name="play" size={14} color="#fff" fixedColor />
                              </View>
                            </>
                          ) : (
                            <Image
                              source={{ uri: media.uri }}
                              style={styles.carouselThumbnailImage}
                              resizeMode="cover"
                            />
                          )}
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                )}

                {/* Caption input at very bottom */}
                <View style={styles.carouselCaptionBar}>
                  <View style={styles.carouselCaptionInputWrap}>
                    <TextInput
                      style={styles.carouselCaptionInput}
                      placeholder="Add a caption..."
                      placeholderTextColor="rgba(255,255,255,0.6)"
                      value={mediaCaption}
                      onChangeText={setMediaCaption}
                      multiline
                      maxLength={1024}
                    />
                  </View>
                  <TouchableOpacity style={styles.carouselSendBtn} onPress={sendPendingMedia}>
                    <AppIcon name="send" size={22} color="#fff" fixedColor />
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </KeyboardAvoidingView>
        </Modal>
      )}

      {/* ── Full-screen video viewer ── */}
      {videoViewerUrl && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setVideoViewerUrl(null)}>
          <View style={styles.videoViewerContainer}>
            <VideoView
              player={viewerVideoPlayer}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              nativeControls
            />
            <TouchableOpacity
              style={styles.imageViewerCloseBtn}
              onPress={() => setVideoViewerUrl(null)}
            >
              <AppIcon name="close" size={32} color="#fff" fixedColor />
            </TouchableOpacity>
          </View>
        </Modal>
      )}

      {/* ── Full-screen image viewer ── */}
      {viewerVisible && viewerImageUrl && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => setViewerVisible(false)}
        >
          <View style={styles.imageViewerContainer}>
            <TouchableOpacity
              style={styles.imageViewerBackdrop}
              activeOpacity={1}
              onPress={() => setViewerVisible(false)}
            >
              <Image
                source={{ uri: viewerImageUrl }}
                style={styles.imageViewerImage}
                resizeMode="contain"
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.imageViewerCloseBtn}
              onPress={() => setViewerVisible(false)}
            >
              <AppIcon name="close" size={32} color="#fff" fixedColor />
            </TouchableOpacity>
          </View>
        </Modal>
      )}

      {/* ── Cart Sheet ── */}
      <Modal
        visible={cartSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCartSheetVisible(false)}
      >
        <CartSheet
          onClose={() => setCartSheetVisible(false)}
          onSendOrder={() => {
            if (!userId || cartItems.length === 0) return;
            // Build the order payload and open the payment screen instead of
            // sending directly. The order is finalized only on payment success.
            const currency = cartItems[0]?.item.price.match(/^[^0-9]*/)?.[0] ?? '';
            const orderItems = cartItems.map((c) => ({
              id:             c.item.id,
              name:           c.item.name,
              price:          c.item.price,
              imageUri:       c.item.imageUri ?? null,
              imageObjectKey: c.item.imageObjectKey ?? null,
              quantity:       c.quantity,
            }));
            const totalStr = totalPrice != null ? totalPrice.toFixed(2) : null;
            const paymentItems: PaymentOrderItem[] = orderItems.map((o) => ({
              id: o.id, name: o.name, price: o.price,
              imageUri: o.imageUri, quantity: o.quantity,
            }));
            setPendingOrder({ items: paymentItems, currency, total: totalStr, orderItems });
            setCartSheetVisible(false);
            setPaymentVisible(true);
          }}
        />
      </Modal>

      {/* ── Payment Sheet ── */}
      <PaymentSheet
        visible={paymentVisible}
        items={pendingOrder?.items ?? []}
        currency={pendingOrder?.currency ?? ''}
        total={pendingOrder?.total ?? null}
        onCancel={() => { setPaymentVisible(false); setPendingOrder(null); }}
        onPaymentSuccess={async () => {
          setPaymentVisible(false);
          if (!userId || !pendingOrder) { setPendingOrder(null); return; }
          const { orderItems, total: totalStr, currency: cur } = pendingOrder;
          setPendingOrder(null);
          const result = await sendOrderMessage(chatId, userId, orderItems, totalStr, cur);
          if (!result.success) {
            Alert.alert('Error', 'Could not send the order. Please try again.');
            return;
          }
          addOptimisticMessage({
            messageId: result.messageId,
            senderId: userId,
            type: 'order',
            order: { items: orderItems, total: totalStr, currency: cur },
          });
          clearCart();
          await checkAndTriggerAutoResponder();
        }}
      />

      {/* ── Create Poll Modal ── */}
      <CreatePollModal
        visible={pollModalOpen}
        onClose={() => setPollModalOpen(false)}
        onCreate={async (question, options, multiple) => {
          setPollModalOpen(false);
          if (!userId) return;
          const result = await sendPollMessage(chatId, userId, { question, options, multiple });
          if (!result.success) {
            Alert.alert('Error', 'Could not create the poll. Please try again.');
            return;
          }
          // Show the poll immediately (before the Firestore snapshot arrives).
          const optionObjs = options.map((t, i) => ({ id: `opt${i}`, text: t.trim() })).filter((o) => o.text);
          const votes: Record<string, string[]> = {};
          optionObjs.forEach((o) => { votes[o.id] = []; });
          addOptimisticMessage({
            messageId: result.messageId,
            senderId: userId,
            type: 'poll',
            poll: { question: question.trim(), options: optionObjs, votes, multiple },
          });
          await checkAndTriggerAutoResponder();
        }}
      />

      {/* ── Catalog Sheet ── */}
      <Modal
        visible={catalogSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setCatalogSheetVisible(false)}
      >
        <CatalogBrowseSheet
          collections={sellerCollections}
          catalog={sellerCatalog}
          sellerUid={otherUserId ?? ''}
          loading={loadingCatalog}
          activeColId={activeCatalogCol}
          onSelectCol={setActiveCatalogCol}
          textColor={textColor}
          fgSecondary={FG.secondary}
          onClose={() => setCatalogSheetVisible(false)}
          onViewCart={() => { setCatalogSheetVisible(false); setCartSheetVisible(true); }}
        />
      </Modal>

      {/* ── Business QR Share Sheet ── */}
      <BusinessQrShareSheet
        visible={qrShareVisible}
        onClose={() => setQrShareVisible(false)}
        businessUid={otherUserId ?? ''}
        displayName={displayName}
        photoURL={headerPhoto ?? null}
        initials={getInitials(displayName)}
        profile={businessProfile}
      />

      {/* ── Profile Modal — Business Profile Overview ── */}
      <Modal
        visible={profileModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setProfileModalOpen(false)}
      >
        <View style={styles.profileOverlay}>
          <TouchableOpacity
            style={styles.profileBackdrop}
            activeOpacity={1}
            onPress={() => setProfileModalOpen(false)}
          />
          <View style={[styles.profileSheet, { backgroundColor: FG.glassBg, borderColor: FG.glassBorder }]}>
            <AppBg />

            {/* ── Handle ── */}
            <View style={styles.profileHandle} />

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 40 }}>

              {/* ── Hero header: gradient banner + avatar ── */}
              <View style={profileHeroStyles.hero}>
                <LinearGradient
                  colors={[COLORS.blue, COLORS.blueDark]}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={profileHeroStyles.heroBanner}
                />
                {/* Edit pill — only when the contact is already saved */}
                {!isGroup && !!savedContactName && (
                  <TouchableOpacity
                    style={profileHeroStyles.editBtn}
                    onPress={() => { setPendingSaveContact(null); setProfileModalOpen(false); setAddContactOpen(true); }}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <AppIcon name="create-outline" size={18} color="#fff" fixedColor />
                  </TouchableOpacity>
                )}
                {/* Close pill */}
                <TouchableOpacity
                  style={profileHeroStyles.closeBtn}
                  onPress={() => setProfileModalOpen(false)}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                >
                  <AppIcon name="close" size={18} color="#fff" fixedColor />
                </TouchableOpacity>
                {/* Avatar centred on bottom edge of banner */}
                <View style={profileHeroStyles.avatarRing}>
                  <Avatar
                    initials={getInitials(displayName)}
                    color={COLORS.blue}
                    size={78}
                    imageUrl={headerPhoto}
                  />
                </View>
              </View>

              {/* ── Name + status ── */}
              <View style={profileHeroStyles.nameBlock}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <AppText style={[profileHeroStyles.name, { color: textColor, fontFamily }]}>
                    {displayName}
                  </AppText>
                  {!isGroup && businessProfile ? (
                    <IdentityVerificationBadge
                      verified={businessProfile.identityVerified}
                      compact
                    />
                  ) : null}
                </View>
                <AppText style={[profileHeroStyles.accountType, { color: FG.secondary }]}>
                  {isGroup ? `Group · ${messages.length} messages` : 'Business account'}
                </AppText>
                <AppText style={[profileHeroStyles.presence, { color: isOnline ? COLORS.blue : FG.secondary }]}>
                  {isGroup ? '' : (presenceText || '')}
                </AppText>
              </View>

              {/* ── Three action buttons: Call · Catalog · Share ── */}
              {!isGroup && (
                <View style={profileHeroStyles.actions}>
                  {[
                    { icon: 'call-outline' as const,        label: 'Call',    onPress: () => { setProfileModalOpen(false); handleVoiceCall(); } },
                    { icon: 'storefront-outline' as const,  label: 'Catalog', onPress: openCatalogSheet },
                    { icon: 'qr-code-outline' as const,     label: 'Share',   onPress: openQrShare },
                  ].map(a => (
                    <TouchableOpacity
                      key={a.label}
                      style={profileHeroStyles.actionBtn}
                      onPress={a.onPress}
                      activeOpacity={0.75}
                    >
                      <View style={profileHeroStyles.actionIconWrap}>
                        <AppIcon name={a.icon} size={22} color={COLORS.blue} fixedColor />
                      </View>
                      <AppText style={[profileHeroStyles.actionLabel, { color: FG.secondary }]}>
                        {a.label}
                      </AppText>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {/* ── Add to Contacts (only when not already saved) ── */}
              {!isGroup && isUnsavedContact && (
                <View style={{ paddingHorizontal: 16, marginBottom: 16 }}>
                  <TouchableOpacity
                    style={[profileHeroStyles.addContactBtn, bevel]}
                    activeOpacity={0.85}
                    onPress={() => { setPendingSaveContact(null); setProfileModalOpen(false); setAddContactOpen(true); }}
                  >
                    <AppIcon name="person-add-outline" size={18} color={COLORS.blue} fixedColor />
                    <AppText style={[profileHeroStyles.addContactText, { color: COLORS.blue }]}>
                      Add to Contacts
                    </AppText>
                  </TouchableOpacity>
                </View>
              )}

              {/* ── Business info rows ── */}
              {!isGroup && (
                <View style={profileHeroStyles.infoSection}>
                  {/* Presence / hours */}
                  <View style={profileHeroStyles.infoRow}>
                    <AppIcon name="time-outline" size={18} color={COLORS.blue} fixedColor />
                    <View style={{ flex: 1 }}>
                      <AppText style={[profileHeroStyles.infoText, { color: textColor }]}>
                        {businessProfile && isCurrentlyOpen(businessProfile.workSchedule)
                          ? 'Open now'
                          : 'Closed now'}
                      </AppText>
                      {businessProfile && (
                        <AppText style={{ fontSize: 12, color: FG.secondary, marginTop: 1 }}>
                          {getTodayHoursLabel(businessProfile.workSchedule)}
                        </AppText>
                      )}
                    </View>
                  </View>

                  {/* Full working hours list */}
                  {businessProfile && Object.keys(businessProfile.workSchedule || {}).length > 0 && (
                    <View style={profileHeroStyles.hoursCard}>
                      <AppText style={profileHeroStyles.hoursCardLabel}>OPENING HOURS</AppText>
                      {getWorkHoursSummary(businessProfile.workSchedule).map((row) => (
                        <View key={row.day} style={profileHeroStyles.hoursRow}>
                          <AppText style={[profileHeroStyles.hoursDay, { color: textColor }]}>
                            {row.day}
                          </AppText>
                          <AppText
                            style={[
                              profileHeroStyles.hoursValue,
                              { color: row.isClosed ? FG.secondary : textColor },
                            ]}
                          >
                            {row.text}
                          </AppText>
                        </View>
                      ))}
                    </View>
                  )}

                  {/* Contact details */}
                  {businessProfile?.phone ? (
                    <View style={profileHeroStyles.infoRow}>
                      <AppIcon name="call-outline" size={18} color={COLORS.blue} fixedColor />
                      <AppText style={[profileHeroStyles.infoText, { color: textColor }]} numberOfLines={1}>
                        {businessProfile.phone}
                      </AppText>
                    </View>
                  ) : null}
                  {businessProfile?.email ? (
                    <View style={profileHeroStyles.infoRow}>
                      <AppIcon name="mail-outline" size={18} color={COLORS.blue} fixedColor />
                      <AppText style={[profileHeroStyles.infoText, { color: textColor }]} numberOfLines={1}>
                        {businessProfile.email}
                      </AppText>
                    </View>
                  ) : null}
                  {businessProfile?.website ? (
                    <View style={profileHeroStyles.infoRow}>
                      <AppIcon name="globe-outline" size={18} color={COLORS.blue} fixedColor />
                      <AppText style={[profileHeroStyles.infoText, { color: textColor }]} numberOfLines={1}>
                        {businessProfile.website}
                      </AppText>
                    </View>
                  ) : null}

                  {/* Industry badge */}
                  {businessProfile?.industry ? (() => {
                    const cat = INDUSTRY_CATEGORIES.find(c => c.id === businessProfile.industry);
                    return cat ? (
                      <View style={profileHeroStyles.infoRow}>
                        <AppIcon name="briefcase-outline" size={18} color={COLORS.blue} fixedColor />
                        <View style={profileHeroStyles.industryBadge}>
                          <AppText style={profileHeroStyles.industryEmoji}>{cat.emoji}</AppText>
                          <AppText style={[profileHeroStyles.industryLabel, { color: textColor }]}>
                            {cat.label}
                          </AppText>
                        </View>
                      </View>
                    ) : null;
                  })() : null}

                  {/* About / Description */}
                  {businessProfile?.description ? (
                    <View style={profileHeroStyles.aboutCard}>
                      <AppText style={[profileHeroStyles.aboutLabel, { color: FG.secondary }]}>
                        ABOUT
                      </AppText>
                      <AppText style={[profileHeroStyles.aboutText, { color: textColor }]}>
                        {businessProfile.description}
                      </AppText>
                    </View>
                  ) : null}

                  {/* Physical address */}
                  {businessProfile?.address && (
                    businessProfile.address.street ||
                    businessProfile.address.city ||
                    businessProfile.address.country
                  ) ? (
                    <View style={profileHeroStyles.infoRow}>
                      <AppIcon name="location-outline" size={18} color={COLORS.blue} fixedColor />
                      <AppText style={[profileHeroStyles.infoText, { color: textColor }]}>
                        {[
                          businessProfile.address.street,
                          businessProfile.address.city,
                          businessProfile.address.province,
                          businessProfile.address.postalCode,
                          businessProfile.address.country,
                        ].filter(Boolean).join(', ')}
                      </AppText>
                    </View>
                  ) : null}

                </View>
              )}

              {/* ── Divider ── */}
              <View style={profileHeroStyles.divider} />

              {/* ── Group participants / past members ── */}
              {isGroup && (
                <View style={{ paddingHorizontal: 16 }}>
                  <AppText style={[styles.profileSectionLabel, { color: FG.secondary }]}>
                    PARTICIPANTS ({groupMembers.length})
                  </AppText>
                  {loadingMembers ? (
                    <View style={[styles.profileMemberLoadingBox, bevel]}>
                      <ActivityIndicator size="small" color={COLORS.blue} />
                      <AppText style={[styles.profileMemberLoadingText, { color: FG.secondary }]}>
                        Loading participants...
                      </AppText>
                    </View>
                  ) : groupMembers.map(member => {
                    const statusText = member.status === 'online' ? 'Online' : member.status === 'away' ? 'Away' : 'Offline';
                    return (
                      <View key={member.userId} style={[styles.profileMemberRow, bevel]}>
                        <Avatar initials={getInitials(member.displayName)} color={COLORS.blue} size={42} imageUrl={member.photoURL} status={member.status} />
                        <View style={{ flex: 1 }}>
                          <AppText style={[styles.profileMemberName, { color: textColor, fontFamily }]}>
                            {member.displayName}{member.userId === userId ? <AppText style={[styles.profileMemberYou, { color: FG.secondary }]}> (You)</AppText> : null}
                          </AppText>
                          <AppText style={[styles.profileMemberStatus, { color: FG.secondary }]}>{statusText}</AppText>
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}

              {/* ── Shared media ── */}
              <View style={{ paddingHorizontal: 16 ,marginBottom: 20}}>
                <AppText style={[styles.profileSectionLabel, { color: FG.secondary }]}>
                  SHARED MEDIA
                </AppText>
                {messages.filter(m => m.type === 'image').length > 0 ? (
                  <TouchableOpacity style={[styles.profileMediaRow, bevel]} activeOpacity={0.8}>
                    <AppText style={[styles.profileMediaLabel, { color: textColor }]}>Shared media</AppText>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <AppText style={[styles.profileMediaCount, { color: FG.secondary }]}>
                        {messages.filter(m => m.type === 'image').length} photos
                      </AppText>
                      <AppIcon name="chevron-forward" size={16} color={FG.secondary} />
                    </View>
                  </TouchableOpacity>
                ) : (
                  <View style={[styles.infoMediaBox, bevel]}>
                    <AppIcon name="images-outline" size={28} color={FG.secondary} />
                    <AppText style={[styles.infoMediaEmpty, { color: FG.secondary }]}>No media shared yet</AppText>
                  </View>
                )}
              </View>

              {/* ── Catalog shortcut — cart badge only, full catalog via sheet ── */}
              {!isGroup && sellerCatalog.length > 0 && (
                <View style={{ paddingHorizontal: 16, marginBottom: 4 }}>
                  <TouchableOpacity
                    style={[profileHeroStyles.catalogEntryRow, bevel]}
                    activeOpacity={0.8}
                    onPress={openCatalogSheet}
                  >
                    <View style={profileHeroStyles.catalogEntryLeft}>
                      <LinearGradient colors={GRADIENTS.primary} style={profileHeroStyles.catalogEntryIcon}>
                        <AppIcon name="storefront-outline" size={18} color="#fff" fixedColor />
                      </LinearGradient>
                      <View>
                        <AppText style={[profileHeroStyles.catalogEntryTitle, { color: textColor }]}>Catalog</AppText>
                        <AppText style={[profileHeroStyles.catalogEntrySub, { color: FG.secondary }]}>
                          {sellerCatalog.length} item{sellerCatalog.length !== 1 ? 's' : ''}
                          {sellerCollections.length > 0 ? `  ·  ${sellerCollections.length} collection${sellerCollections.length !== 1 ? 's' : ''}` : ''}
                        </AppText>
                      </View>
                    </View>
                    <AppIcon name="chevron-forward" size={18} color={FG.secondary} />
                  </TouchableOpacity>
                  <CartBadgeRow onViewCart={() => { setProfileModalOpen(false); setCartSheetVisible(true); }} />
                </View>
              )}

              {/* ── Privacy / Block / Leave ── */}
              <View style={{ paddingHorizontal: 16 }}>
                <AppText style={[styles.profileSectionLabel, { color: FG.secondary }]}>PRIVACY</AppText>

                {isGroup ? (
                  !showLeaveGroupConfirmation ? (
                    <TouchableOpacity style={[styles.profileBlockBtn, bevel]} onPress={() => setShowLeaveGroupConfirmation(true)} activeOpacity={0.8} disabled={leavingGroup}>
                      <AppIcon name="exit-outline" size={20} color={COLORS.missed} fixedColor />
                      <AppText style={[styles.profileBlockText, { color: COLORS.missed }]}>Leave Group</AppText>
                    </TouchableOpacity>
                  ) : (
                    <View style={[styles.confirmationCard, bevel]}>
                      <LinearGradient colors={['rgba(255,59,48,0.20)', 'rgba(255,149,0,0.20)']} style={styles.confirmationIconWrap}>
                        <AppIcon name="exit-outline" size={28} color={COLORS.missed} fixedColor />
                      </LinearGradient>
                      <AppText style={[styles.confirmationTitle, { color: textColor, fontFamily }]}>Leave Group?</AppText>
                      <AppText style={[styles.confirmationBody, { color: FG.secondary }]}>You will no longer receive messages from this group.</AppText>
                      <View style={styles.confirmationButtons}>
                        <TouchableOpacity style={[styles.confirmationCancelBtn, { borderColor: FG.glassBorder }]} onPress={() => setShowLeaveGroupConfirmation(false)} disabled={leavingGroup}>
                          <AppText style={[styles.confirmationCancelText, { color: textColor }]}>Cancel</AppText>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.confirmationBlockBtn, { backgroundColor: COLORS.missed }]} onPress={handleLeaveGroup} disabled={leavingGroup}>
                          {leavingGroup ? <ActivityIndicator size="small" color="#fff" /> : <AppText style={[styles.confirmationBlockText, { color: '#fff' }]}>Leave Group</AppText>}
                        </TouchableOpacity>
                      </View>
                    </View>
                  )
                ) : isBlocked && blockedByMe ? (
                  <TouchableOpacity style={[styles.profileBlockBtn, bevel]} onPress={handleUnblockContact} activeOpacity={0.8}>
                    <AppIcon name="checkmark-circle-outline" size={20} color={COLORS.blue} fixedColor />
                    <AppText style={[styles.profileBlockText, { color: COLORS.blue }]}>Unblock User</AppText>
                  </TouchableOpacity>
                ) : !showBlockConfirmation ? (
                  <TouchableOpacity style={[styles.profileBlockBtn, bevel]} onPress={() => setShowBlockConfirmation(true)} activeOpacity={0.8}>
                    <AppIcon name="ban-outline" size={20} color={COLORS.missed} fixedColor />
                    <AppText style={[styles.profileBlockText, { color: COLORS.missed }]}>Block {displayName}</AppText>
                  </TouchableOpacity>
                ) : (
                  <View style={[styles.confirmationCard, bevel]}>
                    <LinearGradient colors={['rgba(255,59,48,0.20)', 'rgba(255,149,0,0.20)']} style={styles.confirmationIconWrap}>
                      <AppIcon name="ban-outline" size={28} color={COLORS.missed} fixedColor />
                    </LinearGradient>
                    <AppText style={[styles.confirmationTitle, { color: textColor, fontFamily }]}>Block {displayName}?</AppText>
                    <AppText style={[styles.confirmationBody, { color: FG.secondary }]}>Blocked contacts cannot call you or send you messages.</AppText>
                    <View style={styles.confirmationButtons}>
                      <TouchableOpacity style={[styles.confirmationCancelBtn, { borderColor: FG.glassBorder }]} onPress={() => setShowBlockConfirmation(false)}>
                        <AppText style={[styles.confirmationCancelText, { color: textColor }]}>Cancel</AppText>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.confirmationBlockBtn, { backgroundColor: COLORS.missed }]} onPress={handleBlockContact}>
                        <AppText style={[styles.confirmationBlockText, { color: '#fff' }]}>Block</AppText>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}

                {/* Delete contact — removes the saved name only; chat stays */}
                {!isGroup && !!savedContactName && (
                  <TouchableOpacity
                    style={[styles.profileBlockBtn, bevel, { marginTop: 10 }]}
                    onPress={handleDeleteContact}
                    activeOpacity={0.8}
                  >
                    <AppIcon name="person-remove-outline" size={20} color={COLORS.missed} fixedColor />
                    <AppText style={[styles.profileBlockText, { color: COLORS.missed }]}>Delete Contact</AppText>
                  </TouchableOpacity>
                )}

                {/* Delete chats — clears the conversation; contact stays */}
                {!isGroup && (
                  <TouchableOpacity
                    style={[styles.profileBlockBtn, bevel, { marginTop: 10 }]}
                    onPress={() => {
                      setProfileModalOpen(false);
                      Alert.alert(
                        'Delete Chats',
                        'Clear all messages in this conversation? This cannot be undone.',
                        [
                          { text: 'Cancel', style: 'cancel' },
                          { text: 'Delete', style: 'destructive', onPress: handleClearChat },
                        ],
                      );
                    }}
                    activeOpacity={0.8}
                  >
                    <AppIcon name="trash-outline" size={20} color={COLORS.missed} fixedColor />
                    <AppText style={[styles.profileBlockText, { color: COLORS.missed }]}>Delete Chats</AppText>
                  </TouchableOpacity>
                )}
              </View>

            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Add / Edit contact sheet ── */}
      <AddContactSheet
        visible={addContactOpen}
        onClose={() => { setAddContactOpen(false); setPendingSaveContact(null); }}
        phone={pendingSaveContact ? pendingSaveContact.phone : otherUserPhone}
        suggestedName={pendingSaveContact ? pendingSaveContact.name : displayName}
        existingName={pendingSaveContact ? null : savedContactName}
        onSaved={() => { setAddContactOpen(false); setPendingSaveContact(null); reloadPhoneBook(); }}
      />

      {/* ── Forward Modal ── */}
      {userId && (
        <ForwardModal
          visible={forwardModalVisible}
          onClose={() => {
            setForwardModalVisible(false);
            setMessagesToForward([]);
          }}
          onForward={handleForwardToChats}
          currentUserId={userId}
        />
      )}

      {/* ── Message Info Modal ── */}
      {userId && messageForInfo && (
        <MessageInfoModal
          visible={messageInfoVisible}
          onClose={() => {
            setMessageInfoVisible(false);
            setMessageForInfo(null);
          }}
          messageTimestamp={messageForInfo.timestamp}
          readBy={messageForInfo.readBy}
          currentUserId={userId}
          isGroup={isGroup}
        />
      )}
    </>
  );
}


// ─── BusinessQrShareSheet ─────────────────────────────────────────────────────
// Presents a scannable QR code for the business profile, with the business
// card (avatar, name, verified badge, contact info, work hours) displayed
// alongside it. The QR encodes:
//   https://www.chitchatbusiness.com/{businessUid}
// The ChitChat logo is embedded at the centre of the QR with ECC level H
// so the code still decodes reliably even with the logo overlay.
// ─────────────────────────────────────────────────────────────────────────────

const QR_SHARE_SIZE = Math.min(Dimensions.get('window').width - 120, 220);
const QR_SHARE_LOGO_SIZE = Math.round(QR_SHARE_SIZE * 0.20);

function BusinessQrShareSheet({
  visible,
  onClose,
  businessUid,
  displayName,
  photoURL,
  initials,
  profile,
}: {
  visible: boolean;
  onClose: () => void;
  businessUid: string;
  displayName: string;
  photoURL: string | null;
  initials: string;
  profile: BusinessProfileData | null;
}) {
  const { textColor } = useTypography();
  const { FG } = useForeground();
  const { bevel } = useGlass();
  const insets = useSafeAreaInsets();

  const qrValue = `${BUSINESS_LINK_BASE}/${businessUid}`;

  const openNow = isCurrentlyOpen(profile?.workSchedule);
  const todayLabel = getTodayHoursLabel(profile?.workSchedule);
  const hoursRows = getWorkHoursSummary(profile?.workSchedule);

  const handleShare = async () => {
    try {
      await Share.share({
        title: displayName,
        message:
          `Chat with ${displayName} on ChitChat Business\n\n` +
          `${qrValue}\n\n` +
          (profile?.phone ? `☎ ${profile.phone}\n` : '') +
          (profile?.email ? `✉ ${profile.email}\n` : '') +
          (profile?.website ? `🌐 ${profile.website}\n` : ''),
        url: qrValue,
      });
    } catch (err) {
      console.warn('[BusinessQrShareSheet] Share failed:', err);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={qrStyles.overlay}>
        <TouchableOpacity style={qrStyles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={[qrStyles.sheet, { backgroundColor: FG.glassBg }]}>
          <AppBg />

          <View style={qrStyles.handle} />

          {/* Header */}
          <View style={qrStyles.header}>
            <AppText style={[qrStyles.headerTitle, { color: textColor }]}>
              Share Business
            </AppText>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <AppIcon name="close" size={22} color={COLORS.sub} />
            </TouchableOpacity>
          </View>

          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[
              qrStyles.scroll,
              { paddingBottom: (Platform.OS === 'ios' ? 40 : 24) + insets.bottom },
            ]}
          >
            {/* Business card */}
            <View style={[qrStyles.bizCard, bevel]}>
              <Avatar
                initials={initials}
                color={COLORS.blue}
                size={64}
                imageUrl={photoURL}
              />
              <View style={{ flex: 1, marginLeft: 14 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <AppText style={[qrStyles.bizName, { color: textColor }]} numberOfLines={1}>
                    {displayName}
                  </AppText>
                  <LinearGradient colors={GRADIENTS.primary} style={qrStyles.verified}>
                    <AppIcon name="checkmark" size={10} color="#fff" fixedColor />
                  </LinearGradient>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 }}>
                  <View
                    style={[
                      qrStyles.dot,
                      { backgroundColor: openNow ? COLORS.green : COLORS.sub },
                    ]}
                  />
                  <AppText style={{ fontSize: 12, color: openNow ? COLORS.green : FG.secondary, fontWeight: '600' }}>
                    {openNow ? 'Open now' : 'Closed now'}
                  </AppText>
                  <AppText style={{ fontSize: 12, color: FG.secondary }}> · {todayLabel}</AppText>
                </View>
                <AppText style={{ fontSize: 11, color: FG.secondary, marginTop: 4 }}>
                  Business account
                </AppText>
              </View>
            </View>

            {/* QR code with logo overlay */}
            <View style={qrStyles.qrFrame}>
              {businessUid ? (
                <QRCode
                  value={qrValue}
                  size={QR_SHARE_SIZE}
                  ecl="H"
                  color="#000000"
                  backgroundColor="#FFFFFF"
                  quietZone={8}
                  logo={require('../../assets/chitchat-logo.png')}
                  logoSize={QR_SHARE_LOGO_SIZE}
                  logoBackgroundColor="#FFFFFF"
                  logoBorderRadius={12}
                  logoMargin={6}
                />
              ) : (
                <ActivityIndicator size="large" color={COLORS.blue} />
              )}
            </View>

            <AppText style={qrStyles.hint}>
              Scan to open this business in ChitChat
            </AppText>

            <View style={[qrStyles.urlPill, bevel]}>
              <AppIcon name="link-outline" size={14} color={COLORS.blue} fixedColor />
              <AppText style={qrStyles.urlText} numberOfLines={1}>
                {qrValue}
              </AppText>
            </View>

            {/* Contact details */}
            {(profile?.phone || profile?.email || profile?.website) && (
              <View style={[qrStyles.infoBlock, bevel]}>
                <AppText style={qrStyles.sectionLabel}>CONTACT</AppText>
                {profile?.phone ? (
                  <View style={qrStyles.infoRow}>
                    <AppIcon name="call-outline" size={16} color={COLORS.blue} fixedColor />
                    <AppText style={[qrStyles.infoText, { color: textColor }]} numberOfLines={1}>
                      {profile.phone}
                    </AppText>
                  </View>
                ) : null}
                {profile?.email ? (
                  <View style={qrStyles.infoRow}>
                    <AppIcon name="mail-outline" size={16} color={COLORS.blue} fixedColor />
                    <AppText style={[qrStyles.infoText, { color: textColor }]} numberOfLines={1}>
                      {profile.email}
                    </AppText>
                  </View>
                ) : null}
                {profile?.website ? (
                  <View style={qrStyles.infoRow}>
                    <AppIcon name="globe-outline" size={16} color={COLORS.blue} fixedColor />
                    <AppText style={[qrStyles.infoText, { color: textColor }]} numberOfLines={1}>
                      {profile.website}
                    </AppText>
                  </View>
                ) : null}
              </View>
            )}

            {/* Work hours */}
            {hoursRows.some((r) => !r.isClosed) && (
              <View style={[qrStyles.infoBlock, bevel]}>
                <AppText style={qrStyles.sectionLabel}>WORKING HOURS</AppText>
                {hoursRows.map((row) => (
                  <View key={row.day} style={qrStyles.hoursRow}>
                    <AppText style={[qrStyles.hoursDay, { color: textColor }]}>
                      {row.day}
                    </AppText>
                    <AppText
                      style={[
                        qrStyles.hoursValue,
                        { color: row.isClosed ? FG.secondary : textColor },
                      ]}
                    >
                      {row.text}
                    </AppText>
                  </View>
                ))}
              </View>
            )}

            {/* Share button */}
            <TouchableOpacity
              onPress={handleShare}
              activeOpacity={0.85}
              style={{ marginTop: 20, width: '100%' }}
            >
              <LinearGradient colors={GRADIENTS.primary} style={qrStyles.shareBtn}>
                <AppIcon name="share-social-outline" size={18} color="#fff" fixedColor style={{ marginRight: 8 }} />
                <AppText fixedColor style={qrStyles.shareBtnText}>
                  Share Business
                </AppText>
              </LinearGradient>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const qrStyles = StyleSheet.create({
  overlay:  { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
    maxHeight: '92%',
    overflow: 'hidden',
  },
  handle: {
    alignSelf: 'center',
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(30,156,240,0.30)',
    marginTop: 10, marginBottom: 4,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
  },
  headerTitle: { fontSize: 17, fontWeight: '800' },
  scroll: {
    paddingHorizontal: 20,
    alignItems: 'center',
    paddingBottom: 40,
  },

  // Business card
  bizCard: {
    flexDirection: 'row', alignItems: 'center',
    width: '100%',
    borderRadius: RADIUS.xl,
    padding: 14,
    marginBottom: 22,
  },
  bizName: { fontSize: 16, fontWeight: '800' },
  verified: {
    width: 16, height: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },

  // QR frame
  qrFrame: {
    padding: 16,
    borderRadius: 24,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.card,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 4,
  },
  hint: {
    marginTop: 14,
    fontSize: 13,
    fontWeight: '600',
    color: COLORS.sub,
    textAlign: 'center',
  },

  // URL pill
  urlPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 14,
    paddingHorizontal: 14, paddingVertical: 10,
    borderRadius: RADIUS.full,
    maxWidth: '100%',
  },
  urlText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.blue,
    maxWidth: 240,
  },

  // Info blocks
  infoBlock: {
    width: '100%',
    marginTop: 18,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 14,
    gap: 10,
  },
  sectionLabel: {
    fontSize: 11, fontWeight: '800',
    letterSpacing: 0.8,
    color: COLORS.sub,
    marginBottom: 2,
  },
  infoRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  infoText: { fontSize: 14, fontWeight: '600', flex: 1 },

  hoursRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  hoursDay:   { fontSize: 13, fontWeight: '600' },
  hoursValue: { fontSize: 13, fontWeight: '500' },

  // Share button
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 15,
    borderRadius: RADIUS.lg,
    ...SHADOW.button,
  },
  shareBtnText: { color: '#fff', fontSize: 15, fontWeight: '800' },
});


// ─── ProfileCatalogCard ───────────────────────────────────────────────────────
// Premium product card for the profile bottom sheet.
// Full image on top, name + price + description below, Add/stepper at the bottom.
// Two cards sit side-by-side in a 2-column grid.
function ProfileCatalogCard({
  item, sellerUid, textColor, fgSecondary,
}: {
  item: import('../types').CatalogItem;
  sellerUid: string;
  textColor: string;
  fgSecondary: string;
}) {
  const { addItem, removeItem, getQuantity, sellerUid: cartSeller } = useCart();
  const qty = getQuantity(item.id);

  const handleAdd = () => {
    if (cartSeller && cartSeller !== sellerUid && qty === 0) {
      Alert.alert(
        'Start new cart?',
        'Your cart has items from another business. Adding this item will clear your current cart.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Clear & Add', style: 'destructive', onPress: () => addItem(item, sellerUid) },
        ],
      );
      return;
    }
    addItem(item, sellerUid);
  };

  return (
    <View style={pcStyles.card}>
      {/* Product image — fills top of card */}
      {item.imageUri ? (
        <Image source={{ uri: item.imageUri }} style={pcStyles.img} resizeMode="cover" />
      ) : (
        <View style={pcStyles.imgPlaceholder}>
          <AppIcon name="cube-outline" size={28} color={COLORS.blue} fixedColor />
        </View>
      )}

      {/* Info block */}
      <View style={pcStyles.info}>
        <AppText style={[pcStyles.name, { color: textColor }]} numberOfLines={2}>
          {item.name}
        </AppText>
        {!!item.price && (
          <AppText style={pcStyles.price}>{item.price}</AppText>
        )}
        {!!item.description && (
          <AppText style={[pcStyles.desc, { color: fgSecondary }]} numberOfLines={2}>
            {item.description}
          </AppText>
        )}
      </View>

      {/* Cart control */}
      <View style={pcStyles.footer}>
        {qty === 0 ? (
          <TouchableOpacity onPress={handleAdd} activeOpacity={0.85} style={pcStyles.addBtn}>
            <LinearGradient colors={GRADIENTS.primary} style={pcStyles.addBtnGrad}>
              <AppIcon name="add" size={15} color="#fff" fixedColor />
              <AppText fixedColor style={pcStyles.addBtnText}>Add</AppText>
            </LinearGradient>
          </TouchableOpacity>
        ) : (
          <View style={pcStyles.stepper}>
            <TouchableOpacity
              onPress={() => removeItem(item.id)}
              style={pcStyles.stepBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <AppIcon name="remove" size={14} color={COLORS.blue} fixedColor />
            </TouchableOpacity>
            <AppText style={pcStyles.stepQty}>{qty}</AppText>
            <TouchableOpacity
              onPress={handleAdd}
              style={pcStyles.stepBtn}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <AppIcon name="add" size={14} color={COLORS.blue} fixedColor />
            </TouchableOpacity>
          </View>
        )}
      </View>
    </View>
  );
}

// ─── CartBadgeRow ─────────────────────────────────────────────────────────────
// Shows a "View Cart (n items)" row at the bottom of the catalog list only when
// the cart is non-empty. Tapping it navigates the user to the CartSheet.
function CartBadgeRow({ onViewCart }: { onViewCart: () => void }) {
  const { totalItems } = useCart();
  if (totalItems === 0) return null;
  return (
    <TouchableOpacity onPress={onViewCart} activeOpacity={0.85} style={profileCatalogStyles.cartRow}>
      <LinearGradient colors={GRADIENTS.primary} style={profileCatalogStyles.cartRowGrad}>
        <AppIcon name="cart" size={18} color="#fff" fixedColor />
        <AppText fixedColor style={profileCatalogStyles.cartRowText}>
          View Cart · {totalItems} {totalItems === 1 ? 'item' : 'items'}
        </AppText>
        <AppIcon name="chevron-forward" size={16} color="#fff" fixedColor />
      </LinearGradient>
    </TouchableOpacity>
  );
}

// ─── CatalogBrowseSheet ───────────────────────────────────────────────────────
// Full-screen-ish modal sheet matching the reference image:
//   - Header: business name + close
//   - Collection chips row (horizontal scroll): All · Shoes · Clothing · …
//   - If a collection is selected: banner image (first item image) + product grid
//   - Uncategorised products listed below with horizontal scroll rows
// ─────────────────────────────────────────────────────────────────────────────
function CatalogBrowseSheet({
  collections, catalog, sellerUid, loading, activeColId,
  onSelectCol, textColor, fgSecondary, onClose, onViewCart,
}: {
  collections:  import('../types').CatalogCollection[];
  catalog:      import('../types').CatalogItem[];
  sellerUid:    string;
  loading:      boolean;
  activeColId:  string | null;
  onSelectCol:  (id: string | null) => void;
  textColor:    string;
  fgSecondary:  string;
  onClose:      () => void;
  onViewCart:   () => void;
}) {
  const { totalItems } = useCart();

  // Items to display in the main grid — depends on active chip
  const displayItems = activeColId
    ? catalog.filter(i => i.collectionId === activeColId)
    : catalog;

  // Banner image: first item with an image in the active collection (or first overall)
  const bannerImg = displayItems.find(i => i.imageUri)?.imageUri ?? null;

  // Uncategorised items (shown when All tab active)
  const uncategorised = catalog.filter(i => !i.collectionId);

  return (
    <View style={csStyles.overlay}>
      <TouchableOpacity style={csStyles.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={csStyles.sheet}>

        {/* ── Header ── */}
        <View style={csStyles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <AppIcon name="chevron-back" size={22} color={COLORS.blue} fixedColor />
          </TouchableOpacity>
          <AppText style={[csStyles.headerTitle, { color: textColor }]}>Catalog</AppText>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <AppIcon name="close" size={20} color={COLORS.sub} />
          </TouchableOpacity>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} stickyHeaderIndices={[0]}>

          {/* ── Collection chips (sticky) ── */}
          <View style={csStyles.chipBarWrap}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={csStyles.chipBar}>
              {/* "All" chip */}
              <TouchableOpacity
                style={[csStyles.chip, activeColId === null && csStyles.chipActive]}
                onPress={() => onSelectCol(null)}
                activeOpacity={0.8}
              >
                {activeColId === null ? (
                  <LinearGradient colors={GRADIENTS.primary} style={csStyles.chipGrad}>
                    <AppText fixedColor style={csStyles.chipActiveText}>All</AppText>
                  </LinearGradient>
                ) : (
                  <AppText style={[csStyles.chipText, { color: fgSecondary }]}>All</AppText>
                )}
              </TouchableOpacity>

              {/* Collection chips */}
              {collections.map(col => {
                const active = activeColId === col.id;
                return (
                  <TouchableOpacity
                    key={col.id}
                    style={[csStyles.chip, active && csStyles.chipActive]}
                    onPress={() => onSelectCol(col.id)}
                    activeOpacity={0.8}
                  >
                    {active ? (
                      <LinearGradient colors={GRADIENTS.primary} style={csStyles.chipGrad}>
                        <AppText fixedColor style={csStyles.chipActiveText}>
                          {col.emoji ? `${col.emoji} ` : ''}{col.name}
                        </AppText>
                      </LinearGradient>
                    ) : (
                      <AppText style={[csStyles.chipText, { color: fgSecondary }]}>
                        {col.emoji ? `${col.emoji} ` : ''}{col.name}
                      </AppText>
                    )}
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </View>

          {loading ? (
            <View style={csStyles.centerState}>
              <ActivityIndicator size="large" color={COLORS.blue} />
              <AppText style={{ color: fgSecondary, marginTop: 10 }}>Loading…</AppText>
            </View>
          ) : catalog.length === 0 ? (
            <View style={csStyles.centerState}>
              <AppIcon name="storefront-outline" size={48} color={COLORS.sub} />
              <AppText style={{ color: fgSecondary, marginTop: 10 }}>No products yet</AppText>
            </View>
          ) : (
            <>
              {/* ── Collection banner ── */}
              {activeColId && bannerImg && (
                <View style={csStyles.bannerWrap}>
                  <Image source={{ uri: bannerImg }} style={csStyles.bannerImage} resizeMode="cover" />
                  <LinearGradient
                    colors={['transparent', 'rgba(0,0,0,0.55)']}
                    style={csStyles.bannerOverlay}
                  >
                    <AppText style={csStyles.bannerTitle}>
                      {collections.find(c => c.id === activeColId)?.name ?? ''}
                    </AppText>
                    <AppText style={csStyles.bannerSub}>
                      {displayItems.length} item{displayItems.length !== 1 ? 's' : ''}
                    </AppText>
                  </LinearGradient>
                </View>
              )}

              {/* ── Active collection or all-items grid ── */}
              {(activeColId || !collections.length) && (
                <View style={csStyles.grid}>
                  {displayItems.map(item => (
                    <ProfileCatalogCard
                      key={item.id}
                      item={item}
                      sellerUid={sellerUid}
                      textColor={textColor}
                      fgSecondary={fgSecondary}
                    />
                  ))}
                </View>
              )}

              {/* ── When "All" is active and there are collections: show each as a horizontal row ── */}
              {!activeColId && collections.length > 0 && (
                <>
                  {collections.map(col => {
                    const colItems = catalog.filter(i => i.collectionId === col.id);
                    if (colItems.length === 0) return null;
                    return (
                      <View key={col.id} style={{ marginBottom: 20 }}>
                        {/* Collection row header */}
                        <View style={csStyles.sectionHeader}>
                          <View style={{ flex: 1 }}>
                            <AppText style={[csStyles.sectionTitle, { color: textColor }]}>
                              {col.emoji ? `${col.emoji}  ` : ''}{col.name}
                            </AppText>
                            <AppText style={[csStyles.sectionSub, { color: fgSecondary }]}>
                              {colItems.length} item{colItems.length !== 1 ? 's' : ''}
                            </AppText>
                          </View>
                          <TouchableOpacity onPress={() => onSelectCol(col.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                            <AppText style={csStyles.viewAll}>View all {'>'}</AppText>
                          </TouchableOpacity>
                        </View>

                        {/* Horizontal product scroll */}
                        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={csStyles.hScroll}>
                          {colItems.map(item => (
                            <View key={item.id} style={csStyles.hCard}>
                              {item.imageUri ? (
                                <Image source={{ uri: item.imageUri }} style={csStyles.hCardImg} resizeMode="cover" />
                              ) : (
                                <View style={csStyles.hCardImgPlaceholder}>
                                  <AppIcon name="cube-outline" size={24} color={COLORS.blue} fixedColor />
                                </View>
                              )}
                              <View style={csStyles.hCardInfo}>
                                <AppText style={[csStyles.hCardName, { color: textColor }]} numberOfLines={2}>{item.name}</AppText>
                                {!!item.price && <AppText style={csStyles.hCardPrice}>{item.price}</AppText>}
                              </View>
                              <HorizontalCartControl item={item} sellerUid={sellerUid} />
                            </View>
                          ))}
                        </ScrollView>
                      </View>
                    );
                  })}

                  {/* Uncategorised products */}
                  {uncategorised.length > 0 && (
                    <View style={{ marginBottom: 20 }}>
                      <View style={csStyles.sectionHeader}>
                        <AppText style={[csStyles.sectionTitle, { color: textColor }]}>More products</AppText>
                      </View>
                      <View style={csStyles.grid}>
                        {uncategorised.map(item => (
                          <ProfileCatalogCard key={item.id} item={item} sellerUid={sellerUid} textColor={textColor} fgSecondary={fgSecondary} />
                        ))}
                      </View>
                    </View>
                  )}
                </>
              )}
            </>
          )}
        </ScrollView>

        {/* ── Cart badge bar ── */}
        {totalItems > 0 && (
          <TouchableOpacity onPress={onViewCart} activeOpacity={0.85} style={csStyles.cartBar}>
            <LinearGradient colors={GRADIENTS.primary} style={csStyles.cartBarGrad}>
              <AppIcon name="cart" size={18} color="#fff" fixedColor />
              <AppText fixedColor style={csStyles.cartBarText}>View Cart · {totalItems} item{totalItems !== 1 ? 's' : ''}</AppText>
              <AppIcon name="chevron-forward" size={16} color="#fff" fixedColor />
            </LinearGradient>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ── Tiny cart control for horizontal cards ────────────────────────────────────
function HorizontalCartControl({ item, sellerUid }: { item: import('../types').CatalogItem; sellerUid: string }) {
  const { addItem, removeItem, getQuantity, sellerUid: cartSeller } = useCart();
  const qty = getQuantity(item.id);
  const handleAdd = () => {
    if (cartSeller && cartSeller !== sellerUid && qty === 0) {
      Alert.alert('Start new cart?', 'Your cart has items from another business.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear & Add', style: 'destructive', onPress: () => addItem(item, sellerUid) },
      ]);
      return;
    }
    addItem(item, sellerUid);
  };
  return qty === 0 ? (
    <TouchableOpacity onPress={handleAdd} activeOpacity={0.85} style={csStyles.hCardAddBtn}>
      <LinearGradient colors={GRADIENTS.primary} style={csStyles.hCardAddBtnGrad}>
        <AppIcon name="add" size={15} color="#fff" fixedColor />
        <AppText fixedColor style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>Add</AppText>
      </LinearGradient>
    </TouchableOpacity>
  ) : (
    <View style={csStyles.hCardStepper}>
      <TouchableOpacity onPress={() => removeItem(item.id)} style={csStyles.hCardStepBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <AppIcon name="remove" size={13} color={COLORS.blue} fixedColor />
      </TouchableOpacity>
      <AppText style={csStyles.hCardStepQty}>{qty}</AppText>
      <TouchableOpacity onPress={handleAdd} style={csStyles.hCardStepBtn} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
        <AppIcon name="add" size={13} color={COLORS.blue} fixedColor />
      </TouchableOpacity>
    </View>
  );
}

const { width: SW } = Dimensions.get('window');
const H_CARD_W = 148;

const csStyles = StyleSheet.create({
  overlay:  { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '92%',
    overflow: 'hidden',
  },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 18, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },

  // Collection chip bar
  chipBarWrap: { backgroundColor: '#fff', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)' },
  chipBar: { paddingHorizontal: 14, gap: 8, flexDirection: 'row' },
  chip: {
    borderRadius: RADIUS.full,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.20)',
  },
  chipActive: { borderColor: 'transparent' },
  chipGrad: { paddingHorizontal: 16, paddingVertical: 7, borderRadius: RADIUS.full },
  chipActiveText: { fontSize: 13, fontWeight: '700', color: '#fff' },
  chipText: { fontSize: 13, fontWeight: '600', paddingHorizontal: 14, paddingVertical: 7 },

  centerState: { alignItems: 'center', justifyContent: 'center', padding: 48 },

  // Banner
  bannerWrap: { position: 'relative', height: 160, marginBottom: 4 },
  bannerImage: { width: '100%', height: 160 },
  bannerOverlay: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingHorizontal: 16, paddingVertical: 12,
  },
  bannerTitle: { color: '#fff', fontSize: 20, fontWeight: '800' },
  bannerSub:   { color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 2 },

  // 2-col grid (for selected collection / uncategorised)
  grid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10,
    paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4,
  },

  // Section rows (All tab)
  sectionHeader: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 8,
  },
  sectionTitle: { fontSize: 16, fontWeight: '800' },
  sectionSub:   { fontSize: 12, marginTop: 1 },
  viewAll: { fontSize: 12, fontWeight: '700', color: COLORS.blue },

  // Horizontal card scroll
  hScroll: { paddingHorizontal: 14, gap: 10 },
  hCard: {
    width: H_CARD_W,
    borderRadius: RADIUS.md,
    backgroundColor: '#fff',
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.10)',
    ...SHADOW.card,
  },
  hCardImg:            { width: H_CARD_W, height: 110 },
  hCardImgPlaceholder: { width: H_CARD_W, height: 100, backgroundColor: 'rgba(30,156,240,0.06)', alignItems: 'center', justifyContent: 'center' },
  hCardInfo: { paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4, gap: 2 },
  hCardName:  { fontSize: 12, fontWeight: '700', lineHeight: 16 },
  hCardPrice: { fontSize: 13, fontWeight: '800', color: COLORS.blue },
  hCardAddBtn: { marginHorizontal: 8, marginBottom: 8, borderRadius: RADIUS.full, overflow: 'hidden' },
  hCardAddBtnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 7, borderRadius: RADIUS.full },
  hCardStepper: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginHorizontal: 8, marginBottom: 8,
    backgroundColor: 'rgba(30,156,240,0.08)', borderRadius: RADIUS.full, paddingVertical: 6,
  },
  hCardStepBtn: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(30,156,240,0.15)', alignItems: 'center', justifyContent: 'center' },
  hCardStepQty: { fontSize: 13, fontWeight: '800', color: COLORS.text, minWidth: 16, textAlign: 'center' },

  // Bottom cart bar
  cartBar: { margin: 12, borderRadius: RADIUS.md, overflow: 'hidden' },
  cartBarGrad: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 14 },
  cartBarText: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '700' },
});

// ─── Profile hero styles ──────────────────────────────────────────────────────
const profileHeroStyles = StyleSheet.create({
  // Banner + avatar overlap
  hero: { position: 'relative', marginBottom: 52 },
  heroBanner: {
    height: 110,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
  },
  closeBtn: {
    position: 'absolute', top: 12, right: 12,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  editBtn: {
    position: 'absolute', top: 12, right: 50,
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.28)',
    alignItems: 'center', justifyContent: 'center',
    zIndex: 2,
  },
  avatarRing: {
    position: 'absolute',
    bottom: -44,
    alignSelf: 'center',
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: '#fff',
    ...SHADOW.card,
  },

  // Name block
  nameBlock: {
    alignItems: 'center',
    paddingHorizontal: 24,
    paddingBottom: 16,
    gap: 2,
  },
  name: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  verifiedBadge: {
    width: 18, height: 18, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  accountType: { fontSize: 12, fontWeight: '500' },
  presence:    { fontSize: 12 },

  // Three action buttons
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  actionBtn: { alignItems: 'center', gap: 6 },
  actionIconWrap: {
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: 'rgba(30,156,240,0.10)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(30,156,240,0.18)',
  },
  actionLabel: { fontSize: 12, fontWeight: '600' },

  addContactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.22)',
  },
  addContactText: { fontSize: 15, fontWeight: '700' },

  // Info rows (hours, website, location)
  infoSection: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    gap: 10,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  infoText: { fontSize: 14, fontWeight: '500', flex: 1 },

  // Work-hours card
  hoursCard: {
    marginTop: 4,
    padding: 14,
    borderRadius: RADIUS.lg,
    backgroundColor: 'rgba(30,156,240,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.15)',
    gap: 6,
  },
  hoursCardLabel: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: COLORS.sub,
    marginBottom: 4,
  },
  hoursRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  hoursDay:   { fontSize: 13, fontWeight: '600' },
  hoursValue: { fontSize: 13, fontWeight: '500' },

  // Divider
  divider: {
    height: 1,
    backgroundColor: 'rgba(0,0,0,0.07)',
    marginHorizontal: 16,
    marginBottom: 16,
    marginTop: 4,
  },

  // Catalog entry row (replaces inline catalog in profile sheet)
  catalogEntryRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: RADIUS.md,
    marginBottom: 8,
    gap: 12,
  },
  catalogEntryLeft: {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
  },
  catalogEntryIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center' as const, justifyContent: 'center' as const,
  },
  catalogEntryTitle: { fontSize: 15, fontWeight: '700' as const },
  catalogEntrySub:   { fontSize: 12, marginTop: 1 },

  // Industry badge
  industryBadge: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.15)',
  },
  industryEmoji: { fontSize: 14 },
  industryLabel: { fontSize: 13, fontWeight: '600' as const },

  // About / description card
  aboutCard: {
    padding: 14,
    borderRadius: RADIUS.lg,
    backgroundColor: 'rgba(30,156,240,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.12)',
    gap: 6,
  },
  aboutLabel: {
    fontSize: 10,
    fontWeight: '800' as const,
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  aboutText: { fontSize: 14, lineHeight: 20 },
});

// ─── Add Contact sheet styles ─────────────────────────────────────────────────
const addContactStyles = StyleSheet.create({
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
  title: { fontSize: 17, fontWeight: '700' },
  save: { fontSize: 15, fontWeight: '700', color: COLORS.blue },
  input: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: RADIUS.md, paddingHorizontal: 14, minHeight: 50,
  },
  inputField: { flex: 1, fontSize: 15, padding: 0 },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: RADIUS.md, paddingHorizontal: 14, paddingVertical: 12, marginTop: 4,
  },
  switchLabel: { fontSize: 15, fontWeight: '600' },
  switchSub: { fontSize: 12, marginTop: 2 },
});

const profileCatalogStyles = StyleSheet.create({
  cartRow: { borderRadius: RADIUS.md, overflow: 'hidden', marginTop: 4, marginBottom: 8 },
  cartRowGrad: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 12, borderRadius: RADIUS.md,
  },
  cartRowText: { flex: 1, color: '#fff', fontSize: 14, fontWeight: '700' },

  // Collection group inside profile sheet
  colGroup: {
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    marginBottom: 8,
    backgroundColor: 'rgba(255,255,255,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
    paddingBottom:10
  },
  colHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  colHeaderLeft: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    flex: 1,
  },
  colEmoji:  { fontSize: 18 },
  colName:   { fontSize: 13, fontWeight: '700' as const },
  colCount:  { fontSize: 11, marginTop: 1 },
});

// ─── Premium product card styles (2-col grid) ─────────────────────────────────
const CARD_W = (Dimensions.get('window').width - 48 - 8) / 2; // 2 cols, 16px side padding, 8px gap

const pcStyles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 10,
  },
  card: {
    width: CARD_W,
    borderRadius: RADIUS.lg,
    backgroundColor: '#fff',
    overflow: 'hidden',
    ...SHADOW.card,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.10)',
  },
  img: { width: CARD_W, height: CARD_W * 0.75, },
  imgPlaceholder: {
    width: CARD_W, height: CARD_W * 0.65,
    backgroundColor: 'rgba(30,156,240,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
  info: {
    paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4, gap: 2,
  },
  name:  { fontSize: 13, fontWeight: '700', lineHeight: 17 },
  price: { fontSize: 14, fontWeight: '800', color: COLORS.blue },
  desc:  { fontSize: 11, color: COLORS.sub, lineHeight: 15, marginTop: 1 },
  footer: {
    paddingHorizontal: 10, paddingBottom: 10, paddingTop: 6,
    borderTopWidth: 1, borderTopColor: 'rgba(30,156,240,0.07)',
  },
  addBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  addBtnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: 8, borderRadius: RADIUS.full,
  },
  addBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  stepper: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, backgroundColor: 'rgba(30,156,240,0.08)',
    borderRadius: RADIUS.full, paddingVertical: 6,
  },
  stepBtn: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(30,156,240,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  stepQty: { fontSize: 13, fontWeight: '800', color: COLORS.text, minWidth: 18, textAlign: 'center' },
});

// ─── CartSheet ────────────────────────────────────────────────────────────────
// Inline component (same file as ChatScreen) so it can access the same
// useCart hook without a separate context consumer setup in a new file.
// Shows all cart items with quantity steppers, total price, and a
// "Send Order" button that writes the formatted summary as a chat message.
function CartSheet({ onClose, onSendOrder }: { onClose: () => void; onSendOrder: () => void }) {
  const { items, totalPrice, totalItems, addItem, removeItem, setQuantity, clearCart } = useCart();

  if (items.length === 0) {
    return (
      <View style={cartStyles.overlay}>
        <View style={cartStyles.sheet}>
          <View style={cartStyles.handle} />
          <View style={cartStyles.header}>
            <AppText style={cartStyles.title}>Your Cart</AppText>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <AppIcon name="close" size={22} color={COLORS.sub} />
            </TouchableOpacity>
          </View>
          <View style={cartStyles.emptyWrap}>
            <AppIcon name="cart-outline" size={48} color={COLORS.sub} />
            <AppText style={cartStyles.emptyText}>Your cart is empty</AppText>
          </View>
        </View>
      </View>
    );
  }

  // Derive currency prefix from first item's price (e.g. "R", "$")
  const currencyPrefix = items[0]?.item.price.match(/^[^0-9]*/)?.[0] ?? '';

  return (
    <View style={cartStyles.overlay}>
      <TouchableOpacity style={cartStyles.backdrop} activeOpacity={1} onPress={onClose} />
      <View style={cartStyles.sheet}>
        <View style={cartStyles.handle} />

        {/* Header */}
        <View style={cartStyles.header}>
          <AppText style={cartStyles.title}>Your Cart ({totalItems})</AppText>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <AppIcon name="close" size={22} color={COLORS.sub} />
          </TouchableOpacity>
        </View>

        {/* Item list */}
        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 320 }}>
          {items.map(cartItem => (
            <View key={cartItem.item.id} style={cartStyles.row}>
              {/* Thumbnail */}
              {cartItem.item.imageUri ? (
                <Image source={{ uri: cartItem.item.imageUri }} style={cartStyles.thumb} />
              ) : (
                <View style={cartStyles.thumbPlaceholder}>
                  <AppIcon name="cube-outline" size={18} color={COLORS.blue} fixedColor />
                </View>
              )}

              {/* Name + price */}
              <View style={cartStyles.rowInfo}>
                <AppText style={cartStyles.rowName} numberOfLines={1}>{cartItem.item.name}</AppText>
                <AppText style={cartStyles.rowPrice}>{cartItem.item.price}</AppText>
              </View>

              {/* Stepper */}
              <View style={cartStyles.stepper}>
                <TouchableOpacity
                  onPress={() => removeItem(cartItem.item.id)}
                  style={cartStyles.stepBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <AppIcon name="remove" size={16} color={COLORS.blue} fixedColor />
                </TouchableOpacity>
                <AppText style={cartStyles.stepQty}>{cartItem.quantity}</AppText>
                <TouchableOpacity
                  onPress={() => addItem(cartItem.item, cartItem.sellerUid)}
                  style={cartStyles.stepBtn}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <AppIcon name="add" size={16} color={COLORS.blue} fixedColor />
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </ScrollView>

        {/* Total */}
        {totalPrice !== null && (
          <View style={cartStyles.totalRow}>
            <AppText style={cartStyles.totalLabel}>Total</AppText>
            <AppText style={cartStyles.totalValue}>{currencyPrefix}{totalPrice.toFixed(2)}</AppText>
          </View>
        )}

        {/* Actions */}
        <View style={cartStyles.actions}>
          <TouchableOpacity onPress={() => { clearCart(); onClose(); }} style={cartStyles.clearBtn}>
            <AppText style={cartStyles.clearBtnText}>Clear</AppText>
          </TouchableOpacity>
          <TouchableOpacity onPress={onSendOrder} activeOpacity={0.85} style={cartStyles.sendBtn}>
            <LinearGradient colors={GRADIENTS.primary} style={cartStyles.sendBtnGrad}>
              <AppIcon name="send" size={16} color="#fff" fixedColor style={{ marginRight: 6 }} />
              <AppText fixedColor style={cartStyles.sendBtnText}>Send Order</AppText>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const cartStyles = StyleSheet.create({
  overlay:  { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingBottom: 34,
  },
  handle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: '#e0e0e0', marginTop: 10, marginBottom: 6,
  },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  title: { fontSize: 17, fontWeight: '700', color: COLORS.text },

  emptyWrap: { alignItems: 'center', paddingVertical: 48, gap: 12 },
  emptyText: { fontSize: 14, color: COLORS.sub },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  thumb: { width: 44, height: 44, borderRadius: 10 },
  thumbPlaceholder: {
    width: 44, height: 44, borderRadius: 10,
    backgroundColor: 'rgba(30,156,240,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  rowInfo:  { flex: 1 },
  rowName:  { fontSize: 13, fontWeight: '600', color: COLORS.text },
  rowPrice: { fontSize: 13, fontWeight: '700', color: COLORS.blue, marginTop: 2 },

  stepper: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderRadius: RADIUS.full, paddingHorizontal: 6, paddingVertical: 4,
  },
  stepBtn: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(30,156,240,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  stepQty: { fontSize: 14, fontWeight: '700', color: COLORS.text, minWidth: 18, textAlign: 'center' },

  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)',
  },
  totalLabel: { fontSize: 14, fontWeight: '600', color: COLORS.sub },
  totalValue: { fontSize: 18, fontWeight: '800', color: COLORS.text },

  actions: {
    flexDirection: 'row', gap: 12,
    paddingHorizontal: 16, paddingTop: 8,
  },
  clearBtn: {
    paddingHorizontal: 20, paddingVertical: 14,
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center', justifyContent: 'center',
  },
  clearBtnText: { fontSize: 14, fontWeight: '700', color: COLORS.sub },
  sendBtn: { flex: 1, borderRadius: RADIUS.md, overflow: 'hidden' },
  sendBtnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 14, borderRadius: RADIUS.md,
  },
  sendBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
});


const styles = StyleSheet.create({
  root: { flex: 1 },

  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 52, paddingBottom: 12, paddingHorizontal: 14,
    gap: 8, ...GLASS.header,
  },
  backBtn: { padding: 2 },
  topBarContact: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 15, fontWeight: '700' },
  onlineText: { fontSize: 12, marginTop: 2 },

  // "Add contact" banner (inbox, unsaved contact)
  addContactBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginHorizontal: 12, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: RADIUS.lg,
    backgroundColor: 'rgba(255,255,255,0.65)',
  },
  addContactBannerIcon: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(30,156,240,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  addContactBannerTitle: { fontSize: 14, fontWeight: '700' },
  addContactBannerSub: { fontSize: 12, marginTop: 1 },
  addContactBannerGhost: { paddingHorizontal: 10, paddingVertical: 8 },
  addContactBannerGhostTxt: { fontSize: 13, fontWeight: '600' },
  addContactBannerAdd: {
    backgroundColor: COLORS.blue, borderRadius: RADIUS.full,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  addContactBannerAddTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },
  iconBtn: { padding: 4 },

  // ── Center states (loading / empty) ───────────────────────────────────────
  centerState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyEmoji: { fontSize: 48, marginBottom: 8 },
  emptyText: { fontSize: 16, color: COLORS.sub, fontWeight: '500' },

  // ── Messages ──────────────────────────────────────────────────────────────
  messageList: { paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8, gap: 8 },
  datePillWrap: { alignItems: 'center', marginBottom: 10 },
  datePill: { ...GLASS.card, borderRadius: RADIUS.full, paddingHorizontal: 16, paddingVertical: 5 },
  datePillText: { fontSize: 11, color: COLORS.sub },

  // ── Unread messages divider ──────────────────────────────────────────────────
  unreadDividerWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
    paddingHorizontal: 14,
    gap: 8,
  },
  unreadDividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(30,156,240,0.35)',
  },
  unreadDividerPill: {
    backgroundColor: 'rgba(30,156,240,0.12)',
    borderRadius: RADIUS.full,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.25)',
  },
  unreadDividerText: {
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.blue,
  },

  msgRow: { flexDirection: 'row', marginBottom: 4 },
  msgRowIn: { justifyContent: 'flex-start' },
  msgRowOut: { justifyContent: 'flex-end' },

  // ── System messages ───────────────────────────────────────────────────────
  systemMessageContainer: {
    alignItems: 'center',
    marginVertical: 8,
    paddingHorizontal: 20,
  },
  systemMessageBubble: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    maxWidth: '80%',
  },
  systemMessageText: {
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: '#6b7280',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  offlineBannerText: {
    fontSize: 12,
    color: '#fff',
    fontWeight: '500',
  },

  bubble: {
    maxWidth: '75%',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    paddingBottom: 6,
    position: 'relative',
  },
  bubbleIn: { borderBottomLeftRadius: 4, ...SHADOW.card },
  bubbleTextIn: {
    fontSize: 14,
    color: '#fff',
    lineHeight: 20,
    paddingRight: 60, // Space for time and tick
    marginBottom: 2,
  },
  timeIn: {
    position: 'absolute',
    bottom: 4,
    right: 10,
    fontSize: 10,
    color: 'rgba(255,255,255,0.75)',
  },
  timeInRow: {
    position: 'absolute',
    bottom: 4,
    right: 10,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 3,
  },
  timeOutRow: {
    position: 'absolute',
    bottom: 4,
    right: 10,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 3,
  },
  editedLabel: {
    fontSize: 9,
    opacity: 0.65,
    fontStyle: 'italic' as const,
  },

  bubbleOut: {
    backgroundColor: 'rgba(180,225,245,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.18)',
    borderBottomRightRadius: 4,
    position: 'relative',
    ...SHADOW.card
  },
  bubbleTextOut: {
    fontSize: 14,
    color: COLORS.text,
    lineHeight: 20,
    paddingRight: 70, // Space for time and double tick
    marginBottom: 2,
  },
  timeOut: { fontSize: 10, color: COLORS.sub },

  // Voice / image
  imagePlaceholder: {
    width: 160, height: 100, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center', marginBottom: 4,
  },
  imageBubble: {
    padding: 4,
    paddingBottom: 4,
  },
  messageImage: {
    width: 200,
    height: 200,
    borderRadius: 12,
  },
  // Fixed final media footprint: optimistic and completed bubbles occupy the
  // same 200×200 area, so upload progress never causes layout jumps.
  mediaFrame: {
    width: 200,
    height: 200,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  mediaFill: {
    ...StyleSheet.absoluteFill,
  },
  imageTimeOverlay: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
  },

  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 8, paddingVertical: 8,
    paddingBottom: Platform.OS === 'ios' ? 28 : 10,
    gap: 4, ...GLASS.header,
  },
  inputSideBtn: { width: 38, height: 42, alignItems: 'center', justifyContent: 'center' },
  inputFieldWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30,156,240,0.06)',
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.18)',
    paddingHorizontal: 14,
    minHeight: 42,
    paddingVertical: Platform.OS === 'ios' ? 10 : 0,
  },
  inputField: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: COLORS.text,
    paddingTop: 0,
    paddingBottom: 0,
    margin: 0,
    maxHeight: 100,
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  emojiBtn: { paddingLeft: 8, alignSelf: 'center' },
  sendBtn: { width: 42, height: 42, borderRadius: 21, ...SHADOW.button },
  sendBtnInner: { flex: 1, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },

  // Emoji panel
  emojiPanel: {
    maxHeight: 160,
    borderTopWidth: 1,
    paddingVertical: 8,
    backgroundColor: 'rgba(180,225,245,0.18)',
    borderTopColor: 'rgba(30,156,240,0.18)',
  },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, gap: 2 },
  emojiItem: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  emojiChar: { fontSize: 26 },

  // Attachment sheet
  attachOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.30)' },
  attachSheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 50 : 40,
    paddingHorizontal: 20, paddingTop: 12,
    ...SHADOW.glow,
  },
  attachHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(30,156,240,0.40)', alignSelf: 'center', marginBottom: 14 },
  attachTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text, marginBottom: 16 },
  attachGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  attachItem: {
    width: 90, paddingVertical: 14, alignItems: 'center', gap: 8,
    borderRadius: RADIUS.lg,
  },
  attachIconWrap: { width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(30,156,240,0.10)', alignItems: 'center', justifyContent: 'center' },
  attachLabel: { fontSize: 11, fontWeight: '600', color: COLORS.sub, textAlign: 'center' },

  // Camera UI
  cameraControls: {
    position: 'absolute', bottom: 40, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center',
  },
  cameraCloseBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  cameraFlipBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  cameraTopCloseBtn: {
    position: 'absolute', top: 52, right: 18, zIndex: 10,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center',
  },

  // Camera roll strip (recent photos under the live camera)
  cameraRollStrip: {
    position: 'absolute', left: 0, right: 0, bottom: 118,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  cameraRollContent: { paddingHorizontal: 10, gap: 8 },
  cameraRollThumbWrap: {
    borderRadius: 10, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)',
  },
  cameraRollThumb: { width: 60, height: 60 },

  // ── Video message bubble ────────────────────────────────────────────────────
  // Match image bubbles exactly so the full video space is reserved from the
  // instant the optimistic message appears through upload completion.
  videoThumbWrap: {
    width: 200,
    height: 200,
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  // Fills the wrap completely — width/height 100% of the parent.
  videoThumbImage: { width: '100%', height: '100%', borderRadius: 12 },
  videoPlaceholder: { backgroundColor: '#1c2733', alignItems: 'center', justifyContent: 'center' },
  videoPlayOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center', justifyContent: 'center',
  },

  // ── Media caption (shown under image/video bubbles) ─────────────────────────
  mediaCaptionIn: { color: '#fff', fontSize: 15, paddingHorizontal: 4, paddingTop: 6 },
  mediaCaptionOut: { fontSize: 15, paddingHorizontal: 4, paddingTop: 6 },

  // Column(crossAxisAlignment: end) wrapping the caption text + time row.
  // The caption fills full width and wraps naturally. The time row sits on its
  // own line pinned to the right — exactly like Flutter's CrossAxisAlignment.end.
  mediaCaptionBlock: {
    flexDirection: 'column',
    alignItems: 'flex-end',    // every child right-aligned — CrossAxisAlignment.end
    paddingHorizontal: 4,
    paddingTop: 6,
    paddingBottom: 4,
  },
  // Row(mainAxisAlignment: end) for the timestamp + tick icon.
  mediaCaptionTimeRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end', // MainAxisAlignment.end
    alignItems: 'center',
    gap: 3,
    marginTop: 2,
  },

  // ── Media preview + caption screen ──────────────────────────────────────────
  mediaPreviewClose: {
    position: 'absolute', top: 48, left: 16, zIndex: 10,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  mediaPreviewBody: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  mediaPreviewMedia: { width: '100%', height: '100%' },
  mediaPreviewBar: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 10,
    paddingHorizontal: 12, paddingVertical: 12, paddingBottom: 28,
    backgroundColor: 'rgba(0,0,0,0.85)',
  },
  mediaPreviewInputWrap: {
    flex: 1, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 24,
    paddingHorizontal: 16, paddingVertical: Platform.OS === 'ios' ? 10 : 4,
    maxHeight: 120, justifyContent: 'center',
  },
  mediaPreviewInput: { color: '#fff', fontSize: 16, maxHeight: 100 },
  mediaPreviewSendBtn: {
    width: 48, height: 48, borderRadius: 24, backgroundColor: COLORS.blue,
    alignItems: 'center', justifyContent: 'center',
  },

  // ── Carousel Navigation ────────────────────────────────────────────────────
  carouselContainer: {
    flex: 1,
    backgroundColor: '#000',
    flexDirection: 'column',
  },
  carouselViewport: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  carouselFullMedia: {
    width: '100%',
    height: '100%',
  },
  deleteMediaBtn: {
    position: 'absolute',
    top: -20,
    right: 16,
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(255, 59, 48, 0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 10,
  },

  // ── Thumbnail Row (Bottom) ─────────────────────────────────────────────────
  carouselThumbnailRowContainer: {
    position: 'relative',
    height: 90,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  carouselThumbnailRow: {
    width: '100%',
    height: '100%',
  },
  carouselThumbnailContent: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 8,
  },
  carouselThumbnail: {
    width: 74,
    height: 74,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  carouselThumbnailActive: {
    borderColor: COLORS.blue,
  },
  carouselThumbnailImage: {
    width: '100%',
    height: '100%',
  },
  carouselVideoPlayIcon: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },

  // ── Caption Bar (Bottom) ───────────────────────────────────────────────────
  carouselCaptionBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    paddingBottom: 20,
    backgroundColor: 'rgba(0,0,0,0.9)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  carouselCaptionInputWrap: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 10 : 4,
    maxHeight: 120,
    justifyContent: 'center',
  },
  carouselCaptionInput: {
    color: '#fff',
    fontSize: 16,
    maxHeight: 100,
  },
  carouselSendBtn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Old Carousel Navigation (Removed) ──────────────────────────────────────
  carouselNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 12,
    display: 'none',
  },
  carouselNavBtn: {
    padding: 8,
    display: 'none',
  },
  carouselCounter: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    minWidth: 60,
    textAlign: 'center',
    display: 'none',
  },

  // ── Thumbnail Row (Old - Removed) ──────────────────────────────────────────
  thumbnailRow: {
    backgroundColor: 'rgba(0,0,0,0.3)',
    display: 'none',
  },
  thumbnailRowContent: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    gap: 8,
    display: 'none',
  },
  thumbnail: {
    width: 70,
    height: 70,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
    display: 'none',
  },
  thumbnailActive: {
    borderColor: COLORS.blue,
    display: 'none',
  },
  thumbnailImage: {
    width: '100%',
    height: '100%',
    display: 'none',
  },
  videoPlayIcon: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    display: 'none',
  },

  // ── Full-screen video viewer ────────────────────────────────────────────────
  videoViewerContainer: { flex: 1, backgroundColor: '#000' },
  cameraShutterBtn: { alignItems: 'center', justifyContent: 'center' },
  cameraShutter: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(255,255,255,0.95)', borderWidth: 4, borderColor: 'rgba(255,255,255,0.60)' },

  // ── Recording overlay ─────────────────────────────────────────────────────
  recordingOverlayContainer: {
    flex: 1,
  },

  // ── Permission banner ─────────────────────────────────────────────────────
  permissionBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.18)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  permissionText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
  },
  permissionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  permissionBtn: {
    backgroundColor: COLORS.blue,
    borderRadius: RADIUS.md,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  permissionBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  permissionDismissBtn: {
    padding: 4,
  },

  // ── Upload error banner ───────────────────────────────────────────────────
  uploadErrorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.25)',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  uploadErrorText: {
    flex: 1,
    fontSize: 13,
    color: COLORS.text,
  },
  retryBtn: {
    backgroundColor: COLORS.blue,
    borderRadius: RADIUS.md,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  retryBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },

  // ── Upload progress ───────────────────────────────────────────────────────
  uploadProgressBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  uploadProgressFill: {
    height: 3,
    backgroundColor: COLORS.blue,
  },

  // ── Image viewer ──────────────────────────────────────────────────────────
  imageViewerContainer: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerBackdrop: {
    flex: 1,
    width: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerImage: {
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height,
  },
  imageViewerCloseBtn: {
    position: 'absolute',
    top: 50,
    right: 20,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },

  // ── Profile Modal ──────────────────────────────────────────────────────────
  profileOverlay: { flex: 1, justifyContent: 'flex-end' },
  profileBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.40)' },
  profileSheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderTopWidth: 1,
    maxHeight: '88%',
    ...SHADOW.glow,
  },
  profileHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(30,156,240,0.30)',
    marginTop: 10,
    marginBottom: 4,
  },
  profileCloseBtn: {
    position: 'absolute',
    top: 14,
    right: 16,
    zIndex: 10,
    padding: 6,
  },
  profileScroll: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 40,
    alignItems: 'center',
    gap: 8,
  },
  profileAvatarWrap: { marginTop: 8, marginBottom: 4 },
  profileName: { fontSize: 20, fontWeight: '800', textAlign: 'center' },
  profileStatus: { fontSize: 13, textAlign: 'center', marginBottom: 8 },
  profileActions: {
    flexDirection: 'row',
    gap: 12,
    marginVertical: 8,
    width: '100%',
    justifyContent: 'center',
  },
  profileActionBtn: {
    flex: 1,
    maxWidth: 150,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: RADIUS.lg,
  },
  profileActionIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },
  profileActionLabel: { fontSize: 12, fontWeight: '600' },
  profileSectionLabel: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  infoMediaBox: {
    width: '100%',
    height: 90,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  infoMediaEmpty: {
    fontSize: 13,
  },
  profileMediaRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: RADIUS.lg,
  },
  profileMediaLabel: { fontSize: 14, fontWeight: '600' },
  profileMediaCount: { fontSize: 13 },

  // ── Group Members in Profile Modal ────────────────────────────────────────
  profileMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
  },
  profileMemberName: {
    fontSize: 14,
    fontWeight: '600',
  },
  profileMemberYou: {
    fontSize: 12,
    fontWeight: '400',
  },
  profileMemberStatus: {
    fontSize: 12,
    marginTop: 2,
  },
  profileMemberLoadingBox: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingVertical: 20,
    borderRadius: RADIUS.lg,
  },
  profileMemberLoadingText: {
    fontSize: 13,
  },
  profileMemberEmptyBox: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 24,
    borderRadius: RADIUS.lg,
  },
  profileMemberEmptyText: {
    fontSize: 13,
  },

  // ── Past Members in Profile Modal ─────────────────────────────────────────
  profilePastMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 8,
    opacity: 0.65, // Reduced opacity to distinguish from active members
  },
  profilePastMemberName: {
    opacity: 0.85, // Slightly reduced opacity for the name
  },

  // ── 3-dot menu dropdown ───────────────────────────────────────────────────
  menuBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'transparent',
  },
  menuCard: {
    position: 'absolute',
    top: 102, // Below the header (52 padding + 40 avatar + 10 spacing)
    right: 14,
    minWidth: 200,
    borderRadius: RADIUS.lg,
    overflow: 'hidden',
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '600',
  },
  menuItemDanger: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(239,68,68,0.15)',
  },
  menuItemTextDanger: {
    color: COLORS.missed,
  },

  // ── Search Modal ──────────────────────────────────────────────────────────
  searchOverlay: {
    flex: 1,
    justifyContent: 'flex-start',
    paddingTop: 60,
    paddingHorizontal: 16,
  },
  searchBackdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  searchModal: {
    borderRadius: RADIUS.xl,
    overflow: 'hidden',
    maxHeight: '80%',
  },
  searchInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    margin: 16,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
    margin: 0,
  },
  searchResultsContainer: {
    flex: 1,
    maxHeight: 400,
  },
  searchResultsList: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 8,
  },
  searchEmpty: {
    paddingVertical: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchEmptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 14,
    borderRadius: RADIUS.lg,
    gap: 12,
  },
  searchResultContent: {
    flex: 1,
    gap: 4,
  },
  searchResultHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  searchResultSender: {
    fontSize: 14,
    fontWeight: '600',
  },
  searchResultTime: {
    fontSize: 11,
  },
  searchResultText: {
    fontSize: 13,
    lineHeight: 18,
  },
  searchResultHighlight: {
    fontWeight: '700',
  },
  searchHighlightOverlay: {
    backgroundColor: 'rgba(30,156,240,0.18)',
    borderRadius: RADIUS.md,
    zIndex: 10,
  },
  searchHighlightOverlayActive: {
    backgroundColor: 'rgba(251,191,36,0.40)', // amber for the current active match
  },
  // ── Inline search bar ─────────────────────────────────────────────────────
  searchBar: {
    gap: 6,
    paddingRight: 6,
  },
  searchBarInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 6,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.20)',
    color: COLORS.text,
  },
  searchMatchCount: {
    fontSize: 12,
    color: COLORS.sub,
    fontWeight: '600',
    minWidth: 42,
    textAlign: 'right',
  },
  searchNavBtn: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Block Contact in Profile Modal ────────────────────────────────────────
  profileBlockBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    borderRadius: RADIUS.lg,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 8,
  },
  profileBlockText: {
    fontSize: 14,
    fontWeight: '600',
  },

  // ── Inline Confirmation Card ──────────────────────────────────────────────
  confirmationCard: {
    width: '100%',
    borderRadius: RADIUS.xl,
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: 'center',
    gap: 12,
    marginBottom: 8,
  },
  confirmationIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  confirmationTitle: {
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  confirmationBody: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  confirmationButtons: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    marginTop: 8,
  },
  confirmationCancelBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmationCancelText: {
    fontSize: 15,
    fontWeight: '600',
  },
  confirmationBlockBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmationBlockText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#fff',
  },

  // ── Blocked Banner ────────────────────────────────────────────────────────
  inputBarWithBanner: {
    // Container for banner + input bar when user blocks someone
  },
  blockedBanner: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  blockedBannerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  blockedBannerTitle: {
    fontSize: 14,
    fontWeight: '500',
  },

  // ── Message Action Toolbar ────────────────────────────────────────────────
  selectedMessage: {
    backgroundColor: 'rgba(30,156,240,0.12)',
    borderRadius: RADIUS.md,
  },
  actionToolbar: {
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  actionToolbarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    gap: 8,
  },
  actionToolbarBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    gap: 4,
    minWidth: 50,
  },
  actionToolbarLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  actionToolbarClose: {
    padding: 4,
  },
  actionToolbarCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
    marginBottom: 4,
  },
  actionToolbarCount: {
    fontSize: 14,
    fontWeight: '700',
  },

  // ── Forwarded label ───────────────────────────────────────────────────────
  forwardedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 2,
  },
  forwardedLabelIn: {
    fontSize: 11,
    fontStyle: 'italic',
    color: 'rgba(255,255,255,0.7)',
  },
  forwardedLabelOut: {
    fontSize: 11,
    fontStyle: 'italic',
  },

  // ── Reply Preview ──────────────────────────────────────────────────────────
  replyPreview: {
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  replyPreviewBar: {
    width: 3,
    height: 36,
    backgroundColor: COLORS.blue,
    borderRadius: 2,
  },
  replyPreviewContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  replyPreviewLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 2,
  },
  replyPreviewText: {
    fontSize: 13,
  },
  replyPreviewClose: {
    padding: 4,
  },

  // ── Reply Bubble (inside message) ──────────────────────────────────────────
  replyBubble: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: RADIUS.md,
    marginBottom: 6,
  },
  replyBubbleBar: {
    width: 3,
    height: 32,
    backgroundColor: 'rgba(255,255,255,0.6)',
    borderRadius: 2,
  },
  replyBubbleSender: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 2,
  },
  replyBubbleText: {
    fontSize: 12,
  },

  // ── Location Menu ─────────────────────────────────────────────────────────
  locationOption: {
    flexDirection: 'row',
    gap: 16,
    padding: 16,
    borderRadius: RADIUS.lg,
    marginBottom: 12,
  },
  locationIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(30,156,240,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationOptionText: {
    flex: 1,
    gap: 6,
  },
  locationOptionTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  locationOptionDesc: {
    fontSize: 13,
  },
  durationButtons: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  durationButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    alignItems: 'center',
  },
  durationText: {
    fontSize: 14,
    fontWeight: '600',
  },
  startLiveButton: {
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    ...SHADOW.button,
  },
  startLiveButtonInner: {
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startLiveButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },

  // ── Contact picker ────────────────────────────────────────────────────────
  contactPickerSheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 20 : 20,
    paddingHorizontal: 20, paddingTop: 12,
    height: '85%',
    ...SHADOW.glow,
  },
  contactCheckbox: {
    width: 24, height: 24, borderRadius: 12,
    borderWidth: 2, borderColor: COLORS.sub,
    alignItems: 'center', justifyContent: 'center',
  },
  contactCheckboxOn: { backgroundColor: COLORS.blue, borderColor: COLORS.blue },
  contactSendBtn: { marginTop: 10, borderRadius: RADIUS.full, overflow: 'hidden' },
  contactSendBtnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 13, borderRadius: RADIUS.full,
  },
  contactSendBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  contactSearchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
    borderRadius: RADIUS.full,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  contactSearchInput: { flex: 1, fontSize: 14, padding: 0 },
  contactPickerList: { flex: 1 },
  contactPickerContent: { paddingBottom: 20 },
  contactPickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },

  // ── Scroll-to-bottom FAB ────────────────────────────────────────────────────
  scrollToBottomBtn: {
    position: 'absolute',
    bottom: 80,          // sits just above the input bar
    right: 16,
    zIndex: 20,
  },
  scrollToBottomInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.blue,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },

  // ── Cart FAB ────────────────────────────────────────────────────────────────
  cartFab: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    borderRadius: RADIUS.full,
    overflow: 'hidden',
    zIndex: 20,
    ...SHADOW.button,
  },
  cartFabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 11,
    gap: 6,
    borderRadius: RADIUS.full,
  },
  cartFabLabel: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  cartBadge: {
    backgroundColor: '#fff',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  cartBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: COLORS.blue,
  },

});