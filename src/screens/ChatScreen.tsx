// ─── Screen: Chat ────────────────────────────────────────────────────────────
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, FlatList, TouchableOpacity, ScrollView,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform,
  ActivityIndicator, PanResponder, Linking, Modal, Alert, Share,
  GestureResponderEvent, PanResponderGestureState, Image, Dimensions,
  Animated, Keyboard,
} from 'react-native';
import { useNavigation, useRoute, RouteProp, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NotificationTestPanel } from '../components/NotificationTestPanel';

// Platform-specific imports for native-only modules
let CameraView: any = null;
let useCameraPermissions: any = null;
let useMediaLibraryPermissions: any = null;

if (Platform.OS !== 'web') {
  try {
    const camera = require('expo-camera');
    CameraView = camera.CameraView;
    useCameraPermissions = camera.useCameraPermissions;

    const mediaLibrary = require('expo-media-library');
    useMediaLibraryPermissions = mediaLibrary.usePermissions;
  } catch (err) {
    console.warn('[ChatScreen] Native modules not available:', err);
  }
} else {
  // Web fallbacks
  useCameraPermissions = () => [null, () => Promise.resolve({ status: 'denied' })];
  useMediaLibraryPermissions = () => [null, () => Promise.resolve({ status: 'denied' })];
}

import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { Avatar } from '../components';
import { VoiceMessageBubble } from '../components/VoiceMessageBubble';
import { FileMessageBubble } from '../components/FileMessageBubble';

import { VoiceRecordingOverlay } from '../components/VoiceRecordingOverlay';
import { ForwardModal } from '../components/ForwardModal';
import { MessageInfoModal } from '../components/MessageInfoModal';
import { CatalogBubble } from '../components/CatalogBubble';
import { useAuth } from '../hooks/useAuth';
import { useMessages, FireMessage } from '../hooks/useMessages';
import { useVoicePlayer } from '../hooks/useVoicePlayer';
import { useVoiceRecorder, RecordingResult } from '../hooks/useVoiceRecorder';
import { useOutgoingCall } from '../hooks/useOutgoingCall';


import { usePhoneBook } from '../hooks/usePhoneBook';
import { useOtherUserPresence, useWritePresence } from '../hooks/usePresence';
import { fetchUserPrivacySettings } from '../hooks/usePrivacySettings';
import { clearLocalMessages } from '../hooks/useLocalMessages';
import { useContacts, AppContact } from '../hooks/useContacts';

import { uploadVoiceNote, UploadProgress } from '../utils/voiceNoteStorage';
import { sendVoiceMessage, sendImageMessage, sendFileMessage } from '../hooks/useChatActions';
import { parseSystemMessage } from '../utils/systemMessageParser';
import { getDateLabel, groupMessagesByDate } from '../utils/dateUtils';
import { useTypingIndicator } from '../hooks/useTypingIndicator';
import { TypingIndicator } from '../components/TypingIndicator';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList } from '../types';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useCart } from '../context/CartContext';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Chat'>;
type RoutePropType = RouteProp<RootStackParamList, 'Chat'>;

// ── Constants ────────────────────────────────────────────────────────────────
const CANCEL_THRESHOLD_DP = 50;
const MAX_UPLOAD_RETRIES = 3;
const PERMISSION_MESSAGE_DURATION_MS = 3000;
const MUTE_STORAGE_KEY_PREFIX = 'chat_mute_';

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

// ── Past Member Interface ──────────────────────────────────────────────────────
interface PastMember {
  userId: string;
  displayName: string;
  photoURL: string | null;
  leftAt: Date;
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

/** Save muted state to AsyncStorage */
async function saveMutedState(chatId: string, muted: boolean): Promise<void> {
  try {
    const key = `${MUTE_STORAGE_KEY_PREFIX}${chatId}`;
    await AsyncStorage.setItem(key, muted.toString());
  } catch (error) {
    console.error('[ChatScreen] Failed to save muted state:', error);
  }
}

// ─── SwipeableMessage ──────────────────────────────────────────────────────────
// Wraps a message bubble so the user can swipe it to the right to reply.
// A reply arrow fades/slides in as the row is dragged; releasing past the
// threshold triggers onReply and the row springs back.
const SWIPE_REPLY_THRESHOLD = 56;   // px of drag needed to trigger a reply
const SWIPE_MAX_TRANSLATE   = 72;   // clamp so the row can't be dragged too far

const SwipeableMessage = React.memo(function SwipeableMessage({
  children,
  onReply,
  onLongPress,
}: {
  children: React.ReactNode;
  onReply: () => void;
  onLongPress: () => void;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const triggeredRef = useRef(false);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        // Capture-phase move check: claim a deliberate horizontal LEFT-swipe
        // (negative dx) even if an inner Touchable or the FlatList scroll grabbed
        // the touch on press-in. Left-swipe avoids clashing with the iOS
        // edge-swipe-back gesture. Vertical scrolls are left to the list.
        onMoveShouldSetPanResponderCapture: (_evt, g) =>
          g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_evt, g) =>
          g.dx < -8 && Math.abs(g.dx) > Math.abs(g.dy) * 1.2,

        onPanResponderGrant: () => {
          triggeredRef.current = false;
        },

        onPanResponderMove: (_evt, g) => {
          if (g.dx >= 0) { translateX.setValue(0); return; }
          // Drag left → negative translate, clamped
          const x = Math.max(g.dx, -SWIPE_MAX_TRANSLATE);
          translateX.setValue(x);
          if (!triggeredRef.current && -x >= SWIPE_REPLY_THRESHOLD) {
            triggeredRef.current = true; // latch (fires once per swipe)
          }
        },

        onPanResponderRelease: (_evt, g) => {
          const passed = -g.dx >= SWIPE_REPLY_THRESHOLD;
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            friction: 7,
            tension: 70,
          }).start();
          if (passed) onReply();
        },

