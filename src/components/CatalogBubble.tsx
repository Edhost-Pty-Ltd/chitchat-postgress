// ─── CatalogBubble ────────────────────────────────────────────────────────────
// Product-card message bubble rendered inside a chat thread.
//

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet, Alert,
  Modal, Dimensions, Animated, Share, TouchableWithoutFeedback,
  StatusBar, Platform, SafeAreaView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import { CatalogItem, RootStackParamList } from '../types';
import { useCart } from '../context/CartContext';
import { useAuth } from '../hooks/useAuth';
import { useChats } from '../hooks/useChats';
import { useContacts } from '../hooks/useContacts';
import { getOrCreateDirectChat, sendCatalogItemMessage } from '../hooks/useChatActions';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
type NavProp = NativeStackNavigationProp<RootStackParamList, 'Chat'>;

// ─── Full-screen image viewer ─────────────────────────────────────────────────
interface ViewerProps {
  visible:    boolean;
  imageUri:   string;
  item:       CatalogItem;
  onClose:    () => void;
}

function FullScreenViewer({ visible, imageUri, item, onClose }: ViewerProps) {
  const navigation = useNavigation<NavProp>();
  const { user }   = useAuth();
  const userId     = user?.uid ?? null;
  const { chats }  = useChats(userId);
  const { contacts } = useContacts();

  const slideAnim = useRef(new Animated.Value(SCREEN_H)).current;
  const [forwardOpen, setForwardOpen] = useState(false);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, {
        toValue: 0, useNativeDriver: true,
        friction: 8, tension: 55,
      }).start();
    } else {
      slideAnim.setValue(SCREEN_H);
    }
  }, [visible]);

  const handleClose = () => {
    Animated.timing(slideAnim, {
      toValue: SCREEN_H, duration: 220, useNativeDriver: true,
    }).start(onClose);
  };

  const handleNativeShare = async () => {
    try {
      await Share.share({
        message: `${item.name}${item.price ? ' — ' + item.price : ''}${item.description ? '\n' + item.description : ''}`,
        url: imageUri,
        title: item.name,
      });
    } catch (_) {}
  };

  // ── Forward to chat ───────────────────────────────────────────────────────
  const handleForwardToChat = async (chatId: string, displayName: string, isGroup: boolean, otherUserId?: string) => {
    if (!userId) return;
    setSending(chatId);
    try {
      const result = await sendCatalogItemMessage(chatId, userId, item);
      if (!result.success) {
        Alert.alert('Error', 'Failed to forward. Please try again.');
        setSending(null);
        return;
      }
      setSending(null);
      setForwardOpen(false);
      handleClose();
      navigation.navigate('Chat', { chatId, displayName, isGroup, otherUserId });
    } catch {
      Alert.alert('Error', 'Something went wrong.');
      setSending(null);
    }
  };

  const resolveName = (chatId: string) => {
    const chat = chats.find(c => c.chatId === chatId);
    if (!chat) return 'Chat';
    if (chat.type === 'group') return chat.groupName ?? 'Group';
    const otherUid = chat.members.find(m => m !== userId) ?? '';
    return contacts.find(c => c.userId === otherUid)?.displayName ?? 'Contact';
  };

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={handleClose} statusBarTranslucent>
      <StatusBar backgroundColor="#000" barStyle="light-content" />
      <Animated.View style={[viewerStyles.root, { transform: [{ translateY: slideAnim }] }]}>

        {/* ── Top action bar ── */}
        <SafeAreaView style={viewerStyles.topBar}>
          <TouchableOpacity onPress={handleClose} style={viewerStyles.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>

          <View style={viewerStyles.topBarCenter}>
            <Text style={viewerStyles.topBarTitle} numberOfLines={1}>{item.name}</Text>
            {!!item.price && <Text style={viewerStyles.topBarSub}>{item.price}</Text>}
          </View>

          <View style={{ flexDirection: 'row', gap: 4 }}>
            {/* Forward */}
            <TouchableOpacity onPress={() => setForwardOpen(true)} style={viewerStyles.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="arrow-redo-outline" size={24} color="#fff" />
            </TouchableOpacity>
            {/* Native share */}
            <TouchableOpacity onPress={handleNativeShare} style={viewerStyles.iconBtn} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="share-social-outline" size={24} color="#fff" />
            </TouchableOpacity>
          </View>
        </SafeAreaView>

        {/* ── Image ── */}
        <TouchableWithoutFeedback onPress={handleClose}>
          <View style={viewerStyles.imageWrap}>
            <Image
              source={{ uri: imageUri }}
              style={viewerStyles.image}
              resizeMode="contain"
            />
          </View>
        </TouchableWithoutFeedback>

        {/* ── Product info bar at bottom ── */}
        <SafeAreaView style={viewerStyles.infoBar}>
          <Text style={viewerStyles.infoName}>{item.name}</Text>
          {!!item.price && <Text style={viewerStyles.infoPrice}>{item.price}</Text>}
          {!!item.description && (
            <Text style={viewerStyles.infoDesc} numberOfLines={2}>{item.description}</Text>
          )}
        </SafeAreaView>

        {/* ── Forward sheet ── */}
        {forwardOpen && (
          <View style={viewerStyles.forwardSheet}>
            <View style={viewerStyles.forwardHandle} />
            <Text style={viewerStyles.forwardTitle}>Forward to…</Text>
            <TouchableOpacity style={viewerStyles.forwardClose} onPress={() => setForwardOpen(false)}>
              <Ionicons name="close" size={20} color="#999" />
            </TouchableOpacity>
            {chats.slice(0, 20).map(chat => {
              const name = resolveName(chat.chatId);
              const initial = name.slice(0, 2).toUpperCase();
              const otherUid = chat.type === 'group' ? undefined : chat.members.find(m => m !== userId);
              return (
                <TouchableOpacity
                  key={chat.chatId}
                  style={viewerStyles.forwardRow}
                  activeOpacity={0.75}
                  onPress={() => handleForwardToChat(chat.chatId, name, chat.type === 'group', otherUid)}
                >
                  <View style={viewerStyles.forwardAvatar}>
                    <Text style={viewerStyles.forwardAvatarText}>{initial}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={viewerStyles.forwardName} numberOfLines={1}>{name}</Text>
                    {!!chat.lastMessage && (
                      <Text style={viewerStyles.forwardSub} numberOfLines={1}>{chat.lastMessage}</Text>
                    )}
                  </View>
                  {sending === chat.chatId
                    ? <Ionicons name="time-outline" size={18} color={COLORS.sub} />
                    : <Ionicons name="send-outline" size={18} color={COLORS.blue} />
                  }
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </Animated.View>
    </Modal>
  );
}

// ─── CatalogBubble ────────────────────────────────────────────────────────────
interface Props {
  item:       CatalogItem;
  isOutgoing: boolean;
  sellerUid:  string;
  timestamp?: string;
  tickIcon?:  { icon: 'checkmark' | 'checkmark-done'; color: string };
}

export const CatalogBubble = React.memo(function CatalogBubble({ item, isOutgoing, sellerUid, timestamp, tickIcon }: Props) {
  const { addItem, removeItem, getQuantity, sellerUid: cartSeller } = useCart();
  const qty = getQuantity(item.id);
  const [viewerVisible, setViewerVisible] = useState(false);

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
    <>
      <View style={[styles.wrapper, isOutgoing ? styles.wrapperOut : styles.wrapperIn]}>
        <View style={styles.card}>

          {/* ── Product image — full width, tappable ── */}
          {item.imageUri ? (
            <TouchableOpacity
              activeOpacity={0.92}
              onPress={() => setViewerVisible(true)}
              style={styles.imageWrap}
            >
              <Image source={{ uri: item.imageUri }} style={styles.productImage} resizeMode="cover" />
              {/* Subtle zoom hint */}
              <View style={styles.zoomHint} pointerEvents="none">
                <Ionicons name="expand-outline" size={16} color="rgba(255,255,255,0.85)" />
              </View>
            </TouchableOpacity>
          ) : (
            <View style={styles.imagePlaceholder}>
              <Ionicons name="cube-outline" size={36} color={COLORS.blue} />
            </View>
          )}

          {/* ── Product info ── */}
          <View style={styles.info}>
            <Text style={styles.itemName}>{item.name}</Text>
            {!!item.price && (
              <Text style={styles.itemPrice}>{item.price}</Text>
            )}
            {!!item.description && (
              <Text style={styles.itemDesc}>{item.description}</Text>
            )}

            {/* Timestamp + tick row */}
            <View style={styles.timeRow}>
              {timestamp && (
                <Text style={[styles.timeText, isOutgoing && styles.timeTextOut]}>
                  {timestamp}
                </Text>
              )}
              {isOutgoing && tickIcon && (
                <Ionicons name={tickIcon.icon} size={13} color={tickIcon.color} style={{ marginLeft: 3 }} />
              )}
            </View>
          </View>

          {/* ── Cart controls (customer / incoming side only) ── */}
          {!isOutgoing && (
            <View style={styles.cartBar}>
              {qty === 0 ? (
                <TouchableOpacity onPress={handleAdd} activeOpacity={0.85} style={styles.addBtn}>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.addBtnGrad}>
                    <Ionicons name="cart-outline" size={15} color="#fff" />
                    <Text style={styles.addBtnText}>Add to cart</Text>
                  </LinearGradient>
                </TouchableOpacity>
              ) : (
                <View style={styles.stepper}>
                  <TouchableOpacity
                    onPress={() => removeItem(item.id)}
                    style={styles.stepperBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="remove" size={17} color={COLORS.blue} />
                  </TouchableOpacity>
                  <Text style={styles.stepperQty}>{qty}</Text>
                  <TouchableOpacity
                    onPress={handleAdd}
                    style={styles.stepperBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="add" size={17} color={COLORS.blue} />
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>
      </View>

      {/* Full-screen viewer */}
      {item.imageUri && (
        <FullScreenViewer
          visible={viewerVisible}
          imageUri={item.imageUri}
          item={item}
          onClose={() => setViewerVisible(false)}
        />
      )}
    </>
  );
});

// ─── Styles ───────────────────────────────────────────────────────────────────
const CARD_W = Math.min(SCREEN_W * 0.72, 280);

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 3,
    marginHorizontal: 6,
    maxWidth: CARD_W,
  },
  wrapperOut: { alignSelf: 'flex-end' },
  wrapperIn:  { alignSelf: 'flex-start' },

  card: {
    borderRadius: RADIUS.lg,
    backgroundColor: '#fff',
    overflow: 'hidden',
    ...SHADOW.card,
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.10)',
  },

  // Image
  imageWrap:    { position: 'relative' },
  productImage: { width: CARD_W - 2, height: 180 },   // -2 for border
  imagePlaceholder: {
    width: CARD_W - 2, height: 140,
    backgroundColor: 'rgba(9,178,238,0.06)',
    alignItems: 'center', justifyContent: 'center',
  },
  zoomHint: {
    position: 'absolute', bottom: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderRadius: 6, padding: 4,
  },

  // Info block
  info: {
    paddingHorizontal: 14,
    paddingTop: 11,
    paddingBottom: 8,
  },
  itemName: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    lineHeight: 20,
    marginBottom: 3,
  },
  itemPrice: {
    fontSize: 17,
    fontWeight: '800',
    color: COLORS.blue,
    marginBottom: 4,
  },
  itemDesc: {
    fontSize: 13,
    color: COLORS.sub,
    lineHeight: 18,
    marginBottom: 6,
  },

  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    marginTop: 2,
  },
  timeText: {
    fontSize: 11,
    color: COLORS.sub,
  },
  timeTextOut: {
    color: COLORS.sub,
  },

  // Cart bar
  cartBar: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(9,178,238,0.08)',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  addBtn: {
    borderRadius: RADIUS.full,
    overflow: 'hidden',
    alignSelf: 'stretch',
  },
  addBtnGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    borderRadius: RADIUS.full,
  },
  addBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },

  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    backgroundColor: 'rgba(9,178,238,0.07)',
    borderRadius: RADIUS.full,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  stepperBtn: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: 'rgba(9,178,238,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  stepperQty: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.text,
    minWidth: 24,
    textAlign: 'center',
  },
});

