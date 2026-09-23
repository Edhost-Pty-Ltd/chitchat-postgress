// ─── CatalogBubble ────────────────────────────────────────────────────────────
// Renders a product-card message bubble inside a chat thread.
//
// Incoming (isOutgoing=false): shown to the customer — they see the product
//   card with an "Add to Cart" / quantity stepper.
// Outgoing (isOutgoing=true):  shown to the business — the card they just
//   shared, with no cart controls (they sent it, not buying it).
// ─────────────────────────────────────────────────────────────────────────────

import React from 'react';
import {
  View, Text, Image, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import { CatalogItem } from '../types';
import { useCart } from '../context/CartContext';

interface Props {
  item:       CatalogItem;
  isOutgoing: boolean;
  sellerUid:  string;   // UID of the business who owns the catalog
  timestamp?: string;   // pre-formatted time string
}

export function CatalogBubble({ item, isOutgoing, sellerUid, timestamp }: Props) {
  const { addItem, removeItem, getQuantity, sellerUid: cartSeller } = useCart();
  const qty = getQuantity(item.id);

  const handleAdd = () => {
    // Warn if cart already has items from a different seller
    if (cartSeller && cartSeller !== sellerUid && getQuantity(item.id) === 0) {
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

  const handleRemove = () => removeItem(item.id);

  return (
    <View style={[styles.wrapper, isOutgoing ? styles.wrapperOut : styles.wrapperIn]}>
      <View style={styles.card}>
        {/* Product image */}
        {item.imageUri ? (
          <Image source={{ uri: item.imageUri }} style={styles.productImage} resizeMode="cover" />
        ) : (
          <View style={styles.imagePlaceholder}>
            <Ionicons name="cube-outline" size={32} color={COLORS.blue} />
          </View>
        )}

        {/* Product info */}
        <View style={styles.info}>
          <Text style={styles.itemName} numberOfLines={2}>{item.name}</Text>
          {!!item.price && (
            <Text style={styles.itemPrice}>{item.price}</Text>
          )}
          {!!item.description && (
            <Text style={styles.itemDesc} numberOfLines={2}>{item.description}</Text>
          )}
        </View>

        {/* Cart controls — only for incoming cards (customer side) */}
        {!isOutgoing && (
          <View style={styles.cartControls}>
            {qty === 0 ? (
              <TouchableOpacity onPress={handleAdd} activeOpacity={0.85} style={styles.addBtn}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.addBtnGrad}>
                  <Ionicons name="cart-outline" size={14} color="#fff" />
                  <Text style={styles.addBtnText}>Add</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <View style={styles.stepper}>
                <TouchableOpacity onPress={handleRemove} style={styles.stepperBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="remove" size={16} color={COLORS.blue} />
                </TouchableOpacity>
                <Text style={styles.stepperQty}>{qty}</Text>
                <TouchableOpacity onPress={handleAdd} style={styles.stepperBtn} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="add" size={16} color={COLORS.blue} />
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}

        {/* Timestamp */}
        {timestamp && (
          <View style={styles.timeRow}>
            <Text style={[styles.timeText, isOutgoing && styles.timeTextOut]}>
              {timestamp}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    marginVertical: 4,
    marginHorizontal: 8,
    maxWidth: '78%',
  },
  wrapperOut: { alignSelf: 'flex-end' },
  wrapperIn:  { alignSelf: 'flex-start' },

  card: {
    borderRadius: RADIUS.lg,
    backgroundColor: '#fff',
    overflow: 'hidden',
    ...SHADOW.card,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.12)',
  },

  productImage: {
    width: '100%',
    height: 150,
  },
  imagePlaceholder: {
    width: '100%',
    height: 110,
    backgroundColor: 'rgba(30,156,240,0.07)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  info: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 6,
    gap: 3,
  },
  itemName: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    lineHeight: 19,
  },
  itemPrice: {
    fontSize: 15,
    fontWeight: '800',
    color: COLORS.blue,
  },
  itemDesc: {
    fontSize: 12,
    color: COLORS.sub,
    lineHeight: 17,
  },

  // Cart controls
  cartControls: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 4,
  },
  addBtn: {
    borderRadius: RADIUS.full,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  addBtnGrad: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: RADIUS.full,
  },
  addBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },

  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderRadius: RADIUS.full,
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  stepperBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(30,156,240,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperQty: {
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.text,
    minWidth: 20,
    textAlign: 'center',
  },

  // Timestamp
  timeRow: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    alignItems: 'flex-end',
  },
  timeText: {
    fontSize: 10,
    color: COLORS.sub,
  },
  timeTextOut: {
    color: COLORS.sub,
  },
});
