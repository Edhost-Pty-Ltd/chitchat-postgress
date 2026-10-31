// ─── PaymentSheet ─────────────────────────────────────────────────────────────
// Premium payment flow modal. Shown before an order is finalized. The user sees
// their order summary, enters card details, and taps "Pay Now." In this version
// the payment is frontend-only (always succeeds), but the screen is designed to
// plug into a real payment gateway later.

import React, { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, ScrollView,
  StyleSheet, Image, Animated, Easing, ActivityIndicator, Platform,
  KeyboardAvoidingView, Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';

const { width: SCREEN_W } = Dimensions.get('window');

// ── Order item shape (matches what the cart hands off) ────────────────────────
export interface PaymentOrderItem {
  id: string;
  name: string;
  price: string;
  imageUri: string | null;
  quantity: number;
}

interface Props {
  visible: boolean;
  items: PaymentOrderItem[];
  currency: string;
  total: string | null;
  /** Called when the user cancels / dismisses the sheet. */
  onCancel: () => void;
  /** Called when payment "succeeds." The parent then sends the order message. */
  onPaymentSuccess: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function lineSubtotal(price: string, qty: number): string {
  const prefix = price.match(/^[^0-9]*/)?.[0] ?? '';
  const n = parseFloat(price.replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return price;
  return `${prefix}${(n * qty).toFixed(2)}`;
}

function formatCard(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 16);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

function formatExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

// ── Component ─────────────────────────────────────────────────────────────────
export function PaymentSheet({ visible, items, currency, total, onCancel, onPaymentSuccess }: Props) {
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry]         = useState('');
  const [cvv, setCvv]               = useState('');
  const [holderName, setHolderName] = useState('');
  const [processing, setProcessing] = useState(false);
  const [success, setSuccess]       = useState(false);

  const checkAnim   = useRef(new Animated.Value(0)).current;
  const slideAnim   = useRef(new Animated.Value(0)).current;

  // Reset on open
  useEffect(() => {
    if (visible) {
      setCardNumber(''); setExpiry(''); setCvv(''); setHolderName('');
      setProcessing(false); setSuccess(false);
      checkAnim.setValue(0);
      Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, friction: 8, tension: 50 }).start();
    } else {
      slideAnim.setValue(0);
    }
  }, [visible]);

  const totalQty   = items.reduce((s, it) => s + it.quantity, 0);
  const canSubmit  = cardNumber.replace(/\s/g, '').length >= 15 && expiry.length >= 5 && cvv.length >= 3 && holderName.trim().length > 1;

  const handlePay = () => {
    if (!canSubmit || processing) return;
    setProcessing(true);

    // Simulate payment processing (1.5 s, then "success")
    setTimeout(() => {
      setProcessing(false);
      setSuccess(true);

      Animated.timing(checkAnim, { toValue: 1, duration: 600, easing: Easing.out(Easing.back(1.5)), useNativeDriver: true }).start();

      // Auto-dismiss after 1.8 s and fire the success callback
      setTimeout(() => {
        onPaymentSuccess();
      }, 1800);
    }, 1500);
  };

  if (!visible) return null;

  const translateY = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [600, 0] });

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onCancel} statusBarTranslucent>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={s.root}
      >
        {/* Scrim */}
        <TouchableOpacity style={s.scrim} activeOpacity={1} onPress={processing || success ? undefined : onCancel} />

        <Animated.View style={[s.sheet, { transform: [{ translateY }] }]}>
          {/* Handle */}
          <View style={s.handle} />

          {success ? (
            /* ── Success state ──────────────────────────────────────────── */
            <View style={s.successWrap}>
              <Animated.View style={[s.checkCircle, { transform: [{ scale: checkAnim }] }]}>
                <LinearGradient colors={['#22c55e', '#16a34a']} style={s.checkCircleGrad}>
                  <Ionicons name="checkmark" size={40} color="#fff" />
                </LinearGradient>
              </Animated.View>
              <Text style={s.successTitle}>Payment Successful</Text>
              <Text style={s.successSub}>Your order has been placed</Text>
            </View>
          ) : (
            /* ── Payment form ───────────────────────────────────────────── */
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {/* Header */}
              <View style={s.header}>
                <View style={s.headerLeft}>
                  <LinearGradient colors={GRADIENTS.primary} style={s.headerIcon}>
                    <Ionicons name="card" size={20} color="#fff" />
                  </LinearGradient>
                  <View>
                    <Text style={s.headerTitle}>Checkout</Text>
                    <Text style={s.headerSub}>{totalQty} item{totalQty !== 1 ? 's' : ''}</Text>
                  </View>
                </View>
                <TouchableOpacity onPress={onCancel} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <Ionicons name="close" size={22} color={COLORS.sub} />
                </TouchableOpacity>
              </View>

              {/* Order summary */}
              <View style={s.summarySection}>
                <Text style={s.sectionLabel}>ORDER SUMMARY</Text>
                {items.map((it, idx) => (
                  <View key={it.id + idx} style={s.itemRow}>
                    {it.imageUri ? (
                      <Image source={{ uri: it.imageUri }} style={s.itemThumb} />
                    ) : (
                      <View style={[s.itemThumb, s.itemThumbPlaceholder]}>
                        <Ionicons name="cube-outline" size={16} color={COLORS.blue} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={s.itemName} numberOfLines={1}>{it.name}</Text>
                      <Text style={s.itemMeta}>×{it.quantity}  ·  {it.price}</Text>
                    </View>
                    <Text style={s.itemLine}>{lineSubtotal(it.price, it.quantity)}</Text>
                  </View>
                ))}
                {total != null && (
                  <View style={s.totalRow}>
                    <Text style={s.totalLabel}>Total</Text>
                    <Text style={s.totalValue}>{currency}{total}</Text>
                  </View>
                )}
              </View>

              {/* Card form */}
              <View style={s.formSection}>
                <Text style={s.sectionLabel}>PAYMENT DETAILS</Text>

                {/* Card number */}
                <View style={s.inputGroup}>
                  <Text style={s.inputLabel}>Card Number</Text>
                  <View style={s.inputRow}>
                    <Ionicons name="card-outline" size={18} color={COLORS.sub} style={{ marginRight: 10 }} />
                    <TextInput
                      style={s.input}
                      placeholder="4242 4242 4242 4242"
                      placeholderTextColor="#ccc"
                      keyboardType="number-pad"
                      value={cardNumber}
                      onChangeText={(t) => setCardNumber(formatCard(t))}
                      maxLength={19}
                      editable={!processing}
                    />
                    {cardNumber.length > 3 && (
                      <Ionicons
                        name={cardNumber.startsWith('4') ? 'logo-google' : cardNumber.startsWith('5') ? 'logo-apple' : 'card'}
                        size={20}
                        color={COLORS.blue}
                      />
                    )}
                  </View>
                </View>

                {/* Expiry + CVV row */}
                <View style={s.splitRow}>
                  <View style={[s.inputGroup, { flex: 1 }]}>
                    <Text style={s.inputLabel}>Expiry</Text>
                    <View style={s.inputRow}>
                      <TextInput
                        style={s.input}
                        placeholder="MM/YY"
                        placeholderTextColor="#ccc"
                        keyboardType="number-pad"
                        value={expiry}
                        onChangeText={(t) => setExpiry(formatExpiry(t))}
                        maxLength={5}
                        editable={!processing}
                      />
                    </View>
                  </View>
                  <View style={{ width: 14 }} />
                  <View style={[s.inputGroup, { flex: 1 }]}>
                    <Text style={s.inputLabel}>CVV</Text>
                    <View style={s.inputRow}>
                      <TextInput
                        style={s.input}
                        placeholder="···"
                        placeholderTextColor="#ccc"
                        keyboardType="number-pad"
                        value={cvv}
                        onChangeText={(t) => setCvv(t.replace(/\D/g, '').slice(0, 4))}
                        maxLength={4}
                        secureTextEntry
                        editable={!processing}
                      />
                      <Ionicons name="lock-closed" size={14} color={COLORS.sub} />
                    </View>
                  </View>
                </View>

                {/* Cardholder name */}
                <View style={s.inputGroup}>
                  <Text style={s.inputLabel}>Cardholder Name</Text>
                  <View style={s.inputRow}>
                    <Ionicons name="person-outline" size={18} color={COLORS.sub} style={{ marginRight: 10 }} />
                    <TextInput
                      style={s.input}
                      placeholder="John Doe"
                      placeholderTextColor="#ccc"
                      value={holderName}
                      onChangeText={setHolderName}
                      autoCapitalize="words"
                      editable={!processing}
                    />
                  </View>
                </View>
              </View>

              {/* Security badge */}
              <View style={s.securityRow}>
                <Ionicons name="shield-checkmark" size={16} color="#22c55e" />
                <Text style={s.securityText}>Secured with 256-bit SSL encryption</Text>
              </View>

              {/* Pay button */}
              <TouchableOpacity
                onPress={handlePay}
                activeOpacity={0.85}
                disabled={!canSubmit || processing}
                style={{ marginHorizontal: 20, marginBottom: 34 }}
              >
                <LinearGradient
                  colors={canSubmit && !processing ? GRADIENTS.primary : ['#ccc', '#bbb']}
                  style={s.payBtn}
                >
                  {processing ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="lock-closed" size={16} color="#fff" style={{ marginRight: 8 }} />
                      <Text style={s.payBtnText}>
                        Pay {total != null ? `${currency}${total}` : ''}
                      </Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            </ScrollView>
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFill as object, backgroundColor: 'rgba(0,0,0,0.5)' },

  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '92%',
    ...SHADOW.card,
  },
  handle: {
    alignSelf: 'center', width: 40, height: 4, borderRadius: 2,
    backgroundColor: '#ddd', marginTop: 10, marginBottom: 4,
  },

  // ── Header ──
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.05)',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: { fontSize: 18, fontWeight: '800', color: COLORS.text },
  headerSub: { fontSize: 13, color: COLORS.sub, marginTop: 1 },

  // ── Summary ──
  summarySection: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 8 },
  sectionLabel: {
    fontSize: 11, fontWeight: '700', color: COLORS.sub, letterSpacing: 1.2,
    marginBottom: 12,
  },
  itemRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  itemThumb: { width: 38, height: 38, borderRadius: 8 },
  itemThumbPlaceholder: {
    backgroundColor: 'rgba(30,156,240,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  itemName: { fontSize: 13, fontWeight: '600', color: COLORS.text },
  itemMeta: { fontSize: 12, color: COLORS.sub, marginTop: 2 },
  itemLine: { fontSize: 13, fontWeight: '700', color: COLORS.text },
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 12, marginTop: 4,
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.08)',
  },
  totalLabel: { fontSize: 14, fontWeight: '600', color: COLORS.sub },
  totalValue: { fontSize: 20, fontWeight: '800', color: COLORS.blue },

  // ── Form ──
  formSection: { paddingHorizontal: 20, paddingTop: 20 },
  inputGroup: { marginBottom: 16 },
  inputLabel: { fontSize: 12, fontWeight: '600', color: COLORS.sub, marginBottom: 6 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#f7f8fa',
    borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.08)',
    paddingHorizontal: 14, paddingVertical: Platform.OS === 'ios' ? 14 : 10,
  },
  input: { flex: 1, fontSize: 15, color: COLORS.text, padding: 0 },
  splitRow: { flexDirection: 'row' },

  // ── Security ──
  securityRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 14,
  },
  securityText: { fontSize: 12, color: COLORS.sub },

  // ── Pay button ──
  payBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 16, borderRadius: RADIUS.md,
  },
  payBtnText: { color: '#fff', fontSize: 16, fontWeight: '800' },

  // ── Success ──
  successWrap: { alignItems: 'center', paddingVertical: 60, gap: 14 },
  checkCircle: { width: 80, height: 80, borderRadius: 40 },
  checkCircleGrad: {
    width: 80, height: 80, borderRadius: 40,
    alignItems: 'center', justifyContent: 'center',
  },
  successTitle: { fontSize: 22, fontWeight: '800', color: COLORS.text },
  successSub: { fontSize: 14, color: COLORS.sub },
});
