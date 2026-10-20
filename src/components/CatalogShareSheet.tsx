// ─── CatalogShareSheet ────────────────────────────────────────────────────────
// Bottom sheet that lets the business pick a contact / chat to share a
// catalog item into. On confirm it calls sendCatalogItemMessage and navigates
// to that chat thread.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useMemo, useEffect } from 'react';
import {
  View, Text, Image, Modal, TouchableOpacity, FlatList,
  TextInput, StyleSheet, ActivityIndicator, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import { CatalogItem, RootStackParamList } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useChats, ChatPreview } from '../hooks/useChats';
import { useContacts } from '../hooks/useContacts';
import { getOrCreateDirectChat, sendCatalogItemMessage } from '../hooks/useChatActions';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'Chat'>;

interface Props {
  visible:  boolean;
  item:     CatalogItem;
  onClose:  () => void;
}

// ── Helper: get display name for a chat entry ─────────────────────────────────
function useChatDisplayName(chat: ChatPreview, currentUserId: string | null) {
  const { contacts } = useContacts();
  if (chat.type === 'group') return chat.groupName ?? 'Group';
  const otherUid = chat.members.find(m => m !== currentUserId) ?? '';
  const contact  = contacts.find(c => c.userId === otherUid);
  return contact?.displayName ?? otherUid;
}

// ── Individual chat row ───────────────────────────────────────────────────────
function ChatRow({
  chat, currentUserId, onSend,
}: { chat: ChatPreview; currentUserId: string | null; onSend: (chat: ChatPreview) => void }) {
  const name = useChatDisplayName(chat, currentUserId);
  const initial = name.slice(0, 2).toUpperCase();

  return (
    <TouchableOpacity style={styles.row} activeOpacity={0.7} onPress={() => onSend(chat)}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initial}</Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
        {chat.lastMessage ? (
          <Text style={styles.rowSub} numberOfLines={1}>{chat.lastMessage}</Text>
        ) : null}
      </View>
      <View style={styles.sendBtn}>
        <Ionicons name="send" size={16} color={COLORS.blue} />
      </View>
    </TouchableOpacity>
  );
}

