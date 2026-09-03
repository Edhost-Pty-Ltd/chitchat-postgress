// ─── Screen: Chat ────────────────────────────────────────────────────────────
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View, FlatList, TouchableOpacity, ScrollView,
  StyleSheet, TextInput, KeyboardAvoidingView, Platform,
  ActivityIndicator, PanResponder, Linking, Modal, Alert,
  GestureResponderEvent, PanResponderGestureState, Image, Dimensions,
  Animated,
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
            
            if (userSnap.exists) {
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
            
            if (userSnap.exists) {
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
        
        // Check if the current user has blocked the other user
        const fsDbBlock = db as ReturnType<typeof firestore>;
        const blockedByMeSnap = await fsDbBlock
          .collection('users').doc(userId!).collection('blockedUsers').doc(otherUserId!).get();
        const blockedMeSnap = await fsDbBlock
          .collection('users').doc(otherUserId!).collection('blockedUsers').doc(userId!).get();
        
        const iBlockedThem = blockedByMeSnap.exists;
        const theyBlockedMe = blockedMeSnap.exists;
        
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
            const fsDbFocus = db as ReturnType<typeof firestore>;
            const blockedByMeSnapF = await fsDbFocus
              .collection('users').doc(userId).collection('blockedUsers').doc(otherUserId).get();
            const blockedMeSnapF = await fsDbFocus
              .collection('users').doc(otherUserId).collection('blockedUsers').doc(userId).get();
            
            const iBlockedThem = blockedByMeSnapF.exists;
            const theyBlockedMe = blockedMeSnapF.exists;
            
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
    } catch (error: any) {
      console.error('[ChatScreen] Voice upload failed:', error);
      setIsUploading(false);

      const isNetworkError = error.message === 'UPLOAD_TIMEOUT' ||
        error.code === 'storage/retry-limit-exceeded' ||
        error.code === 'storage/canceled';

      if (isNetworkError && retryCount < MAX_UPLOAD_RETRIES - 1) {
        setUploadError('Upload failed. Tap to retry.');
      } else {
        setUploadError('Upload could not be completed.');
        pendingRecordingRef.current = null;
      }
    }
  }, [userId, chatId, retryCount]);

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
    const trimmed = (text ?? input).trim();
    if (!trimmed) return;

    // Stop typing indicator immediately on send
    setTyping(false);

    try {
      // If replying to a message, include reply metadata
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

        // Update chat's lastMessage
        await fsDbReply.collection('chats').doc(chatId).update({
          'lastMessage.text': trimmed,
          'lastMessage.senderId': userId,
          'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
        });

        setReplyingTo(null);
        setInput('');
        setShowEmoji(false);
      } else {
        // Regular message without reply
        // If either party has blocked the other, send message but mark it as blocked
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

          // Update chat's lastMessage
          await fsDbBlocked.collection('chats').doc(chatId).update({
            'lastMessage.text': trimmed,
            'lastMessage.senderId': userId,
            'lastMessage.timestamp': firestore.FieldValue.serverTimestamp(),
          });

          setInput('');
          setShowEmoji(false);
        } else {
          // Normal send
          const success = await sendMessage(trimmed);
          if (success) {
            setInput('');
            setShowEmoji(false);
          }
        }
      }
    } catch (error) {
      console.error('[ChatScreen] Error sending message:', error);
      Alert.alert('Error', 'Failed to send message');
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
        const chatRef = doc(db, 'chats', targetChatId);
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
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
      const userDisplayName = userSnap.exists ? (userSnap.data()!.displayName || user?.phoneNumber || 'User') : 'User';
      
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
            <LinearGradient colors={GRADIENTS.chatSent} style={[styles.bubble, styles.bubbleIn, styles.imageBubble]}>
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
              {item.text && <AppText fixedColor style={styles.bubbleTextIn}>{item.text}</AppText>}
              <AppText fixedColor style={styles.timeIn}>{formatTime(item.timestamp)}</AppText>
            </LinearGradient>
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
              {item.text && <AppText style={[styles.bubbleTextOut, { color: textColor, fontFamily }]}>{item.text}</AppText>}
              <View style={styles.timeOutRow}>
                <AppText style={styles.timeOut}>{formatTime(item.timestamp)}</AppText>
                <AppIcon
                  name={tickIcon.icon}
                  size={13}
                  color={tickIcon.color}
                  fixedColor
                />
              </View>
            </View>
          )
        )}
      </View>
    );

    return (
      <TouchableOpacity
        activeOpacity={1}
        onLongPress={() => handleLongPressMessage(item.messageId)}
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

          {/* ── Reply Preview ── */}
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
                  <TouchableOpacity onPress={() => handleSend()} activeOpacity={0.85} style={styles.sendBtn}>
                    <LinearGradient colors={GRADIENTS.primary} style={styles.sendBtnInner}>
                      <AppIcon name="send" size={19} color="#fff" fixedColor />
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
              <TouchableOpacity onPress={() => handleSend()} activeOpacity={0.85} style={styles.sendBtn}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.sendBtnInner}>
                  <AppIcon name="send" size={19} color="#fff" fixedColor />
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
            <CameraView ref={cameraRef} style={{ flex: 1 }} facing="back">
              <View style={styles.cameraControls}>
                <TouchableOpacity onPress={() => setCameraOpen(false)} style={styles.cameraCloseBtn}>
                  <AppIcon name="close" size={28} color="#fff" fixedColor />
                </TouchableOpacity>
                <TouchableOpacity style={styles.cameraShutterBtn} onPress={takePicture}>
                  <View style={styles.cameraShutter} />
                </TouchableOpacity>
                <View style={{ width: 52 }} />
              </View>
            </CameraView>
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

      {/* ── Profile Modal ── */}
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
            {/* Handle */}
            <View style={styles.profileHandle} />

            {/* Close button */}
            <TouchableOpacity 
              style={styles.profileCloseBtn} 
              onPress={() => setProfileModalOpen(false)}
            >
              <AppIcon name="close" size={20} color={FG.secondary} />
            </TouchableOpacity>

            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.profileScroll}>
              {/* Avatar + name */}
              <View style={styles.profileAvatarWrap}>
                  <Avatar 
                    initials={getInitials(displayName)} 
                    color={COLORS.blue} 
                    size={80}
                    imageUrl={headerPhoto}
                  />
                </View>
                <AppText style={[styles.profileName, { color: textColor, fontFamily }]}>
                  {displayName}
                </AppText>
                <AppText style={[styles.profileStatus, { color: isOnline ? COLORS.blue : FG.secondary }]}>
                  {isGroup ? `Group · ${messages.length} messages` : (presenceText || 'Tap here for info')}
                </AppText>

                {/* Action buttons */}
                <View style={styles.profileActions}>
                  {[
                    { icon: 'call-outline' as const, label: 'Audio Call', onPress: () => { setProfileModalOpen(false); handleVoiceCall(); } },
                  ].map((a) => (
                    <TouchableOpacity 
                      key={a.label} 
                      style={[styles.profileActionBtn, bevel]} 
                      onPress={a.onPress} 
                      activeOpacity={0.8}
                      disabled={isGroup}
                    >
                      <LinearGradient colors={GRADIENTS.primary} style={styles.profileActionIcon}>
                        <AppIcon name={a.icon} size={20} color="#fff" fixedColor />
                      </LinearGradient>
                      <AppText style={[styles.profileActionLabel, { color: textColor }]}>
                        {a.label}
                      </AppText>
                    </TouchableOpacity>
                  ))}
                </View>

                {/* Group Participants - Only show for group chats */}
                {isGroup && (
                  <>
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
                    ) : groupMembers.length > 0 ? (
                      groupMembers.map((member) => {
                        const statusEmoji = 
                          member.status === 'online' ? '🟢' : 
                          member.status === 'away' ? '🟡' : '⚫';
                        const statusText = 
                          member.status === 'online' ? 'Online' : 
                          member.status === 'away' ? 'Away' : 'Offline';
                        
                        return (
                          <View 
                            key={member.userId} 
                            style={[styles.profileMemberRow, bevel]}
                          >
                            <Avatar 
                              initials={getInitials(member.displayName)} 
                              color={COLORS.blue} 
                              size={42}
                              imageUrl={member.photoURL}
                              status={member.status}
                            />
                            <View style={{ flex: 1 }}>
                              <AppText style={[styles.profileMemberName, { color: textColor, fontFamily }]}>
                                {member.displayName}
                                {member.userId === userId && <AppText style={[styles.profileMemberYou, { color: FG.secondary }]}> (You)</AppText>}
                              </AppText>
                              <AppText style={[styles.profileMemberStatus, { color: FG.secondary }]}>
                                {statusEmoji} {statusText}
                              </AppText>
                            </View>
                          </View>
                        );
                      })
                    ) : (
                      <View style={[styles.profileMemberEmptyBox, bevel]}>
                        <AppIcon name="people-outline" size={28} color={FG.secondary} />
                        <AppText style={[styles.profileMemberEmptyText, { color: FG.secondary }]}>
                          No participants found
                        </AppText>
                      </View>
                    )}
                  </>
                )}

                {/* Past Members - Only show for group chats if there are any */}
                {isGroup && (
                  <>
                    <AppText style={[styles.profileSectionLabel, { color: FG.secondary }]}>
                      PAST MEMBERS {pastMembers.length > 0 ? `(${pastMembers.length})` : ''}
                    </AppText>
                    {loadingPastMembers ? (
                      <View style={[styles.profileMemberLoadingBox, bevel]}>
                        <ActivityIndicator size="small" color={COLORS.blue} />
                        <AppText style={[styles.profileMemberLoadingText, { color: FG.secondary }]}>
                          Loading past members...
                        </AppText>
                      </View>
                    ) : pastMembers.length > 0 ? (
                      pastMembers.map((member) => {
                        const leftDateText = formatLeftDate(member.leftAt);
                        
                        return (
                          <View 
                            key={member.userId} 
                            style={[styles.profilePastMemberRow, bevel]}
                          >
                            <Avatar 
                              initials={getInitials(member.displayName)} 
                              color={COLORS.blue} 
                              size={42}
                              imageUrl={member.photoURL}
                              status="offline"
                            />
                            <View style={{ flex: 1 }}>
                              <AppText style={[styles.profileMemberName, styles.profilePastMemberName, { color: textColor, fontFamily }]}>
                                {member.displayName}
                              </AppText>
                              <AppText style={[styles.profileMemberStatus, { color: FG.secondary }]}>
                                {leftDateText}
                              </AppText>
                            </View>
                            <AppIcon name="exit-outline" size={18} color={FG.secondary} />
                          </View>
                        );
                      })
                    ) : (
                      <View style={[styles.profileMemberEmptyBox, bevel]}>
                        <AppIcon name="people-outline" size={28} color={FG.secondary} />
                        <AppText style={[styles.profileMemberEmptyText, { color: FG.secondary }]}>
                          No past members
                        </AppText>
                      </View>
                    )}
                  </>
                )}

                {/* Shared media */}
                <AppText style={[styles.profileSectionLabel, { color: FG.secondary }]}>
                  SHARED MEDIA
                </AppText>
                {messages.filter(m => m.type === 'image').length > 0 ? (
                  <TouchableOpacity 
                    style={[styles.profileMediaRow, bevel]}
                    activeOpacity={0.8}
                  >
                    <AppText style={[styles.profileMediaLabel, { color: textColor }]}>
                      Shared media
                    </AppText>
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
                    <AppText style={[styles.infoMediaEmpty, { color: FG.secondary }]}>
                      No media shared yet
                    </AppText>
                  </View>
                )}

                {/* Privacy section for group chats - Leave Group */}
                {isGroup && (
                  <>
                    <AppText style={[styles.profileSectionLabel, { color: FG.secondary }]}>
                      PRIVACY
                    </AppText>

                    {/* Leave Group Button */}
                    {!showLeaveGroupConfirmation ? (
                      <TouchableOpacity 
                        style={[styles.profileBlockBtn, bevel]}
                        onPress={() => setShowLeaveGroupConfirmation(true)}
                        activeOpacity={0.8}
                        disabled={leavingGroup}
                      >
                        <AppIcon name="exit-outline" size={20} color={COLORS.missed} fixedColor />
                        <AppText style={[styles.profileBlockText, { color: COLORS.missed }]}>
                          Leave Group
                        </AppText>
                      </TouchableOpacity>
                    ) : (
                      /* Inline Confirmation Card */
                      <View style={[styles.confirmationCard, bevel]}>
                        {/* Gradient Icon */}
                        <LinearGradient 
                          colors={['rgba(255,59,48,0.20)', 'rgba(255,149,0,0.20)']}
                          style={styles.confirmationIconWrap}
                        >
                          <AppIcon name="exit-outline" size={28} color={COLORS.missed} fixedColor />
                        </LinearGradient>

                        {/* Title */}
                        <AppText style={[styles.confirmationTitle, { color: textColor, fontFamily }]}>
                          Leave Group?
                        </AppText>

                        {/* Body text */}
                        <AppText style={[styles.confirmationBody, { color: FG.secondary }]}>
                          You will no longer receive messages from this group. A notification will be sent to all members that you left.
                        </AppText>

                        {/* Action buttons */}
                        <View style={styles.confirmationButtons}>
                          <TouchableOpacity 
                            style={[styles.confirmationCancelBtn, { borderColor: FG.glassBorder }]}
                            onPress={() => setShowLeaveGroupConfirmation(false)}
                            activeOpacity={0.8}
                            disabled={leavingGroup}
                          >
                            <AppText style={[styles.confirmationCancelText, { color: textColor }]}>
                              Cancel
                            </AppText>
                          </TouchableOpacity>

                          <TouchableOpacity 
                            style={[styles.confirmationBlockBtn, { backgroundColor: COLORS.missed }]}
                            onPress={handleLeaveGroup}
                            activeOpacity={0.8}
                            disabled={leavingGroup}
                          >
                            {leavingGroup ? (
                              <ActivityIndicator size="small" color="#fff" />
                            ) : (
                              <AppText style={[styles.confirmationBlockText, { color: '#fff' }]}>
                                Leave Group
                              </AppText>
                            )}
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </>
                )}

                {/* Privacy section - Only show for individual chats */}
                {!isGroup && (
                  <>
                    <AppText style={[styles.profileSectionLabel, { color: FG.secondary }]}>
                      PRIVACY
                    </AppText>

                    {/* Block/Unblock Contact Button */}
                    {isBlocked && blockedByMe ? (
                      /* Unblock User Button */
                      <TouchableOpacity 
                        style={[styles.profileBlockBtn, bevel]}
                        onPress={handleUnblockContact}
                        activeOpacity={0.8}
                      >
                        <AppIcon name="checkmark-circle-outline" size={20} color={COLORS.blue} fixedColor />
                        <AppText style={[styles.profileBlockText, { color: COLORS.blue }]}>
                          Unblock User
                        </AppText>
                      </TouchableOpacity>
                    ) : !showBlockConfirmation ? (
                      /* Block Contact Button */
                      <TouchableOpacity 
                        style={[styles.profileBlockBtn, bevel]}
                        onPress={() => setShowBlockConfirmation(true)}
                        activeOpacity={0.8}
                      >
                        <AppIcon name="ban-outline" size={20} color={COLORS.missed} fixedColor />
                        <AppText style={[styles.profileBlockText, { color: COLORS.missed }]}>
                          Block {displayName}
                        </AppText>
                      </TouchableOpacity>
                    ) : (
                      /* Inline Confirmation Card */
                      <View style={[styles.confirmationCard, bevel]}>
                        {/* Gradient Icon */}
                        <LinearGradient 
                          colors={['rgba(255,59,48,0.20)', 'rgba(255,149,0,0.20)']}
                          style={styles.confirmationIconWrap}
                        >
                          <AppIcon name="ban-outline" size={28} color={COLORS.missed} fixedColor />
                        </LinearGradient>

                        {/* Title */}
                        <AppText style={[styles.confirmationTitle, { color: textColor, fontFamily }]}>
                          Block {displayName}?
                        </AppText>

                        {/* Body text */}
                        <AppText style={[styles.confirmationBody, { color: FG.secondary }]}>
                          Blocked contacts cannot call you or send you messages. They won't be notified that you blocked them.
                        </AppText>

                        {/* Action buttons */}
                        <View style={styles.confirmationButtons}>
                          <TouchableOpacity 
                            style={[styles.confirmationCancelBtn, { borderColor: FG.glassBorder }]}
                            onPress={() => setShowBlockConfirmation(false)}
                            activeOpacity={0.8}
                          >
                            <AppText style={[styles.confirmationCancelText, { color: textColor }]}>
                              Cancel
                            </AppText>
                          </TouchableOpacity>

                          <TouchableOpacity 
                            style={[styles.confirmationBlockBtn, { backgroundColor: COLORS.missed }]}
                            onPress={handleBlockContact}
                            activeOpacity={0.8}
                          >
                            <AppText style={[styles.confirmationBlockText, { color: '#fff' }]}>
                              Block
                            </AppText>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}
                  </>
                )}
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
  timeOutRow: { 
    position: 'absolute',
    bottom: 4,
    right: 10,
    flexDirection: 'row', 
    alignItems: 'center', 
    gap: 3,
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
    height: 42 
  },
  inputField: { flex: 1, fontSize: 14, color: COLORS.text, padding: 0, margin: 0, height: 42 },
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
});
