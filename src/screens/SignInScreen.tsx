// ─── Screen: Sign In ─────────────────────────────────────────────────────────
//
// Design:
//   • Full glass-effect screen — no hero gradient bar, no orb bubble
//   • App logo (icon.png) centred at the top, no text taglines
//   • Country-code picker + local number input → 6-digit OTP
//
// Stub behaviour (swap sendOtp / verifyOtp for your real backend):
//   • Any phone number is accepted
//   • Code "123456" always passes
//
import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Image,
  StyleSheet, ScrollView, KeyboardAvoidingView,
  Platform, ActivityIndicator, Modal, FlatList,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList } from '../types';
import { useAuth as useAuthContext } from '../context/AuthContext';
import { useAuth } from '../hooks/useAuth';
import { COUNTRIES, DEFAULT_COUNTRY, Country, formatPhoneNumber } from '../data/countryCodes';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppBg, AppText, AppIcon, useGlass } from '../context/ThemeContext';

// ─── Stub API helpers ─────────────────────────────────────────────────────────
// Removed - now using Firebase Phone Authentication via useAuth hook

// ─── Country Picker Modal ─────────────────────────────────────────────────────

interface CountryPickerProps {
  visible: boolean;
  selected: Country;
  onSelect: (c: Country) => void;
  onClose: () => void;
}

function CountryPicker({ visible, selected, onSelect, onClose }: CountryPickerProps) {
  const [query, setQuery] = useState('');
  const { bevel } = useGlass();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.dial.includes(q) ||
        c.code.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <SafeAreaView style={picker.root}>
        <AppBg />

        {/* Header */}
        <View style={picker.header}>
          <AppText style={picker.title}>Select Country</AppText>
          <TouchableOpacity onPress={onClose} style={picker.closeBtn}>
            <AppIcon name="close" size={22} color={COLORS.text} />
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View style={[picker.searchWrap, bevel]}>
          <AppIcon name="search-outline" size={16} color={COLORS.sub} style={picker.searchIcon} />
          <TextInput
            style={picker.searchInput}
            placeholder="Search country or code…"
            placeholderTextColor={COLORS.textFaint}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
        </View>

        {/* List */}
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.code}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const isSelected = item.code === selected.code;
            return (
              <TouchableOpacity
                style={[picker.item, isSelected && picker.itemSelected]}
                onPress={() => { onSelect(item); onClose(); setQuery(''); }}
                activeOpacity={0.7}
              >
                <AppText style={picker.flag}>{item.flag}</AppText>
                <AppText style={picker.countryName}>{item.name}</AppText>
                <AppText style={picker.dialCode}>+{item.dial}</AppText>
                {isSelected && (
                  <AppIcon name="checkmark" size={16} color={COLORS.blue} fixedColor style={picker.check} />
                )}
              </TouchableOpacity>
            );
          }}
          ItemSeparatorComponent={() => <View style={picker.sep} />}
          ListEmptyComponent={
            <AppText style={picker.empty}>No countries found.</AppText>
          }
        />
      </SafeAreaView>
    </Modal>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

type Step = 'phone' | 'otp';