// ── Main sheet ────────────────────────────────────────────────────────────────
export function CatalogShareSheet({ visible, item, onClose }: Props) {
  const navigation  = useNavigation<NavProp>();
  const { user }    = useAuth();
  const userId      = user?.uid ?? null;
  const { chats, loading } = useChats(userId);

  const [search,   setSearch]   = useState('');
  const [sending,  setSending]  = useState<string | null>(null); // chatId currently being sent
  const { contacts } = useContacts();
  // Preview URL for the item image. item.imageUri is stored as an object key;
  // resolve it to a short-lived download URL for the preview. A local URI / full
  // URL passes through unchanged. Sending still uses the raw item (object key).
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Reset search on open
  useEffect(() => { if (visible) setSearch(''); }, [visible]);

  useEffect(() => {
    let active = true;
    const uri = item.imageUri;
    if (!uri) { setPreviewUrl(null); return; }
    if (/^(file:|content:|https?:|assets-library:|ph:|data:)/i.test(uri)) {
      setPreviewUrl(uri);
      return;
    }
    import('../services/mediaService').then(({ mediaService }) =>
      mediaService.getDownloadUrl(uri).then((u) => { if (active) setPreviewUrl(u); }),
    );
    return () => { active = false; };
  }, [item.imageUri]);

  // Filter chats by display name matching the search query
  const filtered = useMemo(() => {
    if (!search.trim()) return chats;
    const q = search.toLowerCase();
    return chats.filter(chat => {
      if (chat.type === 'group') {
        return (chat.groupName ?? '').toLowerCase().includes(q);
      }
      const otherUid = chat.members.find(m => m !== userId) ?? '';
      const contact  = contacts.find(c => c.userId === otherUid);
      const name     = contact?.displayName ?? otherUid;
      return name.toLowerCase().includes(q);
    });
  }, [chats, search, userId, contacts]);

  const handleSendToChat = async (chat: ChatPreview) => {
    if (!userId) return;
    setSending(chat.chatId);
    try {
      const result = await sendCatalogItemMessage(chat.chatId, userId, item);
      if (!result.success) {
        Alert.alert('Error', 'Failed to send the product card. Please try again.');
        setSending(null);
        return;
      }

      // Resolve display name for navigation
      let displayName = chat.groupName ?? 'Chat';
      if (chat.type !== 'group') {
        const otherUid = chat.members.find(m => m !== userId) ?? '';
        const contact  = contacts.find(c => c.userId === otherUid);
        displayName    = contact?.displayName ?? 'Chat';
      }

      setSending(null);
      onClose();

      // Navigate to the chat where we just sent the card
      navigation.navigate('Chat', {
        chatId:      chat.chatId,
        displayName,
        isGroup:     chat.type === 'group',
        otherUserId: chat.type === 'group' ? undefined : chat.members.find(m => m !== userId),
      });
    } catch (err) {
      console.error('[CatalogShareSheet] Send error:', err);
      Alert.alert('Error', 'Something went wrong. Please try again.');
      setSending(null);
    }
  };

  // Send to a contact who doesn't have an existing chat yet (creates thread)
  const handleSendToContact = async (contactUserId: string, displayName: string) => {
    if (!userId) return;
    setSending(contactUserId);
    try {
      const chatId = await getOrCreateDirectChat(userId, contactUserId);
      const result = await sendCatalogItemMessage(chatId, userId, item);
      if (!result.success) {
        Alert.alert('Error', 'Failed to send the product card.');
        setSending(null);
        return;
      }
      setSending(null);
      onClose();
      navigation.navigate('Chat', {
        chatId,
        displayName,
        isGroup:     false,
        otherUserId: contactUserId,
      });
    } catch (err) {
      console.error('[CatalogShareSheet] Contact send error:', err);
      Alert.alert('Error', 'Something went wrong. Please try again.');
      setSending(null);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          {/* Handle */}
          <View style={styles.handle} />

          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={22} color={COLORS.sub} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Share Product</Text>
            <View style={{ width: 22 }} />
          </View>

          {/* Item preview pill */}
          <View style={styles.itemPreview}>
            {previewUrl ? (
              <Image source={{ uri: previewUrl }} style={styles.previewImg} />
            ) : (
              <View style={styles.previewImgPlaceholder}>
                <Ionicons name="cube-outline" size={18} color={COLORS.blue} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={styles.previewName} numberOfLines={1}>{item.name}</Text>
              {!!item.price && <Text style={styles.previewPrice}>{item.price}</Text>}
            </View>
          </View>

          {/* Search */}
          <View style={styles.searchWrap}>
            <Ionicons name="search-outline" size={16} color={COLORS.sub} style={{ marginRight: 8 }} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search conversations…"
              placeholderTextColor={COLORS.textFaint}
              value={search}
              onChangeText={setSearch}
            />
          </View>

          {/* Chat list */}
          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={COLORS.blue} />
            </View>
          ) : filtered.length === 0 ? (
            <View style={styles.center}>
              <Ionicons name="chatbubbles-outline" size={40} color={COLORS.sub} />
              <Text style={styles.emptyText}>No conversations yet</Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={c => c.chatId}
              contentContainerStyle={{ paddingBottom: 30 }}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: chat }) => (
                sending === chat.chatId ? (
                  <View style={[styles.row, { justifyContent: 'center' }]}>
                    <ActivityIndicator color={COLORS.blue} />
                  </View>
                ) : (
                  <ChatRow
                    chat={chat}
                    currentUserId={userId}
                    onSend={handleSendToChat}
                  />
                )
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '80%',
    paddingBottom: 34,
  },
  handle: {
    alignSelf: 'center',
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: '#e0e0e0',
    marginTop: 10, marginBottom: 6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: COLORS.text,
  },

  // Item preview
  itemPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginVertical: 12,
    backgroundColor: 'rgba(9,178,238,0.06)',
    borderRadius: RADIUS.md,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.12)',
  },
  previewImg: {
    width: 44, height: 44, borderRadius: RADIUS.sm,
  },
  previewImgPlaceholder: {
    width: 44, height: 44, borderRadius: RADIUS.sm,
    backgroundColor: 'rgba(9,178,238,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  previewName:  { fontSize: 13, fontWeight: '700', color: COLORS.text },
  previewPrice: { fontSize: 13, fontWeight: '600', color: COLORS.blue, marginTop: 2 },

  // Search
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 8,
    backgroundColor: '#f5f7fa',
    borderRadius: RADIUS.md,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    color: COLORS.text,
    padding: 0,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  avatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(9,178,238,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 15, fontWeight: '700', color: COLORS.blue },
  rowInfo: { flex: 1 },
  rowName: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  rowSub:  { fontSize: 12, color: COLORS.sub, marginTop: 2 },
  sendBtn: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: 'rgba(9,178,238,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },

  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    gap: 10,
  },
  emptyText: { fontSize: 14, color: COLORS.sub },
});