        onPanResponderTerminate: () => {
          Animated.spring(translateX, {
            toValue: 0, useNativeDriver: true, friction: 7, tension: 70,
          }).start();
        },
        // Don't let other components (the FlatList) steal the gesture mid-swipe
        onPanResponderTerminationRequest: () => false,
      }),
    [onReply, translateX],
  );

  // Reply arrow opacity/scale ramps up as the row is dragged left (negative dx).
  const replyIconOpacity = translateX.interpolate({
    inputRange: [-SWIPE_REPLY_THRESHOLD, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const replyIconScale = translateX.interpolate({
    inputRange: [-SWIPE_REPLY_THRESHOLD, 0],
    outputRange: [1, 0.5],
    extrapolate: 'clamp',
  });

  return (
    <View>
      {/* Reply arrow revealed on the right as the row slides left */}
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          right: 16,
          top: 0,
          bottom: 0,
          justifyContent: 'center',
          opacity: replyIconOpacity,
          transform: [{ scale: replyIconScale }],
        }}
      >
        <View style={{
          width: 34, height: 34, borderRadius: 17,
          backgroundColor: 'rgba(9,178,238,0.15)',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <AppIcon name="arrow-undo" size={18} color={COLORS.blue} fixedColor />
        </View>
      </Animated.View>

      <Animated.View
        {...panResponder.panHandlers}
        style={{ transform: [{ translateX }] }}
      >
        <TouchableOpacity
          activeOpacity={1}
          onLongPress={onLongPress}
          delayLongPress={300}
        >
          {children}
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
});

export default function ChatScreen() {
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RoutePropType>();
  const insets = useSafeAreaInsets();
  const { chatId, displayName, isGroup, otherUserId, otherUserPhoto } = route.params;
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();

  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [mediaLibraryPermission, requestMediaLibraryPermission] = useMediaLibraryPermissions();

  // ── Auth — get current user ID ──────────────────────────────────
  const { user } = useAuth();
  const userId = user?.uid ?? null;

  // ── Cart ────────────────────────────────────────────────────────
  const { totalItems, formatOrderSummary, clearCart } = useCart();
  const [cartSheetVisible, setCartSheetVisible] = useState(false);

  // ── Seller catalog (loaded on mount for 1-on-1 chats) ──
  const [sellerCatalog,      setSellerCatalog]      = useState<import('../types').CatalogItem[]>([]);
  const [sellerCollections,  setSellerCollections]  = useState<import('../types').CatalogCollection[]>([]);
  const [loadingCatalog,     setLoadingCatalog]     = useState(false);
  // which collection is expanded inside the profile sheet (null = all collapsed)
  const [expandedProfileCol, setExpandedProfileCol] = useState<string | null>(null);
  // catalog full-screen sheet
  const [catalogSheetVisible, setCatalogSheetVisible] = useState(false);
  const [activeCatalogCol,    setActiveCatalogCol]    = useState<string | null>(null); // 'all' | colId

  // ── Messages — real-time Firestore stream ───────────────────────
  const { messages, loading, sendMessage } = useMessages(chatId, userId);

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
    | { type: 'dateSeparator'; dateLabel: string; date: Date };

  const messagesWithDates = useMemo((): MessageListItem[] => {
    if (filteredMessages.length === 0) return [];

    const items: MessageListItem[] = [];
    let currentDateLabel: string | null = null;

    filteredMessages.forEach((message, index) => {
      if (!message.timestamp) {
        // Skip messages without timestamps
        items.push({ type: 'message', data: message });
        return;
      }

      const messageDate = message.timestamp instanceof Date
        ? message.timestamp
        : new Date(message.timestamp);

      if (isNaN(messageDate.getTime())) {
        // Skip invalid dates
        items.push({ type: 'message', data: message });
        return;
      }

      const dateLabel = getDateLabel(messageDate, 'long');

      // Insert date separator if we're entering a new day
      if (dateLabel !== currentDateLabel) {
        items.push({
          type: 'dateSeparator',
          dateLabel,
          date: messageDate,
        });
        currentDateLabel = dateLabel;
      }

      items.push({ type: 'message', data: message });
    });

    return items;
  }, [filteredMessages]);

  // ── Voice player — single-active-player management ─────────────
  const player = useVoicePlayer();

  // ── Typing presence ────────────────────────────────────────────
  const { typingUsers, setTyping } = useTypingIndicator(chatId, userId);

  // ── Voice recorder ─────────────────────────────────────────────
  const recorder = useVoiceRecorder();

  // ── Outgoing call ──────────────────────────────────────────────
  const outgoingCall = useOutgoingCall();



  // ── Phone book name resolver (saved contact name, else phone number) ──
  const { resolveName } = usePhoneBook();

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

  // ── Presence: write current user online, watch other user's status ────────
  useWritePresence(userId);
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
  const { contacts: phoneContacts, loading: contactsLoading, hasPermission: contactsPermission } = useContacts();



  const [input, setInput] = useState('');
  const isSendingRef = useRef(false);
  const [isSending, setIsSending] = useState(false);
  const [editingMessage, setEditingMessage] = useState<any | null>(null);
  const listRef = useRef<FlatList>(null);
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [muted, setMuted] = useState(false);

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
  const messageInputRef = useRef<TextInput>(null);

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

  // ── Selected message state (for long-press actions) ────────────
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [showMessageActions, setShowMessageActions] = useState(false);

  // ── Reply state ─────────────────────────────────────────────────
  const [replyingTo, setReplyingTo] = useState<FireMessage | null>(null);

  // ── Forward state ───────────────────────────────────────────────
  const [forwardModalVisible, setForwardModalVisible] = useState(false);
  const [messageToForward, setMessageToForward] = useState<FireMessage | null>(null);

  // ── Message info state ──────────────────────────────────────────
  const [messageInfoVisible, setMessageInfoVisible] = useState(false);
  const [messageForInfo, setMessageForInfo] = useState<FireMessage | null>(null);

  // ── Contact picker state (share contact via 3-dot menu) ─────────
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [contactQuery, setContactQuery] = useState('');

  // Debug log for contacts
  useEffect(() => {
    if (contactPickerOpen) {
      console.log('[ChatScreen] Contact picker opened. Contacts:', phoneContacts?.length ?? 0, 'Loading:', contactsLoading, 'Permission:', contactsPermission);
    }
  }, [contactPickerOpen, phoneContacts, contactsLoading, contactsPermission]);

  // ── Camera ref ──────────────────────────────────────────────────
  const cameraRef = useRef<any>(null);

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

  // ── Fetch group members when profile modal opens ────────────────
  useEffect(() => {
    if (!profileModalOpen || !isGroup || !chatId) return;

    const fetchGroupMembers = async () => {
      setLoadingMembers(true);
      try {
        console.log('[ChatScreen] Fetching group members for chat:', chatId);

        // First, get the chat document to retrieve member IDs
        const fsDbMembers = db as ReturnType<typeof firestore>;
        const chatSnapMembers = await fsDbMembers.collection('chats').doc(chatId).get();

        if (!chatSnapMembers.exists) {
          console.warn('[ChatScreen] Chat document not found');
          setGroupMembers([]);
          setLoadingMembers(false);
          return;
        }

        const chatDataMembers = chatSnapMembers.data()!;
        const memberIds = chatDataMembers.members as string[] || [];

        console.log('[ChatScreen] Found member IDs:', memberIds);

        if (memberIds.length === 0) {
          setGroupMembers([]);
          setLoadingMembers(false);
          return;
        }

        // Fetch each member's profile from the users collection
        const memberPromises = memberIds.map(async (memberId) => {
          try {
            const fsDb2 = db as ReturnType<typeof firestore>;
            const userSnap = await fsDb2.collection('users').doc(memberId).get();

            if (userSnap.exists()) {
              const userData = userSnap.data()!;
              const photoPrivacy = userData.privacyProfilePhoto ?? 'Contacts';
              return {
                userId: memberId,
                displayName: resolveName(userData.phone, 'Unknown'),
                photoURL: photoPrivacy === 'Nobody' ? null : (userData.photoURL || null),
                status: userData.status || 'offline',
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
        console.log('[ChatScreen] Fetching past members for chat:', chatId);

        // First, get the chat document to check for pastMembers field
        const fsDbPast2 = db as ReturnType<typeof firestore>;
        const chatSnapP = await fsDbPast2.collection('chats').doc(chatId).get();

        if (!chatSnapP.exists) {
          console.warn('[ChatScreen] Chat document not found');
          setPastMembers([]);
          setLoadingPastMembers(false);
          return;
        }

        const chatDataP = chatSnapP.data()!;
        const pastMemberData = chatDataP.pastMembers as Array<{
          userId: string;
          leftAt: any; // Firestore Timestamp
        }> | undefined;

        console.log('[ChatScreen] Found past member data:', pastMemberData);

        if (!pastMemberData || pastMemberData.length === 0) {
          setPastMembers([]);
          setLoadingPastMembers(false);
          return;
        }

        // Fetch each past member's profile from the users collection
        const pastMemberPromises = pastMemberData.map(async (pastMemberEntry) => {
          try {
            const fsDb3 = db as ReturnType<typeof firestore>;
            const userSnap = await fsDb3.collection('users').doc(pastMemberEntry.userId).get();

            // Convert Firestore Timestamp to Date
            const leftAtDate = pastMemberEntry.leftAt?.toDate ?
              pastMemberEntry.leftAt.toDate() :
              new Date(pastMemberEntry.leftAt);

            if (userSnap.exists()) {
              const userData = userSnap.data()!;
              return {
                userId: pastMemberEntry.userId,
                displayName: resolveName(userData.phone, 'Unknown'),
                photoURL: userData.photoURL || null,
                leftAt: leftAtDate,
              } as PastMember;
            }

            // Fallback for users without profile data
            return {
              userId: pastMemberEntry.userId,
              displayName: 'Unknown User',
              photoURL: null,
              leftAt: leftAtDate,
            } as PastMember;
          } catch (error) {
            console.error('[ChatScreen] Error fetching past member:', pastMemberEntry.userId, error);
            return {
              userId: pastMemberEntry.userId,
              displayName: 'Unknown User',
              photoURL: null,
              leftAt: new Date(),
            } as PastMember;
          }
        });

        const members = await Promise.all(pastMemberPromises);
        console.log('[ChatScreen] Fetched past members:', members.length);
        setPastMembers(members);
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
  useEffect(() => {
    if (isGroup || !otherUserId) {
      setSellerCatalog([]);
      setSellerCollections([]);
      setLoadingCatalog(false);
      return;
    }
    let cancelled = false;
    setLoadingCatalog(true);
    (async () => {
      try {
        const fsDbCat = db as ReturnType<typeof firestore>;
        const snap = await fsDbCat.collection('users').doc(otherUserId).get();
        if (!cancelled && snap.exists()) {
          setSellerCatalog(snap.data()?.catalog ?? []);
          setSellerCollections(snap.data()?.collections ?? []);
        } else if (!cancelled) {
          setSellerCatalog([]);
          setSellerCollections([]);
        }
      } catch (err) {
        console.warn('[ChatScreen] Failed to load seller catalog:', err);
        if (!cancelled) {
          setSellerCatalog([]);
          setSellerCollections([]);
        }
      } finally {
        if (!cancelled) setLoadingCatalog(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isGroup, otherUserId]);

  // ── Block status: real-time listener ───────────────────────────
  // Replaces the one-shot check + useFocusEffect approach so the UI updates
  // immediately if the block state changes while the chat is open.
  useEffect(() => {
    if (!userId || !otherUserId || isGroup) {
      setCheckingBlockedStatus(false);
      setIsBlocked(false);
      return;
    }

    setCheckingBlockedStatus(true);

    const fsDbBlock = db as ReturnType<typeof firestore>;

    // Use refs to avoid stale-closure bugs in the onSnapshot callbacks.
    // Each listener can only see its own doc — it sets its own state and
    // derives isBlocked from the latest values of both sides.
    const blockedByMeRef   = { current: false };
    const blockedByThemRef = { current: false };

    const unsubMe = fsDbBlock
      .collection('users').doc(userId).collection('blockedUsers').doc(otherUserId)
      .onSnapshot(
        (snap) => {
          const exists = snap.exists();
          blockedByMeRef.current = exists;
          setBlockedByMe(exists);
          setIsBlocked(exists || blockedByThemRef.current);
        },
        () => {},
      );

    const unsubThem = fsDbBlock
      .collection('users').doc(otherUserId).collection('blockedUsers').doc(userId)
      .onSnapshot(
        (snap) => {
          const exists = snap.exists();
          blockedByThemRef.current = exists;
          setBlockedByThem(exists);
          setIsBlocked(blockedByMeRef.current || exists);
        },
        () => {},
      );

    // After both listeners attach, derive combined state once
    Promise.all([
      fsDbBlock.collection('users').doc(userId).collection('blockedUsers').doc(otherUserId).get(),
      fsDbBlock.collection('users').doc(otherUserId).collection('blockedUsers').doc(userId).get(),
    ]).then(([byMe, byThem]) => {
      const meExists   = byMe.exists();
      const themExists = byThem.exists();
      blockedByMeRef.current   = meExists;
      blockedByThemRef.current = themExists;
      setBlockedByMe(meExists);
      setBlockedByThem(themExists);
      setIsBlocked(meExists || themExists);
    }).catch(() => {}).finally(() => setCheckingBlockedStatus(false));

    return () => { unsubMe(); unsubThem(); };
  }, [userId, otherUserId, isGroup]);

  // ── Stop playback on unmount / navigation away ──────────────────
  useEffect(() => {
    return () => {
      player.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-scroll when new messages arrive ────────────────────────
  useEffect(() => {
    if (filteredMessages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [filteredMessages.length]);

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

  // ── Check & Trigger Auto Responder for Businesses ───────────────
  const checkAndTriggerAutoResponder = useCallback(async () => {
    if (isGroup || !otherUserId || !userId) return;

    try {
      const fsDb = db as ReturnType<typeof firestore>;
      const recipientSnap = await fsDb.collection('users').doc(otherUserId).get();
      if (!recipientSnap.exists) return;

      const recipientData = recipientSnap.data()!;
      if (!recipientData.autoResponderEnabled || !recipientData.auto_responder_message) return;

      const isOutsideWorkingHours = (schedule: any) => {
        if (!schedule) return false;
        const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const now = new Date();
        const currentDay = DAYS[now.getDay()];
        const todaySchedule = schedule[currentDay];
        if (!todaySchedule || todaySchedule.open === 'Closed') return true;

        const convertToMinutes = (timeStr: string) => {
          const match = timeStr.match(/(\d+):(\d+)\s+(AM|PM)/i);
          if (!match) return 0;
          let hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const ampm = match[3].toUpperCase();
          if (ampm === 'PM' && hours < 12) hours += 12;
          if (ampm === 'AM' && hours === 12) hours = 0;
          return hours * 60 + minutes;
        };

        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const openMinutes = convertToMinutes(todaySchedule.open);
        const closeMinutes = convertToMinutes(todaySchedule.close);
        return currentMinutes < openMinutes || currentMinutes >= closeMinutes;
      };

      if (isOutsideWorkingHours(recipientData.workSchedule)) {
        // Find the last message from the recipient in current messages array
        const lastMessageFromRecipient = messages.slice().reverse().find(m => m.senderId === otherUserId);
        const isAlreadyReplied = lastMessageFromRecipient?.text === recipientData.auto_responder_message;

        if (!isAlreadyReplied) {
          // Add small delay to feel natural
          setTimeout(async () => {
            await fsDb.collection('chats').doc(chatId).collection('messages').add({
              senderId: otherUserId,
              text: recipientData.auto_responder_message,
              type: 'text',
              timestamp: firestore.FieldValue.serverTimestamp(),
              readBy: [otherUserId],
              deliveredTo: [],
              blockedMessage: false,
            });
            await fsDb.collection('chats').doc(chatId).update({
              'lastMessage.text': recipientData.auto_responder_message,
              'lastMessage.senderId': otherUserId,
              'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
            });
          }, 1000);
        }
      }
    } catch (err) {
      console.warn('[ChatScreen] Error checking auto-responder:', err);
    }
  }, [isGroup, otherUserId, userId, chatId, messages]);


  // ── Upload and send voice note ──────────────────────────────────
  const handleVoiceUploadAndSend = useCallback(async (result: RecordingResult) => {
    if (!userId) return;

    const messageId = (db as ReturnType<typeof firestore>)
      .collection('chats').doc(chatId).collection('messages').doc().id;

    setIsUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    pendingRecordingRef.current = result;

    try {
      const uploadResult = await uploadVoiceNote(
        result.uri,
        chatId,
        messageId,
        (progress: UploadProgress) => {
          setUploadProgress(progress.percentage);
        },
      );

      await sendVoiceMessage(chatId, userId, uploadResult.downloadUrl, result.durationMs);

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

      if (isNetworkError && retryCount < MAX_UPLOAD_RETRIES - 1) {
        setUploadError('Upload failed. Tap to retry.');
        // Keep pendingRecordingRef so retry works
      } else {
        setUploadError('Upload could not be completed. Tap to retry.');
        // Keep pendingRecordingRef so the user can still retry from the banner
      }
    }
  }, [userId, chatId, retryCount, checkAndTriggerAutoResponder]);

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
    if (isSendingRef.current) return;
    // Hard stop: if they blocked us, we cannot send anything
    if (blockedByThem) return;
    const trimmed = (text ?? input).trim();
    if (!trimmed) return;

    isSendingRef.current = true;
    setIsSending(true);
    setTyping(false);

    try {
      // ── Edit existing message ────────────────────────────────────
      if (editingMessage) {
        const fsDbEdit = db as ReturnType<typeof firestore>;
        await fsDbEdit
          .collection('chats').doc(chatId)
          .collection('messages').doc(editingMessage.messageId)
          .update({
            text: trimmed,
            edited: true,
            editedAt: firestore.FieldValue.serverTimestamp(),
          });
        setEditingMessage(null);
        setInput('');
        setShowEmoji(false);
        return;
      }

      // ── Reply branch ─────────────────────────────────────────────
      if (replyingTo) {
        const fsDbReply = db as ReturnType<typeof firestore>;
        await fsDbReply.collection('chats').doc(chatId).collection('messages').add({
          senderId: userId,
          text: trimmed,
          type: 'text',
          timestamp: firestore.FieldValue.serverTimestamp(),
          readBy: [userId],
          deliveredTo: [],
          blockedMessage: isBlocked,
          replyTo: {
            messageId: replyingTo.messageId,
            senderId: replyingTo.senderId,
            text: replyingTo.text,
            type: replyingTo.type,
          },
        });

        await fsDbReply.collection('chats').doc(chatId).update({
          'lastMessage.text': trimmed,
          'lastMessage.senderId': userId,
          'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
        });

        setReplyingTo(null);
        setInput('');
        setShowEmoji(false);
        await checkAndTriggerAutoResponder();
      } else {
        if (isBlocked) {
          const fsDbBlocked = db as ReturnType<typeof firestore>;
          await fsDbBlocked.collection('chats').doc(chatId).collection('messages').add({
            senderId: userId,
            text: trimmed,
            type: 'text',
            timestamp: firestore.FieldValue.serverTimestamp(),
            readBy: [userId],
            deliveredTo: [],
            blockedMessage: true,
          });

          await fsDbBlocked.collection('chats').doc(chatId).update({
            'lastMessage.text': trimmed,
            'lastMessage.senderId': userId,
            'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
          });

          setInput('');
          setShowEmoji(false);
        } else {
          const success = await sendMessage(trimmed);
          if (success) {
            setInput('');
            setShowEmoji(false);
            await checkAndTriggerAutoResponder();
          }
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
  const handleLongPressMessage = (messageId: string) => {
    setSelectedMessageId(messageId);
    setShowMessageActions(true);
    setShowEmoji(false); // Close emoji panel if open
  };

  const handleClearSelection = () => {
    setSelectedMessageId(null);
    setShowMessageActions(false);
  };

  // ── Emoji button ────────────────────────────────────────────────
  // Toggles the custom emoji grid. Opening it dismisses the OS keyboard first
  // so the grid takes over that space cleanly (they can't both be shown).
  // Tapping again (keypad icon) re-focuses the input to bring the keyboard back.
  const toggleEmoji = useCallback(() => {
    setShowAttach(false);
    setShowEmoji((open) => {
      const next = !open;
      if (next) {
        Keyboard.dismiss();
      } else {
        // Closing the grid → bring the text keyboard back
        setTimeout(() => messageInputRef.current?.focus(), 50);
      }
      return next;
    });
  }, []);

  const handleEditMessage = () => {
    if (!selectedMessageId) return;
    const message = messages.find(m => m.messageId === selectedMessageId);
    // Only own text messages can be edited
    if (message && message.senderId === userId && message.type === 'text') {
      setEditingMessage(message);
      setInput(message.text ?? '');
      setShowEmoji(false);
      handleClearSelection();
    } else {
      Alert.alert('Cannot edit', 'You can only edit your own text messages.');
      handleClearSelection();
    }
  };

  const handleDeleteMessage = async () => {
    if (!selectedMessageId) return;

    Alert.alert(
      'Delete Message',
      'Are you sure you want to delete this message?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              // Delete from Firestore
              const fsDbDel = db as ReturnType<typeof firestore>;
              await fsDbDel.collection('chats').doc(chatId).collection('messages').doc(selectedMessageId).delete();
              console.log('[ChatScreen] Message deleted successfully');
              handleClearSelection();
            } catch (error) {
              console.error('[ChatScreen] Error deleting message:', error);
              Alert.alert('Error', 'Failed to delete message.');
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
    if (!selectedMessageId) return;
    const message = messages.find(m => m.messageId === selectedMessageId);
    if (message) {
      setMessageToForward(message);
      setForwardModalVisible(true);
      handleClearSelection();
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

  // ── Forward to selected chats handler ───────────────────────────
  const handleForwardToChats = async (selectedChatIds: string[]) => {
    if (!messageToForward || !userId) return;

    try {
      console.log('[ChatScreen] Forwarding message to', selectedChatIds.length, 'chats');

      // Forward to each selected chat
      for (const targetChatId of selectedChatIds) {
        const messageData: any = {
          senderId: userId,
          type: messageToForward.type,
          timestamp: firestore.FieldValue.serverTimestamp(),
          readBy: [userId],
        };

        // Copy relevant fields based on message type
        if (messageToForward.type === 'text' && messageToForward.text) {
          messageData.text = messageToForward.text;
        } else if (messageToForward.type === 'image' && messageToForward.imageUrl) {
          messageData.imageUrl = messageToForward.imageUrl;
          messageData.text = messageToForward.text || null;
        } else if (messageToForward.type === 'voice' && messageToForward.voiceUrl) {
          messageData.voiceUrl = messageToForward.voiceUrl;
          messageData.duration = messageToForward.duration;
        } else if (messageToForward.type === 'file' && messageToForward.fileUrl) {
          messageData.fileUrl = messageToForward.fileUrl;
          messageData.fileName = messageToForward.fileName;
          messageData.fileSize = messageToForward.fileSize;
          messageData.mimeType = messageToForward.mimeType;
        }

        // Add message to target chat
        const fsDbFwd = db as ReturnType<typeof firestore>;
        await fsDbFwd.collection('chats').doc(targetChatId).collection('messages').add(messageData);

        // Update target chat's lastMessage
        const lastMessageText =
          messageToForward.type === 'text'
            ? messageToForward.text
            : messageToForward.type === 'voice'
              ? '🎤 Voice message'
              : messageToForward.type === 'image'
                ? '📷 Image'
                : messageToForward.type === 'file'
                  ? `📎 ${messageToForward.fileName || 'File'}`
                  : messageToForward.type === 'location'
                    ? '📍 Location'
                    : 'Message';

        await fsDbFwd.collection('chats').doc(targetChatId).update({
          'lastMessage.text': lastMessageText,
          'lastMessage.senderId': userId,
          'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
        });
      }

      console.log('[ChatScreen] Message forwarded successfully');
      Alert.alert(
        'Message Forwarded',
        `Message forwarded to ${selectedChatIds.length} ${selectedChatIds.length === 1 ? 'chat' : 'chats'}`
      );

      setMessageToForward(null);
      setForwardModalVisible(false);
    } catch (error) {
      console.error('[ChatScreen] Error forwarding message:', error);
      Alert.alert('Error', 'Failed to forward message. Please try again.');
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
    // Cannot call someone who has blocked us
    if (blockedByThem) {
      Alert.alert("Can't call", `You cannot call ${displayName} right now.`);
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
  }, [userId, otherUserId, isGroup, blockedByThem, displayName, user, outgoingCall, navigation, otherUserPhoto]);

  const handleVoiceCall = useCallback(() => startCall(), [startCall]);

  // ── PanResponder for mic button ─────────────────────────────────
  const micPanResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,

    onPanResponderGrant: (_evt: GestureResponderEvent, _gestureState: PanResponderGestureState) => {
      isCancelledRef.current = false;
      // Dismiss any previous voice upload error so the banner doesn't persist
      setUploadError(null);
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
    try {
      console.log('[ChatScreen] Attempting to compress image:', uri);

      // Dynamic import to avoid crash if module not available
      const { manipulateAsync, SaveFormat } = await import('expo-image-manipulator');

      const compressed = await manipulateAsync(
        uri,
        [{ resize: { width: 1200 } }], // Resize to max 1200px width, maintain aspect ratio
        { compress: 0.8, format: SaveFormat.JPEG }
      );

      console.log('[ChatScreen] Compressed successfully');
      return compressed.uri;
    } catch (error) {
      console.warn('[ChatScreen] Compression not available or failed, using original:', error);
      return uri; // Fallback to original if compression fails or module unavailable
    }
  };

  // ── Upload single image helper ─────────────────────────────────
  const uploadSingleImage = async (uri: string) => {
    if (!userId) return;

    try {
      console.log('[ChatScreen] Uploading image:', uri);

      // Compress before upload
      const compressedUri = await compressImage(uri);

      const uploadResult = await sendImageMessage(
        chatId,
        userId,
        compressedUri,
        (progress) => {
          setImageUploadProgress(progress);
          console.log('[ChatScreen] Image upload progress:', progress);
        }
      );

      if (!uploadResult.success) {
        Alert.alert('Upload Failed', 'Could not send the image. Please try again.');
      } else {
        await checkAndTriggerAutoResponder();
      }
    } catch (error) {
      console.error('[ChatScreen] Upload error:', error);
      Alert.alert('Error', 'Failed to upload image.');
    }
  };

  // ── Camera / gallery / documents ────────────────────────────────
  const openCamera = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Camera', 'Camera is not available on web.');
      return;
    }

    // Check if permission is already granted
    if (cameraPermission?.granted) {
      setCameraOpen(true);
      return;
    }

    // Request permission
    const { granted } = await requestCameraPermission();
    if (granted) {
      setCameraOpen(true);
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

      setUploadingImage(true);
      setImageUploadProgress(0);

      await uploadSingleImage(photo.uri);

      setUploadingImage(false);
      setImageUploadProgress(0);
      console.log('[ChatScreen] Picture uploaded successfully');
    } catch (error) {
      console.error('[ChatScreen] Camera error:', error);
      Alert.alert('Error', 'Failed to take or upload picture.');
      setUploadingImage(false);
      setImageUploadProgress(0);
    }
  };

  const openGallery = async () => {
    try {
      // Request media library permission first
      const { granted } = mediaLibraryPermission ?? await requestMediaLibraryPermission();
      if (!granted) {
        Alert.alert('Permission needed', 'Allow photo access to select images from your gallery.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsMultipleSelection: true, // Enable multiple selection
        quality: 0.85,
      });

      if (!result.canceled && result.assets.length > 0 && userId) {
        setShowAttach(false);
        setUploadingImage(true);
        setImageUploadProgress(0);

        // Upload images sequentially
        for (let i = 0; i < result.assets.length; i++) {
          const imageUri = result.assets[i].uri;
          console.log(`[ChatScreen] Uploading image ${i + 1}/${result.assets.length}`);

          try {
            // Reset progress for each image
            setImageUploadProgress(0);

            const compressedUri = await compressImage(imageUri);

            const uploadResult = await sendImageMessage(
              chatId,
              userId,
              compressedUri,
              (progress) => {
                setImageUploadProgress(progress);
                console.log(`[ChatScreen] Image ${i + 1} upload progress:`, progress);
              }
            );

            if (!uploadResult.success) {
              console.error(`[ChatScreen] Image ${i + 1} upload failed`);
              Alert.alert('Upload Failed', `Image ${i + 1} could not be sent. Continuing with others...`);
            } else {
              console.log(`[ChatScreen] Image ${i + 1} uploaded successfully`);
            }
          } catch (error) {
            console.error(`[ChatScreen] Image ${i + 1} upload error:`, error);
            Alert.alert('Error', `Failed to upload image ${i + 1}. Continuing with others...`);
          }
        }

        console.log('[ChatScreen] All images processed');
        setUploadingImage(false);
        setImageUploadProgress(0);
        await checkAndTriggerAutoResponder();
      }
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

            const uploadResult = await sendFileMessage(
              chatId,
              userId,
              file.uri,
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
          const uploadResult = await sendFileMessage(
            chatId,
            userId,
            audioFile.uri,
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


  // ── Clear chat handler ──────────────────────────────────────────
  const handleClearChat = useCallback(async () => {
    if (!chatId) {
      console.error('[ChatScreen] No chatId available');
      return;
    }

    try {
      console.log('[ChatScreen] Clearing chat:', chatId);
      const fsDbClear = db as ReturnType<typeof firestore>;
      const snapshot = await fsDbClear.collection('chats').doc(chatId).collection('messages').get();

      if (snapshot.empty) {
        await clearLocalMessages(chatId);
        Alert.alert('Chat Cleared', 'Chat has been cleared.');
        return;
      }

      const totalMessages = snapshot.docs.length;
      console.log(`[ChatScreen] Found ${totalMessages} messages to delete`);

      const BATCH_SIZE = 500;
      const batches = [];

      for (let i = 0; i < snapshot.docs.length; i += BATCH_SIZE) {
        const batch = fsDbClear.batch();
        const batchDocs = snapshot.docs.slice(i, i + BATCH_SIZE);
        batchDocs.forEach((docSnapshot) => { batch.delete(docSnapshot.ref); });
        batches.push(batch);
      }

      await Promise.all(batches.map(batch => batch.commit()));

      // Reset the chat's lastMessage so the Chats list no longer shows stale preview text
      await fsDbClear.collection('chats').doc(chatId).update({
        lastMessage: null,
      });

      // Wipe the local cache so the user sees an empty chat immediately.
      await clearLocalMessages(chatId);

      console.log(`[ChatScreen] Successfully cleared ${totalMessages} messages`);
      Alert.alert('Success', 'Chat cleared successfully');
    } catch (error) {
      console.error('[ChatScreen] Error clearing chat:', error);
      Alert.alert('Error', 'Failed to clear chat. Please try again.');
    }
  }, [chatId]);

  // ── Block contact handler ───────────────────────────────────────
  const handleBlockContact = useCallback(async () => {
    if (!userId || !otherUserId || isGroup) {
      console.error('[ChatScreen] Cannot block: missing user info or is group chat');
      return;
    }

    try {
      console.log('[ChatScreen] Blocking contact:', otherUserId);

      // Add the blocked user to the current user's blockedUsers subcollection
      const fsDbBlockC = db as ReturnType<typeof firestore>;
      await fsDbBlockC.collection('users').doc(userId).collection('blockedUsers').doc(otherUserId).set({
        blockedAt: new Date(),
        displayName: displayName,
        photoURL: otherUserPhoto || null,
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
  }, [userId, otherUserId, isGroup, displayName, otherUserPhoto]);

  // ── Unblock contact handler ─────────────────────────────────────
  const handleUnblockContact = useCallback(async () => {
    if (!userId || !otherUserId || isGroup) {
      console.error('[ChatScreen] Cannot unblock: missing user info or is group chat');
      return;
    }

    try {
      console.log('[ChatScreen] Unblocking contact:', otherUserId);

      // Remove the blocked user from the current user's blockedUsers subcollection
      const fsDbUnblock = db as ReturnType<typeof firestore>;
      await fsDbUnblock.collection('users').doc(userId).collection('blockedUsers').doc(otherUserId).delete();

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

      const fsDbLeave = db as ReturnType<typeof firestore>;
      const chatRefLeave = fsDbLeave.collection('chats').doc(chatId);
      const chatSnapLeave = await chatRefLeave.get();

      if (!chatSnapLeave.exists) {
        Alert.alert('Error', 'Group not found.');
        setLeavingGroup(false);
        return;
      }

      const chatDataLeave = chatSnapLeave.data()!;
      const currentMembers = chatDataLeave.members as string[] || [];
      const updatedMembers = currentMembers.filter((id) => id !== userId);

      const userSnap = await fsDbLeave.collection('users').doc(userId).get();
      const userDisplayName = userSnap.exists() ? (userSnap.data()!.displayName || user?.phoneNumber || 'User') : 'User';

      const batch = fsDbLeave.batch();

      const pastMembersEntry = { userId, leftAt: new Date() };
      const currentPastMembers = chatDataLeave.pastMembers || [];
      const updatedPastMembers = [...currentPastMembers, pastMembersEntry];

      batch.update(chatRefLeave, {
        members: updatedMembers,
        pastMembers: updatedPastMembers,
      });

      const msgRef = fsDbLeave.collection('chats').doc(chatId).collection('messages').doc();
      batch.set(msgRef, {
        messageId: msgRef.id,
        senderId: userId,
        text: `${userDisplayName} left the group`,
        type: 'system',
        subtype: 'member-left',
        timestamp: firestore.FieldValue.serverTimestamp(),
        readBy: [userId],
      });

      batch.update(chatRefLeave, {
        'lastMessage.text': `${userDisplayName} left the group`,
        'lastMessage.senderId': userId,
        'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
      });

      await batch.commit();

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

  // ── Check if recording is active ────────────────────────────────
  const isRecording = recorder.state.status === 'recording';

  // ── Render a single message bubble or date separator ────────────
  const renderItem = ({ item }: { item: MessageListItem }) => {
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

    // Handle messages
    return renderMessage({ item: item.data });
  };

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
    const isSelected = selectedMessageId === item.messageId;
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
          ) : item.type === 'image' && item.imageUrl ? (
            <View style={[styles.bubble, styles.bubbleIn, styles.imageBubble]}>
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
              <View style={styles.imageTimeOverlay}>
                <AppText fixedColor style={styles.timeIn}>{formatTime(item.timestamp)}</AppText>
              </View>
            </View>
          ) : (
            <View style={[styles.bubble, styles.bubbleIn]}>
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
                  <View style={[styles.replyBubbleBar, { backgroundColor: COLORS.blue }]} />
                  <View style={{ flex: 1 }}>
                    <AppText style={[styles.replyBubbleSender, { color: COLORS.blue }]}>
                      {item.replyTo.senderId === userId ? 'You' : resolveSenderName(item.replyTo.senderId)}
                    </AppText>
                    <AppText style={[styles.replyBubbleText, { color: COLORS.text, opacity: 0.7 }]} numberOfLines={1}>
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
              {item.text && <AppText fixedColor style={styles.bubbleTextIn}>{item.text}</AppText>}
              <AppText fixedColor style={styles.timeIn}>{formatTime(item.timestamp)}</AppText>
            </View>
          )
        )}
        {isOut && (
          item.type === 'voice' && item.voiceUrl && item.duration ? (
            <VoiceMessageBubble
              messageId={item.messageId}
              voiceUrl={item.voiceUrl}
              durationMs={item.duration}
              isOutgoing={true}
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
              tickIcon={tickIcon}
            />
          ) : item.type === 'file' && item.fileUrl && item.fileName ? (
            <FileMessageBubble
              fileName={item.fileName!}
              fileSize={item.fileSize ?? undefined}
              fileUrl={item.fileUrl!}
              mimeType={item.mimeType ?? undefined}
              isOutgoing={true}
            />
          ) : item.type === 'image' && item.imageUrl ? (
            <View style={[styles.bubble, styles.bubbleOut, styles.imageBubble]}>
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
              <View style={styles.imageTimeOverlay}>
                <AppText style={styles.timeOut}>{formatTime(item.timestamp)}</AppText>
                <AppIcon
                  name={tickIcon.icon}
                  size={13}
                  color={tickIcon.color}
                  fixedColor
                />
              </View>
            </View>
          ) : (
            <View style={[styles.bubble, styles.bubbleOut]}>
              {item.replyTo && (
                <TouchableOpacity
                  style={[styles.replyBubble, { backgroundColor: 'rgba(9,178,238,0.08)' }]}
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
                  <View style={[styles.replyBubbleBar, { backgroundColor: '#ffffff' }]} />
                  <View style={{ flex: 1 }}>
                    <AppText fixedColor style={[styles.replyBubbleSender, { color: '#ffffff' }]}>
                      {item.replyTo.senderId === userId ? 'You' : resolveSenderName(item.replyTo.senderId)}
                    </AppText>
                    <AppText fixedColor style={[styles.replyBubbleText, { color: 'rgba(255,255,255,0.85)' }]} numberOfLines={1}>
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
              {item.text && <AppText fixedColor style={[styles.bubbleTextOut, { fontFamily }]}>{item.text}</AppText>}
              <View style={styles.timeOutRow}>
                <AppText fixedColor style={styles.timeOut}>{formatTime(item.timestamp)}</AppText>
                <AppIcon
                  name={tickIcon.icon}
                  size={13}
                  color="#ffffff"
                  fixedColor
                />
              </View>
            </View>
          )
        )}
      </View>
    );

    return (
      <SwipeableMessage
        onReply={() => setReplyingTo(item)}
        onLongPress={() => handleLongPressMessage(item.messageId)}
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
      </SwipeableMessage>
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
                initials={getInitials(displayName)}
                color={COLORS.blue}
                size={40}
                imageUrl={headerPhoto}
              />
              <View style={styles.contactInfo}>
                <AppText style={[styles.contactName, { color: textColor, fontFamily }]}>{displayName}</AppText>
                <AppText style={[styles.onlineText, { color: isOnline ? COLORS.blue : FG.secondary }]}>
                  {isGroup
                    ? 'Group chat'
                    : presenceText || 'Tap here for info'}
                </AppText>
              </View>
            </TouchableOpacity>

            {/* Catalog button — only for 1-on-1 chats with a seller catalog */}
            {!isGroup && sellerCatalog.length > 0 && (
              <TouchableOpacity
                style={styles.iconBtn}
                onPress={openCatalogSheet}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <AppIcon name="storefront" size={20} color={COLORS.blue} fixedColor />
              </TouchableOpacity>
            )}

            <TouchableOpacity style={styles.iconBtn} onPress={handleVoiceCall} disabled={outgoingCall.isInitiating}>
              <AppIcon name="call" size={20} color={COLORS.blue} fixedColor />
            </TouchableOpacity>

            <TouchableOpacity style={styles.iconBtn} onPress={() => setMenuOpen((v) => !v)}>
              <AppIcon name="ellipsis-vertical" size={20} color={COLORS.blue} fixedColor />
            </TouchableOpacity>
          </View>
          )}{/* end searchOpen ternary */}

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
                onPress={async () => {
                  const newMutedState = !muted;
                  setMuted(newMutedState);
                  await saveMutedState(chatId, newMutedState);
                  setMenuOpen(false);
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
              keyExtractor={(item) => item.type === 'message' ? item.data.messageId : `date-${item.date.getTime()}`}
              renderItem={renderItem}
              contentContainerStyle={styles.messageList}
              showsVerticalScrollIndicator={false}
              ListFooterComponent={
                typingNames.length > 0
                  ? <TypingIndicator names={typingNames} />
                  : null
              }
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
            />
          )}

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
          {showMessageActions && selectedMessageId && (
            <View style={[styles.actionToolbar, { backgroundColor: FG.glassBg, borderTopColor: FG.glassBorder }]}>
              <View style={styles.actionToolbarContent}>
                <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleReplyMessage}>
                  <AppIcon name="arrow-undo-outline" size={22} color={COLORS.blue} />
                  <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Reply</AppText>
                </TouchableOpacity>

                {/* Edit — only shown for own text messages */}
                {messages.find(m => m.messageId === selectedMessageId)?.senderId === userId &&
                 messages.find(m => m.messageId === selectedMessageId)?.type === 'text' && (
                  <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleEditMessage}>
                    <AppIcon name="pencil-outline" size={22} color={COLORS.blue} />
                    <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Edit</AppText>
                  </TouchableOpacity>
                )}

                <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleForwardMessage}>
                  <AppIcon name="arrow-redo-outline" size={22} color={COLORS.blue} />
                  <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Forward</AppText>
                </TouchableOpacity>

                <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleCopyMessage}>
                  <AppIcon name="copy-outline" size={22} color={COLORS.blue} />
                  <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Copy</AppText>
                </TouchableOpacity>

                <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleShowMessageInfo}>
                  <AppIcon name="information-circle-outline" size={22} color={COLORS.blue} />
                  <AppText style={[styles.actionToolbarLabel, { color: textColor }]}>Info</AppText>
                </TouchableOpacity>

                <TouchableOpacity style={styles.actionToolbarBtn} onPress={handleDeleteMessage}>
                  <AppIcon name="trash-outline" size={22} color={COLORS.missed} fixedColor />
                  <AppText style={[styles.actionToolbarLabel, { color: COLORS.missed }]}>Delete</AppText>
                </TouchableOpacity>

                <TouchableOpacity style={styles.actionToolbarClose} onPress={handleClearSelection}>
                  <AppIcon name="close-circle" size={24} color={FG.secondary} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* ── Emoji panel — custom grid shown in place of the OS keyboard ── */}
          {showEmoji && (
            <View style={styles.emojiPanel}>
              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="always"
                contentContainerStyle={styles.emojiGrid}
              >
                {EMOJI_LIST.map((e) => (
                  <TouchableOpacity
                    key={e}
                    style={styles.emojiItem}
                    activeOpacity={0.6}
                    onPress={() => setInput((prev) => prev + e)}
                  >
                    <AppText fixedColor style={styles.emojiChar}>{e}</AppText>
                  </TouchableOpacity>
                ))}
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
                        ref={messageInputRef}
                        style={[styles.inputField, { color: FG.primary, opacity: blockedByThem ? 0.45 : 1 }]}
                        placeholder={blockedByThem ? 'You cannot reply' : 'Message'}
                        placeholderTextColor={FG.faint}
                        value={input}
                        onChangeText={(text) => {
                          setInput(text);
                          setTyping(text.length > 0);
                        }}
                        multiline
                        maxLength={500}
                        editable={!blockedByThem}
                        onFocus={() => { setShowEmoji(false); setShowAttach(false); }}
                      />
                      <TouchableOpacity style={styles.emojiBtn} onPress={toggleEmoji}>
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
                  <TouchableOpacity onPress={() => handleSend()} activeOpacity={0.85} style={[styles.sendBtn, (isSending || blockedByThem) && { opacity: 0.5 }]} disabled={isSending || blockedByThem}>
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
                    ref={messageInputRef}
                    style={[styles.inputField, { color: FG.primary, opacity: blockedByThem ? 0.45 : 1 }]}
                    placeholder={blockedByThem ? 'You cannot reply' : 'Message'}
                    placeholderTextColor={FG.faint}
                    value={input}
                    onChangeText={(text) => {
                      setInput(text);
                      setTyping(text.length > 0);
                    }}
                    multiline
                    maxLength={500}
                    editable={!blockedByThem}
                    onFocus={() => { setShowEmoji(false); setShowAttach(false); }}
                  />
                  <TouchableOpacity style={styles.emojiBtn} onPress={toggleEmoji}>
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
              <TouchableOpacity onPress={() => handleSend()} activeOpacity={0.85} style={[styles.sendBtn, (isSending || blockedByThem) && { opacity: 0.5 }]} disabled={isSending || blockedByThem}>
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

          {/* ── Upload indicator — visible toast while image is uploading ── */}
          {uploadingImage && (
            <View style={styles.uploadToast} pointerEvents="none">
              <ActivityIndicator size="small" color="#fff" />
              <AppText fixedColor style={styles.uploadToastText}>
                {imageUploadProgress > 0 ? `Sending… ${imageUploadProgress}%` : 'Preparing…'}
              </AppText>
            </View>
          )}
          {/* ── Voice upload progress bar ── */}
          {isUploading && (
            <View style={styles.uploadProgressBar}>
              <View style={[styles.uploadProgressFill, { width: `${uploadProgress}%` }]} />
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
              { icon: 'document-outline' as const, label: 'Files',    action: openDocuments },
              { icon: 'camera-outline'   as const, label: 'Camera',   action: () => { setShowAttach(false); openCamera(); } },
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
      <Modal visible={contactPickerOpen} transparent animationType="slide" onRequestClose={() => setContactPickerOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={{ flex: 1 }}
        >
          <TouchableOpacity style={styles.attachOverlay} activeOpacity={1} onPress={() => setContactPickerOpen(false)} />
          <View style={[styles.contactPickerSheet, { backgroundColor: FG.glassBg }]}>
            <AppBg />
            <View style={styles.attachHandle} />
            <AppText style={[styles.attachTitle, { color: textColor, fontFamily }]}>Share Contact</AppText>

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
              ) : !contactsPermission ? (
                <View style={{ alignItems: 'center', paddingTop: 60, gap: 12 }}>
                  <AppIcon name="lock-closed-outline" size={48} color={COLORS.sub} />
                  <AppText style={{ color: textColor, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
                    Contacts Permission Required
                  </AppText>
                  <AppText style={{ color: COLORS.sub, fontSize: 13, textAlign: 'center', paddingHorizontal: 40 }}>
                    Please grant contacts permission in your device settings to share contacts
                  </AppText>
                </View>
              ) : !phoneContacts || phoneContacts.length === 0 ? (
                <View style={{ alignItems: 'center', paddingTop: 60, gap: 12 }}>
                  <AppIcon name="people-outline" size={48} color={COLORS.sub} />
                  <AppText style={{ color: textColor, fontSize: 16, fontWeight: '600', textAlign: 'center' }}>
                    No Contacts Found
                  </AppText>
                  <AppText style={{ color: COLORS.sub, fontSize: 13, textAlign: 'center', paddingHorizontal: 40 }}>
                    None of your contacts are using ChitChat yet
                  </AppText>
                </View>
              ) : (
                <>
                  {phoneContacts
                    .filter(c => !contactQuery.trim() || c.displayName.toLowerCase().includes(contactQuery.toLowerCase()) || c.phone.includes(contactQuery))
                    .map((c) => (
                      <TouchableOpacity
                        key={c.userId || c.phone}
                        style={[styles.contactPickerRow, bevel]}
                        activeOpacity={0.75}
                        onPress={async () => {
                          setContactPickerOpen(false);
                          if (!userId) return;
                          // Send contact as a text message with contact card format
                          const contactText = `📇 *${c.displayName}*\n📞 ${c.phone}`;
                          try {
                            const fsDbContact = db as ReturnType<typeof firestore>;
                            await fsDbContact.collection('chats').doc(chatId).collection('messages').add({
                              senderId: userId,
                              text: contactText,
                              type: 'text',
                              timestamp: firestore.FieldValue.serverTimestamp(),
                              readBy: [userId],
                              deliveredTo: [],
                            });
                            await fsDbContact.collection('chats').doc(chatId).update({
                              'lastMessage.text': `📇 ${c.displayName}`,
                              'lastMessage.senderId': userId,
                              'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
                            });
                          } catch (err) {
                            console.error('[ChatScreen] Failed to send contact:', err);
                          }
                        }}
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
                        </View>
                        <AppIcon name="share-outline" size={18} color={COLORS.blue} fixedColor />
                      </TouchableOpacity>
                    ))}
                  {phoneContacts.filter(c => !contactQuery.trim() || c.displayName.toLowerCase().includes(contactQuery.toLowerCase()) || c.phone.includes(contactQuery)).length === 0 && contactQuery.trim() && (
                    <View style={{ alignItems: 'center', paddingTop: 40, gap: 10 }}>
                      <AppIcon name="search-outline" size={44} color={COLORS.sub} />
                      <AppText style={{ color: COLORS.sub, fontSize: 14 }}>No contacts match "{contactQuery}"</AppText>
                    </View>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── In-app camera ── */}
      {cameraOpen && Platform.OS !== 'web' && (
        <Modal visible animationType="slide" onRequestClose={() => setCameraOpen(false)}>
          <View style={{ flex: 1, backgroundColor: '#000' }}>
            <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
            {/* Controls rendered as a sibling over the camera — not inside CameraView.
                Placing them inside CameraView on some expo-camera versions causes the
                native layer to swallow touches, hiding the shutter button. */}
            <View style={styles.cameraControls} pointerEvents="box-none">
              <TouchableOpacity onPress={() => setCameraOpen(false)} style={styles.cameraCloseBtn}>
                <AppIcon name="close" size={28} color="#fff" fixedColor />
              </TouchableOpacity>
              <TouchableOpacity style={styles.cameraShutterBtn} onPress={takePicture}>
                <View style={styles.cameraShutter} />
              </TouchableOpacity>
              <View style={{ width: 52 }} />
            </View>
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
          onSendOrder={async () => {
            const summary = formatOrderSummary();
            if (!summary || !userId) return;
            setCartSheetVisible(false);
            await sendMessage(summary);
            clearCart();
          }}
        />
      </Modal>

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
                  {!isGroup && (
                    <LinearGradient colors={GRADIENTS.primary} style={profileHeroStyles.verifiedBadge}>
                      <AppIcon name="checkmark" size={10} color="#fff" fixedColor />
                    </LinearGradient>
                  )}
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
                    { icon: 'share-social-outline' as const, label: 'Share',  onPress: () => {
                      Share.share({
                        message: `Chat with ${displayName} on ChitChat Business`,
                        title: displayName,
                      }).catch(() => {});
                    }},
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

              {/* ── Business info rows ── */}
              {!isGroup && (
                <View style={profileHeroStyles.infoSection}>
                  {/* Presence / hours */}
                  <View style={profileHeroStyles.infoRow}>
                    <AppIcon name="time-outline" size={18} color={COLORS.blue} fixedColor />
                    <AppText style={[profileHeroStyles.infoText, { color: textColor }]}>
                      {isOnline ? 'Open now' : 'Closed now'}
                    </AppText>
                  </View>
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
              </View>

            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Forward Modal ── */}
      {userId && (
        <ForwardModal
          visible={forwardModalVisible}
          onClose={() => {
            setForwardModalVisible(false);
            setMessageToForward(null);
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
    borderColor: 'rgba(9,178,238,0.20)',
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
    borderColor: 'rgba(9,178,238,0.10)',
    ...SHADOW.card,
  },
  hCardImg:            { width: H_CARD_W, height: 110 },
  hCardImgPlaceholder: { width: H_CARD_W, height: 100, backgroundColor: 'rgba(9,178,238,0.06)', alignItems: 'center', justifyContent: 'center' },
  hCardInfo: { paddingHorizontal: 8, paddingTop: 8, paddingBottom: 4, gap: 2 },
  hCardName:  { fontSize: 12, fontWeight: '700', lineHeight: 16 },
  hCardPrice: { fontSize: 13, fontWeight: '800', color: COLORS.blue },
  hCardAddBtn: { marginHorizontal: 8, marginBottom: 8, borderRadius: RADIUS.full, overflow: 'hidden' },
  hCardAddBtnGrad: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, paddingVertical: 7, borderRadius: RADIUS.full },
  hCardStepper: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, marginHorizontal: 8, marginBottom: 8,
    backgroundColor: 'rgba(9,178,238,0.08)', borderRadius: RADIUS.full, paddingVertical: 6,
  },
  hCardStepBtn: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(9,178,238,0.15)', alignItems: 'center', justifyContent: 'center' },
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
    backgroundColor: 'rgba(9,178,238,0.10)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(9,178,238,0.18)',
  },
  actionLabel: { fontSize: 12, fontWeight: '600' },

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
    borderColor: 'rgba(9,178,238,0.10)',
  },
  img: { width: CARD_W, height: CARD_W * 0.75, },
  imgPlaceholder: {
    width: CARD_W, height: CARD_W * 0.65,
    backgroundColor: 'rgba(9,178,238,0.06)',
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
    borderTopWidth: 1, borderTopColor: 'rgba(9,178,238,0.07)',
  },
  addBtn: { borderRadius: RADIUS.full, overflow: 'hidden' },
  addBtnGrad: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 5, paddingVertical: 8, borderRadius: RADIUS.full,
  },
  addBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  stepper: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, backgroundColor: 'rgba(9,178,238,0.08)',
    borderRadius: RADIUS.full, paddingVertical: 6,
  },
  stepBtn: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(9,178,238,0.14)',
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
    backgroundColor: 'rgba(9,178,238,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  rowInfo:  { flex: 1 },
  rowName:  { fontSize: 13, fontWeight: '600', color: COLORS.text },
  rowPrice: { fontSize: 13, fontWeight: '700', color: COLORS.blue, marginTop: 2 },

  stepper: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(9,178,238,0.08)',
    borderRadius: RADIUS.full, paddingHorizontal: 6, paddingVertical: 4,
  },
  stepBtn: {
    width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(9,178,238,0.12)',
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

  bubble: {
    maxWidth: '78%',
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingTop: 7,
    paddingBottom: 7,
    position: 'relative',
  },
  bubbleIn: {
    borderBottomLeftRadius: 4,
    backgroundColor: '#F0F1F3',   // neutral light grey — received message
    ...SHADOW.card,
  },
  bubbleTextIn: {
    fontSize: 15,
    color: COLORS.text,
    lineHeight: 20,
    paddingRight: 52, // reserve room for the time stamp on the last line
  },
  timeIn: {
    position: 'absolute',
    bottom: 6,
    right: 12,
    fontSize: 11,
    color: COLORS.sub,
  },

  bubbleOut: {
    backgroundColor: COLORS.blue,   // solid brand cyan — your sent messages
    borderBottomRightRadius: 4,
    position: 'relative',
    ...SHADOW.card
  },
  bubbleTextOut: {
    fontSize: 15,
    color: '#ffffff',
    lineHeight: 20,
    paddingRight: 60, // reserve room for time + double tick on the last line
  },
  timeOutRow: {
    position: 'absolute',
    bottom: 6,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  timeOut: { fontSize: 11, color: 'rgba(255,255,255,0.8)' },

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
    backgroundColor: 'rgba(9,178,238,0.06)',
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.18)',
    paddingHorizontal: 14,
    minHeight: 42,
    maxHeight: 120,     // grows for multi-line, caps so it doesn't fill the screen
    paddingVertical: 4,
  },
  // No fixed height — let the text size naturally so it's vertically centered
  // by the wrapper's alignItems:'center'. A fixed height top-anchors multiline text on iOS.
  inputField: {
    flex: 1,
    fontSize: 15,
    color: COLORS.text,
    padding: 0,
    margin: 0,
    paddingTop: Platform.OS === 'ios' ? 2 : 0,
  },
  emojiBtn: { paddingLeft: 8, alignSelf: 'center' },
  sendBtn: { width: 42, height: 42, borderRadius: 21, ...SHADOW.button },
  sendBtnInner: { flex: 1, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },

  // Emoji panel
  emojiPanel: {
    height: 240,                     // fixed keyboard-sized block so it's always visible
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
    backgroundColor: '#F7F8FA',      // solid light surface so emojis read clearly
    borderTopColor: 'rgba(0,0,0,0.08)',
  },
  emojiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    paddingHorizontal: 10,
    gap: 4,
  },
  emojiItem: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  emojiChar: { fontSize: 30 },

  // Attachment sheet
  attachOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.30)' },
  attachSheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingBottom: Platform.OS === 'ios' ? 50 : 40,
    paddingHorizontal: 20, paddingTop: 12,
    ...SHADOW.glow,
  },
  attachHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(9,178,238,0.40)', alignSelf: 'center', marginBottom: 14 },
  attachTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text, marginBottom: 16 },
  attachGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  attachItem: {
    width: 90, paddingVertical: 14, alignItems: 'center', gap: 8,
    borderRadius: RADIUS.lg,
  },
  attachIconWrap: { width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(9,178,238,0.10)', alignItems: 'center', justifyContent: 'center' },
  attachLabel: { fontSize: 11, fontWeight: '600', color: COLORS.sub, textAlign: 'center' },

  // Camera UI
  cameraControls: {
    ...StyleSheet.absoluteFill,
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-end',
    paddingBottom: 56,
    zIndex: 10,        // sit above the native CameraView layer
    elevation: 10,     // Android equivalent
  },
  cameraCloseBtn: { width: 52, height: 52, borderRadius: 26, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
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
    backgroundColor: 'rgba(9,178,238,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.18)',
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
    backgroundColor: 'rgba(9,178,238,0.08)',
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
  uploadToast: {
    position: 'absolute',
    bottom: 80,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.72)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: RADIUS.full,
    zIndex: 20,
  },
  uploadToastText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
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
    backgroundColor: 'rgba(9,178,238,0.30)',
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
    backgroundColor: 'rgba(9,178,238,0.18)',
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
    backgroundColor: 'rgba(9,178,238,0.08)',
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.20)',
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
    backgroundColor: 'rgba(9,178,238,0.12)',
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
    backgroundColor: 'rgba(9,178,238,0.12)',
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
    maxHeight: '85%',
    ...SHADOW.glow,
  },
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