export default function SignInScreen() {
  const { signIn: signInToContext } = useAuthContext();
  const { sendOTP, verifyOTP, error: authError } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'SignIn'>>();

  const { bevel } = useGlass();

  const [step, setStep] = useState<Step>('phone');
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [localNumber, setLocalNumber] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [resendTimer, setResendTimer] = useState(0);

  const otpInputRef = useRef<TextInput>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const rawDigits = localNumber.replace(/\D/g, '');
  const formatted = formatPhoneNumber(rawDigits, country.groups);
  const fullNumber = `+${country.dial}${rawDigits}`;

  // ── Resend countdown ──────────────────────────────────────────────────────

  const startResendTimer = () => {
    setResendTimer(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setResendTimer((t) => {
        if (t <= 1) { clearInterval(timerRef.current!); return 0; }
        return t - 1;
      });
    }, 1000);
  };

  // ── Step 1: Send OTP ──────────────────────────────────────────────────────

  const handleSendOtp = async () => {
    const digits = localNumber.replace(/\D/g, '');
    if (digits.length < country.digits) {
      setErrorMsg(`Enter a ${country.digits}-digit number for ${country.name}.`);
      return;
    }
    setErrorMsg('');
    setLoading(true);
    try {
      const success = await sendOTP(fullNumber);
      if (success) {
        setStep('otp');
        startResendTimer();
      } else {
        setErrorMsg(authError || 'Failed to send code. Please try again.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to send code. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Step 2: Verify OTP ────────────────────────────────────────────────────

  const handleVerifyOtp = async () => {
    const code = otp;
    if (code.length < 6) { setErrorMsg('Enter all 6 digits.'); return; }
    setErrorMsg('');
    setLoading(true);
    try {
      console.log('[SignInScreen] Verifying OTP code...');
      const success = await verifyOTP(code);
      console.log('[SignInScreen] verifyOTP result:', success);
      
      if (success) {
        console.log('[SignInScreen] OTP verified, signing in to context...');
        // Update the context with phone number for session management
        try {
          await signInToContext(fullNumber);
          console.log('[SignInScreen] Sign-in to context successful');

          // No manual navigation here: AppNavigator switches to the
          // authenticated stack reactively once isSignedIn + profileExists are
          // resolved. Manually resetting to 'Chats' fails here because that
          // route isn't registered while the unauthenticated stack is active.
          setLoading(false);
        } catch (contextError: any) {
          console.error('[SignInScreen] Error signing in to context:', contextError);
          setErrorMsg(contextError.message || 'Failed to complete sign-in. Please try again.');
          setLoading(false);
        }
      } else {
        console.log('[SignInScreen] OTP verification failed:', authError);
        setErrorMsg(authError || 'Incorrect code. Please try again.');
        setOtp('');
        otpInputRef.current?.focus();
        setLoading(false);
      }
    } catch (err: any) {
      console.error('[SignInScreen] Exception during verification:', err);
      setErrorMsg(err.message || 'Verification failed. Please try again.');
      setLoading(false);
    }
  };

  // ── OTP input helper ──────────────────────────────────────────────────────
  const handleOtpChange = (text: string) => {
    const digits = text.replace(/\D/g, '').slice(0, 6);
    setOtp(digits);
    if (digits.length === 6) handleVerifyOtp();
  };

  const handleResend = async () => {
    if (resendTimer > 0) return;
    setOtp('');
    setErrorMsg('');
    setLoading(true);
    try {
      const success = await sendOTP(fullNumber);
      if (success) {
        startResendTimer();
      } else {
        setErrorMsg(authError || 'Failed to resend. Please try again.');
      }
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to resend. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      {/* Full-screen wrapper so gradient fills behind status bar */}
      <View style={styles.rootFull}>
        <LinearGradient colors={GRADIENTS.bg} style={StyleSheet.absoluteFill} />

        <SafeAreaView style={styles.root} edges={['top', 'left', 'right', 'bottom']}>
          <KeyboardAvoidingView
            style={styles.root}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            <ScrollView
              contentContainerStyle={styles.scroll}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
            {/* ── Logo block ── */}
            <View style={styles.logoSection}>
              <Image
                source={require('../../assets/chitchat-logo.png')}
                style={styles.logoImage}
                resizeMode="contain"
              />
            </View>

            {/* ── Sign-in card ── */}
            <View style={[styles.card, bevel]}>

              {step === 'phone' ? (
                <>
                  <AppText style={styles.cardTitle}>Sign In</AppText>
                  <AppText style={styles.cardSub}>
                    Enter your phone number to receive a verification code.
                  </AppText>

                  {/* Phone row */}
                  <View style={styles.phoneRow}>
                    {/* Tappable flag — no box, no chevron */}
                    <TouchableOpacity style={styles.flagBtn} onPress={() => setPickerOpen(true)} activeOpacity={0.65}>
                      <AppText style={styles.dialFlag}>{country.flag}</AppText>
                    </TouchableOpacity>

                    {/* Dial code + number input in one bevel container */}
                    <View style={[styles.inputWrap, styles.inputFlex, bevel]}>
                      <AppText style={styles.dialCodePrefix}>+{country.dial}</AppText>
                      <View style={styles.dialDivider} />
                      <TextInput
                        style={styles.input}
                        placeholder={Array(country.digits + 1).join('0').replace(/(\d{3})(\d{3})(\d+)/, '$1 $2 $3')}
                        placeholderTextColor={COLORS.textFaint}
                        keyboardType="phone-pad"
                        autoComplete="tel"
                        textContentType="telephoneNumber"
                        value={formatted}
                        onChangeText={(t) => {
                          const digits = t.replace(/\D/g, '').slice(0, country.digits);
                          setLocalNumber(digits);
                          setErrorMsg('');
                        }}
                        returnKeyType="done"
                        onSubmitEditing={handleSendOtp}
                      />
                    </View>
                  </View>

                  {rawDigits.length > 0 && (
                    <AppText style={styles.previewText}>Will send to: {fullNumber}</AppText>
                  )}
                  {errorMsg ? <AppText style={styles.error}>{errorMsg}</AppText> : null}

                  <TouchableOpacity onPress={handleSendOtp} activeOpacity={0.85} disabled={loading}>
                    <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtn}>
                      {loading ? <ActivityIndicator color="#fff" /> : <AppText style={styles.primaryBtnText} fixedColor>Send Code</AppText>}
                    </LinearGradient>
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity style={styles.backRow} onPress={() => { setStep('phone'); setErrorMsg(''); setOtp(''); }}>
                    <AppIcon name="chevron-back" size={18} color={COLORS.blue} fixedColor />
                    <AppText style={styles.backText}>Change number</AppText>
                  </TouchableOpacity>

                  <AppText style={styles.cardTitle}>Verify Code</AppText>
                  <AppText style={styles.cardSub}>
                    We sent a 6-digit code to{'\n'}
                    <AppText style={styles.phoneHighlight}>{fullNumber}</AppText>
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

                  {errorMsg ? <AppText style={styles.error}>{errorMsg}</AppText> : null}

                  <TouchableOpacity onPress={handleVerifyOtp} activeOpacity={0.85} disabled={loading}>
                    <LinearGradient colors={GRADIENTS.primary} style={styles.primaryBtn}>
                      {loading ? <ActivityIndicator color="#fff" /> : <AppText style={styles.primaryBtnText} fixedColor>Verify</AppText>}
                    </LinearGradient>
                  </TouchableOpacity>

                  <View style={styles.resendRow}>
                    <AppText style={styles.resendLabel}>Didn't receive a code? </AppText>
                    <TouchableOpacity onPress={handleResend} disabled={resendTimer > 0}>
                      <AppText style={[styles.resendLink, resendTimer > 0 && styles.resendLinkDisabled]}>
                        {resendTimer > 0 ? `Resend in ${resendTimer}s` : 'Resend'}
                      </AppText>
                    </TouchableOpacity>
                  </View>

                  <View style={[styles.hintBox, bevel]}>
                    <AppIcon name="information-circle-outline" size={15} color={COLORS.sub} />
                    <AppText style={styles.hintText}>
                      Enter the 6-digit code sent to your phone
                    </AppText>
                  </View>
                </>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>

          {/* ── Create account link — mobile only, below the card ── */}
          {step === 'phone' && Platform.OS !== 'web' && (
            <View style={styles.createAccountRow}>
              <AppText style={styles.createAccountText}>Don't have an account? </AppText>
              <TouchableOpacity onPress={() => navigation.navigate('CreateAccount')} activeOpacity={0.8}>
                <AppText style={styles.createAccountLink}>Create one</AppText>
              </TouchableOpacity>
            </View>
          )}

        </SafeAreaView>
      </View>

      <CountryPicker
        visible={pickerOpen}
        selected={country}
        onSelect={setCountry}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  rootFull: { flex: 1 },  // wraps everything, gradient fills behind status bar
  root:     { flex: 1 },  // SafeAreaView + KeyboardAvoidingView

  scroll: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 48,
  },

  // ── Logo ──────────────────────────────────────────────────────────────────
  logoSection: {
    alignItems: 'center',
    marginBottom: 28,
  },
  logoImage: {
    width: 200,
    height: 200,
    borderRadius: 40,
    // Clip the dark JPEG corners
    overflow: 'hidden',
  },

  // ── Card ──────────────────────────────────────────────────────────────────
  card: {
    borderRadius: RADIUS.xl,
    padding: 22,
  },
  cardTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 6,
  },
  cardSub: {
    fontSize: 13,
    color: COLORS.sub,
    marginBottom: 20,
    lineHeight: 19,
  },

  // ── Phone input row ───────────────────────────────────────────────────────
  phoneRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 8,
    alignItems: 'stretch',
  },

  // Tappable flag — no box, just the emoji
  flagBtn: {
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialFlag: { fontSize: 26 },

  // Dial code inside the input container
  dialCodePrefix: {
    fontSize: 15,
    fontWeight: '600',
    color: COLORS.text,
    paddingLeft: 12,
    paddingRight: 6,
  },
  dialDivider: {
    width: 1,
    height: 20,
    backgroundColor: COLORS.border,
    marginRight: 2,
  },

  inputWrap: {
    borderRadius: RADIUS.md,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  inputFlex: { flex: 1, marginBottom: 0 },
  input: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 13,
    fontSize: 15,
    color: COLORS.text,
  },

  previewText: {
    fontSize: 11,
    color: COLORS.sub,
    marginBottom: 8,
    fontStyle: 'italic',
  },

  error: {
    fontSize: 13,
    color: COLORS.missed,
    marginBottom: 10,
    marginTop: 2,
  },

  primaryBtn: {
    borderRadius: RADIUS.md,
    paddingVertical: 15,
    alignItems: 'center',
    ...SHADOW.button,
    marginTop: 4,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  // ── OTP step ──────────────────────────────────────────────────────────────
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  backText: { fontSize: 13, color: COLORS.blue, fontWeight: '600', marginLeft: 2 },

  phoneHighlight: { fontWeight: '700', color: COLORS.text },

  otpRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 6,
    marginBottom: 16,
  },
  otpBox: {
    width: 46,
    height: 54,
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(9,178,238,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  otpBoxFilled: {
    borderColor: COLORS.blue,
    backgroundColor: 'rgba(9,178,238,0.12)',
  },
  otpBoxFocused: {
    borderColor: COLORS.blue,
    borderWidth: 2,
  },
  otpHiddenInput: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
  otpDigitText: {
    fontSize: 20,
    fontWeight: '700',
    color: COLORS.text,
    lineHeight: 24,
    includeFontPadding: false,
  } as any,
  otpCaret: {
    width: 2,
    height: 20,
    backgroundColor: COLORS.blue,
    borderRadius: 1,
  },

  resendRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 16 },
  resendLabel: { fontSize: 13, color: COLORS.sub },
  resendLink: { fontSize: 13, color: COLORS.blue, fontWeight: '700' },
  resendLinkDisabled: { color: COLORS.textFaint },

  hintBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 14,
    padding: 10,
    borderRadius: RADIUS.sm,
  },
  hintText: { fontSize: 12, color: COLORS.sub },

  createAccountRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 12,
  },
  createAccountText: { fontSize: 14, color: COLORS.sub },
  createAccountLink: { fontSize: 14, color: COLORS.blue, fontWeight: '700' },
});

// ─── Picker Styles ────────────────────────────────────────────────────────────

const picker = StyleSheet.create({
  root: { flex: 1, overflow: 'hidden' },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  title: { flex: 1, fontSize: 17, fontWeight: '700', color: COLORS.text },
  closeBtn: { padding: 4 },

  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    marginBottom: 6,
    borderRadius: RADIUS.md,
    paddingHorizontal: 10,
  },
  searchIcon: { marginRight: 6 },
  searchInput: { flex: 1, paddingVertical: 11, fontSize: 14, color: COLORS.text },

  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 13,
    gap: 12,
  },
  itemSelected: { backgroundColor: 'rgba(9,178,238,0.08)' },

  flag: { fontSize: 24, width: 32, textAlign: 'center' },
  countryName: { flex: 1, fontSize: 15, color: COLORS.text },
  dialCode: { fontSize: 14, fontWeight: '600', color: COLORS.sub },
  check: { marginLeft: 4 },

  sep: { height: 1, backgroundColor: COLORS.border, marginLeft: 64 },
  empty: { textAlign: 'center', color: COLORS.sub, marginTop: 40, fontSize: 14 },
});