// ─── Full-screen viewer styles ────────────────────────────────────────────────
const viewerStyles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#000',
  },

  // Top bar
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingTop: Platform.OS === 'android' ? 12 : 4,
    paddingBottom: 8,
    backgroundColor: 'rgba(0,0,0,0.55)',
    gap: 4,
  },
  iconBtn: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 20,
  },
  topBarCenter: { flex: 1, paddingHorizontal: 6 },
  topBarTitle:  { color: '#fff', fontSize: 15, fontWeight: '700' },
  topBarSub:    { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 1 },

  // Image
  imageWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: SCREEN_W,
    height: SCREEN_H * 0.65,
  },

  // Bottom info bar
  infoBar: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 20,
    paddingVertical: 14,
    gap: 3,
  },
  infoName:  { color: '#fff', fontSize: 17, fontWeight: '700' },
  infoPrice: { color: '#5bc8ff', fontSize: 18, fontWeight: '800' },
  infoDesc:  { color: 'rgba(255,255,255,0.7)', fontSize: 13, lineHeight: 18 },

  // Forward sheet
  forwardSheet: {
    position: 'absolute',
    bottom: 0, left: 0, right: 0,
    backgroundColor: '#fff',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    maxHeight: SCREEN_H * 0.55,
    paddingHorizontal: 0,
    paddingBottom: Platform.OS === 'ios' ? 30 : 16,
  },
  forwardHandle: {
    alignSelf: 'center',
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: '#e0e0e0',
    marginTop: 10, marginBottom: 4,
  },
  forwardTitle: {
    fontSize: 16, fontWeight: '700',
    color: COLORS.text,
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  forwardClose: {
    position: 'absolute', top: 12, right: 16,
    padding: 6,
  },
  forwardRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  forwardAvatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(9,178,238,0.14)',
    alignItems: 'center', justifyContent: 'center',
  },
  forwardAvatarText: { fontSize: 14, fontWeight: '700', color: COLORS.blue },
  forwardName: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  forwardSub:  { fontSize: 12, color: COLORS.sub, marginTop: 1 },
});
