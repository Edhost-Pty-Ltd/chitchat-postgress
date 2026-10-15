// ─── OrderBubble ──────────────────────────────────────────────────────────────
// Premium order-summary card rendered inside a chat thread. Shows each product
// with its image, name, quantity and line subtotal, plus a bold total footer.

import React from 'react';
import { View, Text, Image, StyleSheet, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';

const { width: SCREEN_W } = Dimensions.get('window');
const CARD_W = Math.min(SCREEN_W * 0.78, 320);

export interface OrderData {
  items: { id: string; name: string; price: string; imageUri: string | null; quantity: number }[];
  total: string | null;
  currency: string;
}

interface Props {
  order: OrderData;
  isOutgoing: boolean;
  timestamp?: string;
  tickIcon?: { icon: 'checkmark' | 'checkmark-done'; color: string };
}

// Compute a line subtotal from a string price like "R120" / "$9.99".
function lineSubtotal(price: string, qty: number): string {
  const prefix = price.match(/^[^0-9]*/)?.[0] ?? '';
  const n = parseFloat(price.replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return price;
  return `${prefix}${(n * qty).toFixed(2)}`;
}

export function OrderBubble({ order, isOutgoing, timestamp, tickIcon }: Props) {
  const totalQty = order.items.reduce((s, it) => s + it.quantity, 0);

  return (
    <View style={[styles.wrapper, isOutgoing ? styles.wrapperOut : styles.wrapperIn]}>
      <View style={styles.card}>
        {/* ── Header ── */}
        <LinearGradient colors={GRADIENTS.primary} style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="bag-handle" size={18} color="#fff" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle} numberOfLines={1}>Order</Text>
            <Text style={styles.headerSub}>{totalQty} item{totalQty === 1 ? '' : 's'}</Text>
          </View>
        </LinearGradient>

        {/* ── Line items ── */}
        <View style={styles.body}>
          {order.items.map((it, idx) => (
            <View key={it.id + idx} style={[styles.row, idx > 0 && styles.rowDivider]}>
              {it.imageUri ? (
                <Image source={{ uri: it.imageUri }} style={styles.thumb} resizeMode="cover" />
              ) : (
                <View style={[styles.thumb, styles.thumbPlaceholder]}>
                  <Ionicons name="cube-outline" size={20} color={COLORS.blue} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName} numberOfLines={2}>{it.name}</Text>
                <View style={styles.qtyRow}>
                  <View style={styles.qtyPill}>
                    <Text style={styles.qtyPillText}>×{it.quantity}</Text>
                  </View>
                  <Text style={styles.unitPrice}>{it.price}</Text>
                </View>
              </View>
              <Text style={styles.lineTotal}>{lineSubtotal(it.price, it.quantity)}</Text>
            </View>
          ))}
        </View>

        {/* ── Total footer ── */}
        {order.total != null && (
          <View style={styles.footer}>
            <Text style={styles.footerLabel}>Total</Text>
            <Text style={styles.footerTotal}>{order.currency}{order.total}</Text>
          </View>
        )}

        {/* ── Time + ticks ── */}
        <View style={styles.timeRow}>
          {timestamp && <Text style={styles.timeText}>{timestamp}</Text>}
          {isOutgoing && tickIcon && (
            <Ionicons name={tickIcon.icon} size={13} color={tickIcon.color} style={{ marginLeft: 3 }} />
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { marginVertical: 3, marginHorizontal: 6, maxWidth: CARD_W },
  wrapperOut: { alignSelf: 'flex-end' },
  wrapperIn: { alignSelf: 'flex-start' },
  card: {
    width: CARD_W,
    borderRadius: RADIUS.lg,
    backgroundColor: '#fff',
    overflow: 'hidden',
    ...SHADOW.card,
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.10)',
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 11,
  },
  headerIcon: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '800' },
  headerSub: { color: 'rgba(255,255,255,0.85)', fontSize: 12, marginTop: 1 },

  body: { paddingHorizontal: 12, paddingTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9 },
  rowDivider: { borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.05)' },
  thumb: { width: 46, height: 46, borderRadius: 10, backgroundColor: 'rgba(30,156,240,0.06)' },
  thumbPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  itemName: { fontSize: 13.5, fontWeight: '600', color: COLORS.text, lineHeight: 18 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3 },
  qtyPill: {
    backgroundColor: 'rgba(30,156,240,0.12)', borderRadius: 6,
    paddingHorizontal: 7, paddingVertical: 1,
  },
  qtyPillText: { fontSize: 11, fontWeight: '700', color: COLORS.blue },
  unitPrice: { fontSize: 12, color: COLORS.sub },
  lineTotal: { fontSize: 13.5, fontWeight: '700', color: COLORS.text },

  footer: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 4, paddingHorizontal: 14, paddingVertical: 11,
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)',
    backgroundColor: 'rgba(30,156,240,0.05)',
  },
  footerLabel: { fontSize: 13, fontWeight: '600', color: COLORS.sub },
  footerTotal: { fontSize: 18, fontWeight: '800', color: COLORS.blue },

  timeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2,
    paddingHorizontal: 14, paddingBottom: 8, paddingTop: 6,
  },
  timeText: { fontSize: 11, color: COLORS.sub },
});
