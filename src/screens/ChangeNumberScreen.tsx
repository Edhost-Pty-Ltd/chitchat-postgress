// ─── Screen: Change Number ───────────────────────────────────────────────────
// Two-step flow:
//   Step 1 — enter new SA phone number (country picker + dial pad)
//   Step 2 — verify OTP sent to the new number
//   On success — updates the phone number in AuthContext
import React, { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView,
  KeyboardAvoidingView, Platform, ActivityIndicator,
  Alert, Modal, FlatList,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import firestore from '@react-native-firebase/firestore';
import { getAuth } from '@react-native-firebase/auth';
import { db } from '../config/firebase';
import { useAuth } from '../context/AuthContext';
import { sendNumberChangeNotification } from '../hooks/useChatActions';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { COUNTRIES, DEFAULT_COUNTRY, Country, formatPhoneNumber } from '../data/countryCodes';
import { RootStackParamList } from '../types';
import { useAuth as useFirebaseAuth } from '../hooks/useAuth';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'ChangeNumber'>;

type Step = 'number' | 'otp';

function CountryPicker({ visible, selected, onSelect, onClose }: {
  visible: boolean; selected: Country;
  onSelect: (c: Country) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const { FG } = useForeground();
  const { textColor } = useTypography();
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter((c) =>
      c.name.toLowerCase().includes(q) || c.dial.includes(q) || c.code.toLowerCase().includes(q)
    );
  }, [query]);
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.bg2 }}>
        <View style={[pick.header, { borderBottomColor: FG.glassBorder }]}>
          <AppText style={[pick.title, { color: textColor }]}>Select Country</AppText>
          <TouchableOpacity onPress={onClose}><AppIcon name="close" size={22} color={COLORS.sub} /></TouchableOpacity>
        </View>
        <View style={[pick.searchWrap, { ...GLASS.input, borderRadius: RADIUS.md, paddingHorizontal: 10 }]}>
          <AppIcon name="search-outline" size={16} color={COLORS.sub} style={{ marginRight: 6 }} />
          <TextInput style={[pick.searchInput, { color: textColor }]} placeholder="Search…"
            placeholderTextColor={COLORS.textFaint} value={query} onChangeText={setQuery}
            autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" />
        </View>
        <FlatList data={filtered} keyExtractor={(i) => i.code} keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const sel = item.code === selected.code;
            return (
              <TouchableOpacity style={[pick.item, sel && pick.itemSel]}
                onPress={() => { onSelect(item); onClose(); setQuery(''); }} activeOpacity={0.7}>
                <AppText fixedColor style={pick.flag}>{item.flag}</AppText>
                <AppText style={[pick.name, { color: textColor }]}>{item.name}</AppText>
                <AppText style={[pick.dial, { color: COLORS.sub }]}>+{item.dial}</AppText>
                {sel && <AppIcon name="checkmark" size={16} color={COLORS.blue} fixedColor />}
              </TouchableOpacity>
            );
          }}
          ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: COLORS.border, marginLeft: 64 }} />}
        />
      </SafeAreaView>
    </Modal>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────

