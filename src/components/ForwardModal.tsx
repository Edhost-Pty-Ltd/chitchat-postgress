// ─── ForwardModal Component ──────────────────────────────────────────────────
// Modal for selecting contacts/chats to forward a message to

import React, { useState, useEffect } from 'react';
import {
  View,
  Modal,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { Avatar } from './index';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { COLORS, RADIUS, SHADOW } from '../types/theme';

interface Chat {
  chatId: string;
  displayName: string;
  photoURL: string | null;
  isGroup: boolean;
  lastMessageTimestamp: Date | null;
}

interface ForwardModalProps {
  visible: boolean;
  onClose: () => void;
  onForward: (selectedChatIds: string[]) => Promise<void>;
  currentUserId: string;
}

export function ForwardModal({ visible, onClose, onForward, currentUserId }: ForwardModalProps) {
  const { FG } = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { bevel } = useGlass();

  const [chats, setChats] = useState<Chat[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<string[]>([]);
  const [forwarding, setForwarding] = useState(false);

  // Load user's chats
  useEffect(() => {
    if (!visible || !currentUserId) return;

    const loadChats = async () => {
      setLoading(true);
      try {
        console.log('[ForwardModal] Loading chats for user:', currentUserId);

        const fsDb = db as ReturnType<typeof firestore>;
        const snapshot = await fsDb
          .collection('chats')
          .where('members', 'array-contains', currentUserId)
          .orderBy('lastMessage.timestamp', 'desc')
          .limit(50)
          .get();

        const chatsList: Chat[] = [];

        for (const docSnap of snapshot.docs) {
          const data = docSnap.data();
          
          let displayName = 'Unknown';
          let photoURL: string | null = null;
          let isGroup = false;

          if (data.type === 'group' || data.isGroup) {
            displayName = data.groupName || 'Unnamed Group';
            photoURL = data.groupPhoto || null;
            isGroup = true;
          } else {
            const otherUserId = (data.members as string[]).find((id: string) => id !== currentUserId);
            if (otherUserId) {
              try {
                const userDoc = await fsDb.collection('users').doc(otherUserId).get();
                if (userDoc.exists) {
                  const userData = userDoc.data()!;
                  displayName = userData.displayName || userData.phone || 'Unknown';
                  photoURL = userData.photoURL || null;
                }
              } catch (error) {
                console.warn('[ForwardModal] Could not fetch user data:', error);
              }
            }
          }

          chatsList.push({
            chatId: docSnap.id,
            displayName,
            photoURL,
            isGroup,
            lastMessageTimestamp: data.lastMessage?.timestamp?.toDate() || null,
          });
        }

        console.log('[ForwardModal] Loaded', chatsList.length, 'chats');
        setChats(chatsList);
      } catch (error) {
        console.error('[ForwardModal] Error loading chats:', error);
      } finally {
        setLoading(false);
      }
    };

    loadChats();
    setSelectedChatIds([]); // Reset selection when modal opens
  }, [visible, currentUserId]);

  const toggleChatSelection = (chatId: string) => {
    setSelectedChatIds((prev) =>
      prev.includes(chatId)
        ? prev.filter((id) => id !== chatId)
        : [...prev, chatId]
    );
  };

  const handleForward = async () => {
    if (selectedChatIds.length === 0) return;

    setForwarding(true);
    try {
      await onForward(selectedChatIds);
      onClose();
    } catch (error) {
      console.error('[ForwardModal] Forward failed:', error);
    } finally {
      setForwarding(false);
    }
  };

  const getInitials = (name: string): string => {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  };

  const renderChatItem = ({ item }: { item: Chat }) => {
    const isSelected = selectedChatIds.includes(item.chatId);

    return (
      <TouchableOpacity
        style={[styles.chatItem, bevel, isSelected && styles.chatItemSelected]}
        onPress={() => toggleChatSelection(item.chatId)}
        activeOpacity={0.7}
      >
        <Avatar
          initials={getInitials(item.displayName)}
          color={COLORS.blue}
          size={48}
          imageUrl={item.photoURL}
        />
        <View style={styles.chatItemContent}>
          <AppText style={[styles.chatItemName, { color: textColor, fontFamily }]}>
            {item.displayName}
          </AppText>
          <AppText style={[styles.chatItemType, { color: FG.secondary }]}>
            {item.isGroup ? 'Group' : 'Direct'}
          </AppText>
        </View>
        <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
          {isSelected && <AppIcon name="checkmark" size={16} color="#fff" fixedColor />}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <TouchableOpacity
          style={styles.backdrop}
          activeOpacity={1}
          onPress={onClose}
        />
        <View style={[styles.modalContent, { backgroundColor: FG.glassBg }]}>
          <AppBg />
          
          {/* Handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <AppText style={[styles.title, { color: textColor, fontFamily }]}>
              Forward Message
            </AppText>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <AppIcon name="close" size={24} color={FG.secondary} />
            </TouchableOpacity>
          </View>

          {/* Selected count */}
          {selectedChatIds.length > 0 && (
            <View style={styles.selectedBanner}>
              <AppText style={[styles.selectedText, { color: COLORS.blue }]}>
                {selectedChatIds.length} {selectedChatIds.length === 1 ? 'chat' : 'chats'} selected
              </AppText>
            </View>
          )}

          {/* Chat list */}
          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color={COLORS.blue} />
              <AppText style={[styles.loadingText, { color: FG.secondary }]}>
                Loading chats...
              </AppText>
            </View>
          ) : chats.length === 0 ? (
            <View style={styles.emptyContainer}>
              <AppIcon name="chatbubbles-outline" size={48} color={FG.secondary} />
              <AppText style={[styles.emptyText, { color: FG.secondary }]}>
                No chats available
              </AppText>
            </View>
          ) : (
            <FlatList
              data={chats}
              keyExtractor={(item) => item.chatId}
              renderItem={renderChatItem}
              contentContainerStyle={styles.listContent}
              showsVerticalScrollIndicator={false}
            />
          )}

          {/* Forward button */}
          <TouchableOpacity
            style={[
              styles.forwardBtn,
              (selectedChatIds.length === 0 || forwarding) && styles.forwardBtnDisabled,
            ]}
            onPress={handleForward}
            disabled={selectedChatIds.length === 0 || forwarding}
            activeOpacity={0.8}
          >
            {forwarding ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <AppIcon name="arrow-forward" size={20} color="#fff" fixedColor />
                <AppText fixedColor style={styles.forwardBtnText}>
                  Forward to {selectedChatIds.length} {selectedChatIds.length === 1 ? 'chat' : 'chats'}
                </AppText>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  modalContent: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '85%',
    paddingBottom: 20,
    ...SHADOW.glow,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(30,156,240,0.40)',
    alignSelf: 'center',
    marginTop: 12,
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(30,156,240,0.15)',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
  },
  closeBtn: {
    padding: 4,
  },
  selectedBanner: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(30,156,240,0.15)',
  },
  selectedText: {
    fontSize: 14,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 14,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  chatItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: RADIUS.lg,
    gap: 12,
  },
  chatItemSelected: {
    backgroundColor: 'rgba(30,156,240,0.12)',
  },
  chatItemContent: {
    flex: 1,
    gap: 2,
  },
  chatItemName: {
    fontSize: 15,
    fontWeight: '600',
  },
  chatItemType: {
    fontSize: 12,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'rgba(30,156,240,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxSelected: {
    backgroundColor: COLORS.blue,
    borderColor: COLORS.blue,
  },
  forwardBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: COLORS.blue,
    marginHorizontal: 20,
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: RADIUS.md,
    ...SHADOW.button,
  },
  forwardBtnDisabled: {
    backgroundColor: 'rgba(30,156,240,0.35)',
    opacity: 0.6,
  },
  forwardBtnText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#fff',
  },
});