export default function ChangeNumberScreen() {
  const navigation = useNavigation<NavProp>();
  const { phone: currentPhone, displayName, signIn } = useAuth();
  const { sendOTP, verifyOTP } = useFirebaseAuth();
  const { FG } = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();

  const [step,        setStep]        = useState<Step>('number');
  const [country,     setCountry]     = useState<Country>(DEFAULT_COUNTRY);
  const [localNumber, setLocalNumber] = useState('');
  const [pickerOpen,  setPickerOpen]  = useState(false);
  const [otp,         setOtp]         = useState('');
  const [loading,     setLoading]     = useState(false);
  const [errorMsg,    setErrorMsg]    = useState('');
  const [resendTimer, setResendTimer] = useState(0);
  const otpInputRef = useRef<TextInput>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rawDigits  = localNumber.replace(/\D/g, '');
  const formatted  = formatPhoneNumber(rawDigits, country.groups);
  const fullNumber = `+${country.dial}${rawDigits}`;

  const startResendTimer = () => {
    setResendTimer(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setResendTimer((t) => { if (t <= 1) { clearInterval(timerRef.current!); return 0; } return t - 1; });
    }, 1000);
  };

  const handleSend = async () => {
    if (rawDigits.length < country.digits) {
      setErrorMsg(`Enter a ${country.digits}-digit number for ${country.name}.`); return;
    }
    if (fullNumber === currentPhone) {
      setErrorMsg('This is already your current number.'); return;
    }
    setErrorMsg(''); setLoading(true);
    try {
      const ok = await sendOTP(fullNumber);
      if (ok) {
        setStep('otp'); startResendTimer();
      } else {
        setErrorMsg('Failed to send code. Try again.');
      }
    } catch { setErrorMsg('Failed to send code. Try again.'); }
    finally { setLoading(false); }
  };

  const handleVerify = async () => {
    const code = otp;
    if (code.length < 6) { setErrorMsg('Enter all 6 digits.'); return; }
    setErrorMsg(''); setLoading(true);
    try {
      const ok = await verifyOTP(code);
      if (ok) {
        // Update phone number in AuthContext
        await signIn(fullNumber);
        
        // Update phone number in Firestore user document
        const authInstance = getAuth();
        const currentUser = authInstance.currentUser;
        if (currentUser) {
          const fsDb = db as ReturnType<typeof firestore>;
          await fsDb.collection('users').doc(currentUser.uid).update({ phone: fullNumber });
          console.log('[ChangeNumberScreen] Updated phone number in Firestore');
        }
        
        // Send number change notification to all chats
        const { success, count } = await sendNumberChangeNotification(
          currentUser?.uid || '',
          currentPhone || 'unknown',
          fullNumber,
          displayName || 'User'
        );
        
        console.log(`[ChangeNumberScreen] Sent ${count} number change notifications`);
        
        Alert.alert(
          'Number updated ✓',
          `Your number has been changed to ${fullNumber}.\n\n${count > 0 ? `A notification has been sent to ${count} chat${count > 1 ? 's' : ''} letting your contacts know.` : 'Your contacts will see your new number.'}`,
          [{ text: 'Done', onPress: () => navigation.goBack() }],
        );
      } else {
        setErrorMsg('Incorrect code. Try again.');
        setOtp('');
        otpInputRef.current?.focus();
      }
    } catch { setErrorMsg('Verification failed. Try again.'); }
    finally { setLoading(false); }
  };

  const handleOtpChange = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 6);
    setOtp(digits);
    if (digits.length === 6) handleVerify();
  };

  return (
    <>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <LinearGradient colors={['#87CEEB', '#C5E8F7', '#E8F6FF']} style={StyleSheet.absoluteFill} />

        {/* Header */}
        <View style={[styles.header, { backgroundColor: 'transparent', borderBottomColor: 'rgba(30,156,240,0.18)' }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
            <AppIcon name="chevron-back" size={26} color={COLORS.blue} fixedColor />
          </TouchableOpacity>
          <AppText style={[styles.headerTitle, { color: COLORS.text }]}>Change Number</AppText>
          <View style={{ width: 36 }} />
        </View>

        {/* ── Web-only notice ── */}
        {Platform.OS === 'web' ? (
          <ScrollView contentContainerStyle={styles.scroll}>
            <View style={[styles.card, bevel, { alignItems: 'center', gap: 16 }]}>
              <View style={styles.webNoticeIcon}>
                <Ionicons name="phone-portrait-outline" size={40} color={COLORS.blue} />
              </View>
              <AppText style={[styles.cardTitle, { color: COLORS.text, textAlign: 'center' }]}>
                Use the Mobile App
              </AppText>
              <AppText style={[styles.cardSub, { color: COLORS.sub, textAlign: 'center', marginBottom: 0 }]}>
                For security reasons, changing your phone number is only available on the{' '}
                <AppText fixedColor style={{ fontWeight: '700', color: COLORS.text }}>ChitChat mobile app</AppText>.
                {'\n\n'}Please open ChitChat on your Android or iOS device to change your number.
              </AppText>
              <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.85}>
                <LinearGradient colors={GRADIENTS.primary} style={[styles.primaryBtn, { paddingHorizontal: 32 }]}>
                  <AppText fixedColor style={styles.primaryBtnText}>Go Back</AppText>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={[styles.card, bevel]}>

            {step === 'number' ? (
              <>
                <AppText style={[styles.cardTitle, { color: COLORS.text }]}>New Phone Number</AppText>
                <AppText style={[styles.cardSub, { color: COLORS.sub }]}>
                  Current: <AppText fixedColor style={{ fontWeight: '700', color: COLORS.text }}>{currentPhone || 'Not set'}</AppText>
                  {'\n'}Enter your new number to receive a verification code.
                </AppText>

                <View style={styles.phoneRow}>
                  <TouchableOpacity style={styles.dialBtn} onPress={() => setPickerOpen(true)} activeOpacity={0.75}>
                    <AppText fixedColor style={styles.dialFlag}>{country.flag}</AppText>
                    <AppText fixedColor style={styles.dialCode}>+{country.dial}</AppText>
                    <Ionicons name="chevron-down" size={13} color={COLORS.sub} />
                  </TouchableOpacity>
                  <View style={[styles.inputWrap, styles.inputFlex]}>
                    <TextInput
                      style={[styles.input, { color: COLORS.text }]}
                      placeholder="Phone number" placeholderTextColor={COLORS.textFaint}
                      keyboardType="phone-pad" value={formatted}
                      onChangeText={(t) => { setLocalNumber(t.replace(/\D/g, '').slice(0, country.digits)); setErrorMsg(''); }}
                      returnKeyType="done" onSubmitEditing={handleSend}
                    />
                  </View>
                </View>

                {errorMsg ? <AppText fixedColor style={styles.error}>{errorMsg}</AppText> : null}

                <TouchableOpacity onPress={handleSend} activeOpacity={0.85} disabled={loading}>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtn}>
                    {loading ? <ActivityIndicator color="#fff" /> : <AppText fixedColor style={styles.primaryBtnText}>Send Code</AppText>}
                  </LinearGradient>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <TouchableOpacity style={styles.backRow}
                  onPress={() => { setStep('number'); setErrorMsg(''); setOtp(''); }}>
                  <AppIcon name="chevron-back" size={18} color={COLORS.blue} fixedColor />
                  <AppText fixedColor style={styles.backRowText}>Change number</AppText>
                </TouchableOpacity>

                <AppText style={[styles.cardTitle, { color: COLORS.text }]}>Verify Code</AppText>
                <AppText style={[styles.cardSub, { color: COLORS.sub }]}>
                  We sent a 6-digit code to{'\n'}
                  <AppText fixedColor style={{ fontWeight: '700', color: COLORS.text }}>{fullNumber}</AppText>
                </AppText>

                {/* Single hidden input captures all 6 digits + autofill */}
                <TextInput
                  ref={otpInputRef}
                  style={styles.otpHiddenInput}
                  value={otp}
                  onChangeText={handleOtpChange}
                  keyboardType="number-pad"
                  maxLength={6}
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  autoFocus
                />

                <TouchableOpacity
                  activeOpacity={1}
                  style={styles.otpRow}
                  onPress={() => otpInputRef.current?.focus()}
                >
                  {[0,1,2,3,4,5].map((i) => {
                    const digit = otp[i] || '';
                    const isFocused = otp.length === i;
                    return (
                      <View
                        key={i}
                        style={[styles.otpBox, digit ? styles.otpBoxFilled : (isFocused ? styles.otpBoxFocused : null)]}
                      >
                        {digit ? (
                          <Text style={styles.otpDigitText}>{digit}</Text>
                        ) : (
                          <View style={[styles.otpCaret, !isFocused && { opacity: 0 }]} />
                        )}
                      </View>
                    );
                  })}
                </TouchableOpacity>

                {errorMsg ? <AppText fixedColor style={styles.error}>{errorMsg}</AppText> : null}

                <TouchableOpacity onPress={handleVerify} activeOpacity={0.85} disabled={loading}>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtn}>
                    {loading ? <ActivityIndicator color="#fff" /> : <AppText fixedColor style={styles.primaryBtnText}>Confirm Change</AppText>}
                  </LinearGradient>
                </TouchableOpacity>

                <View style={styles.resendRow}>
                  <AppText fixedColor style={styles.resendLabel}>Didn't receive a code? </AppText>
                  <TouchableOpacity onPress={async () => {
                    if (resendTimer > 0) return;
                    setLoading(true);
                    try {
                      const ok = await sendOTP(fullNumber);
                      if (ok) startResendTimer();
                      else setErrorMsg('Failed to resend.');
                    }
                    catch { setErrorMsg('Failed to resend.'); }
                    finally { setLoading(false); }
                  }} disabled={resendTimer > 0}>
                    <AppText fixedColor style={[styles.resendLink, resendTimer > 0 && { color: COLORS.textFaint }]}>
                      {resendTimer > 0 ? `Resend in ${resendTimer}s` : 'Resend'}
                    </AppText>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </ScrollView>
        )} {/* end Platform.OS === 'web' ? ... : ( */}
      </KeyboardAvoidingView>

      <CountryPicker visible={pickerOpen} selected={country} onSelect={setCountry} onClose={() => setPickerOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  root:   { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingTop: Platform.OS === 'web' ? 16 : 52, paddingBottom: 12, paddingHorizontal: 14, gap: 8, borderBottomWidth: 1 },
  backBtn:     {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)',
  },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' },
  webNoticeIcon: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: 'rgba(30,156,240,0.12)',
    borderWidth: 1, borderColor: 'rgba(30,156,240,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },

  scroll:  { padding: 20, paddingBottom: 48 },
  card:    { borderRadius: RADIUS.xl, padding: 22 },
  cardTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text, marginBottom: 6 },
  cardSub:   { fontSize: 13, color: COLORS.sub, marginBottom: 20, lineHeight: 19 },

  phoneRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  dialBtn:  { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 13, ...GLASS.input, borderRadius: RADIUS.md },
  dialFlag: { fontSize: 20 },
  dialCode: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  inputWrap:{ ...GLASS.input, borderRadius: RADIUS.md, flexDirection: 'row', alignItems: 'center' },
  inputFlex:{ flex: 1 },
  input:    { flex: 1, paddingHorizontal: 12, paddingVertical: 13, fontSize: 15 },

  error:   { fontSize: 13, color: COLORS.missed, marginBottom: 10, marginTop: 2 },
  primaryBtn:     { borderRadius: RADIUS.md, paddingVertical: 15, alignItems: 'center', ...SHADOW.button, marginTop: 4 },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  backRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  backRowText: { fontSize: 13, color: COLORS.blue, fontWeight: '600', marginLeft: 2 },

  otpRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 6, marginBottom: 16 },
  otpRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 6, marginBottom: 16 },
  otpBox: { width: 46, height: 54, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', ...GLASS.input },
  otpBoxFilled: { borderColor: COLORS.blue, backgroundColor: 'rgba(30,156,240,0.10)' },
  otpBoxFocused: { borderColor: COLORS.blue, borderWidth: 2 },
  otpHiddenInput: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  otpDigitText: { fontSize: 20, fontWeight: '700', color: COLORS.text, lineHeight: 24, includeFontPadding: false } as any,
  otpCaret: { width: 2, height: 20, backgroundColor: COLORS.blue, borderRadius: 1 },

  resendRow:   { flexDirection: 'row', justifyContent: 'center', marginTop: 16 },
  resendLabel: { fontSize: 13, color: COLORS.sub },
  resendLink:  { fontSize: 13, color: COLORS.blue, fontWeight: '700' },

  hintBox: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14, padding: 10, backgroundColor: 'rgba(30,156,240,0.06)', borderRadius: RADIUS.sm, borderWidth: 1, borderColor: 'rgba(30,156,240,0.15)' },
  hintText: { fontSize: 12, color: COLORS.sub },
});

const pick = StyleSheet.create({
  header:     { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 10, borderBottomWidth: 1 },
  title:      { flex: 1, fontSize: 17, fontWeight: '700' },
  searchWrap: { flexDirection: 'row', alignItems: 'center', margin: 12, marginBottom: 6, paddingHorizontal: 10 },
  searchInput:{ flex: 1, paddingVertical: 11, fontSize: 14 },
  item:       { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, paddingVertical: 13, gap: 12 },
  itemSel:    { backgroundColor: 'rgba(30,156,240,0.08)' },
  flag:       { fontSize: 24, width: 32, textAlign: 'center' },
  name:       { flex: 1, fontSize: 15 },
  dial:       { fontSize: 14, fontWeight: '600' },
});
