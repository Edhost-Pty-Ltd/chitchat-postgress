// ─── Screen: Sign In ─────────────────────────────────────────────────────────
//
// Design:
//   • Full glass-effect screen — no hero gradient bar, no orb bubble
//   • App logo (chitchat-logo.png) centred at the top, no text taglines
//   • Country-code picker + local number input → 6-digit OTP
//   • Companion-device linking: shows a 256-bit QR the signed-in device scans
//
// QR rendering uses react-native-qrcode-svg (native SVG, no DOM, works in RN).
// The company logo is embedded in the centre of the QR code with ECC level H
// so the code still decodes reliably even with the logo overlay.
//
// COMPANION NOTE
//   The companion keeps its anonymous Firebase Auth session ALIVE after
//   linking. That session is what gives the companion a Firebase Auth uid,
//   which the rules use (via companionLinks/{anonUid}) to authorise reads
//   and writes on the owner's behalf. Do NOT sign it out.
//
import React, { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Image,
  StyleSheet, ScrollView, KeyboardAvoidingView,
  Platform, ActivityIndicator, Modal, FlatList, Dimensions,
  Pressable, // Added Pressable
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import QRCode from 'react-native-qrcode-svg';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { RootStackParamList } from '../types';
import { useAuth as useAuthContext } from '../context/AuthContext';
import { useAuth } from '../hooks/useAuth';
import { COUNTRIES, DEFAULT_COUNTRY, Country, formatPhoneNumber } from '../data/countryCodes';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppBg, AppText, AppIcon, useGlass } from '../context/ThemeContext';
import {
  createLinkRequest,
  pollForApproval,
  LinkRequest,
} from '../hooks/useLinkedDevices';

// ─── QR helpers ───────────────────────────────────────────────────────────────
const QR_SIZE = Math.min(Dimensions.get('window').width - 80, 240);
// Logo covers ~20% of QR area. ECC level H tolerates ~30% data loss, so this
// keeps a comfortable safety margin. Do not exceed 0.25 without bumping ECC.
const QR_LOGO_SIZE = Math.round(QR_SIZE * 0.20);

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
  const { signIn: signInToContext, signInAsCompanion } = useAuthContext();
  const { sendOTP, verifyOTP, error: authError } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'SignIn'>>();
  const insets = useSafeAreaInsets();

  const { bevel } = useGlass();

  const [step, setStep] = useState<Step>('phone');
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [localNumber, setLocalNumber] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [otp, setOtp] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [resendTimer, setResendTimer] = useState(0);

  // ── Companion device state ────────────────────────────────────────────────
  const [companionMode,      setCompanionMode]      = useState<'qr' | null>(null);
  const [companionRequest,   setCompanionRequest]   = useState<LinkRequest | null>(null);
  const [companionLinking,   setCompanionLinking]   = useState(false);
  const [companionError,     setCompanionError]     = useState<string | null>(null);
  const [companionApproved,  setCompanionApproved]  = useState(false);
  const companionPollCleanup = useRef<(() => void) | null>(null);

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
      const success = await verifyOTP(code);
      if (success) {
        try {
          await signInToContext(fullNumber);
          setLoading(false);
        } catch (contextError: any) {
          setErrorMsg(contextError.message || 'Failed to complete sign-in. Please try again.');
          setLoading(false);
        }
      } else {
        setErrorMsg(authError || 'Incorrect code. Please try again.');
        setOtp('');
        otpInputRef.current?.focus();
        setLoading(false);
      }
    } catch (err: any) {
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

  // ── Companion device handlers ─────────────────────────────────────────────
  const openCompanionQr = async () => {
    companionPollCleanup.current?.();

    setCompanionError(null);
    setCompanionApproved(false);
    setCompanionLinking(false);
    setCompanionRequest(null);
    setCompanionMode('qr');

    const req = await createLinkRequest();
    if (!req) {
      setCompanionError('Could not start the link request. Please check your connection and try again.');
      return;
    }
    setCompanionRequest(req);

        companionPollCleanup.current = pollForApproval(
      req.requestId,
      async ({ ownerUid, customToken }) => {
        setCompanionLinking(true);
        try {
          // Sign in with the custom token the primary minted for us.
          // After this, auth.uid IS the owner's uid — no more anon session.
          await signInAsCompanion(ownerUid, customToken);
          setCompanionApproved(true);
          setTimeout(() => setCompanionMode(null), 1500);
        } catch {
          setCompanionError('Device was linked, but sign-in failed. Please try again.');
          setCompanionLinking(false);
        }
      },
      () => {
        setCompanionError('QR code expired. Tap "Show QR Code" to generate a new one.');
      },
    );
  };

  const closeCompanionModal = () => {
    try {
      if (companionPollCleanup.current) {
        companionPollCleanup.current();
      }
    } catch (e) {
      console.warn('Error during poll cleanup:', e);
    }
    companionPollCleanup.current = null;
    setCompanionMode(null);
    setCompanionRequest(null);
    setCompanionError(null);
    setCompanionApproved(false);
    setCompanionLinking(false);
  };

  React.useEffect(() => {
    return () => { companionPollCleanup.current?.(); };
  }, []);

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

          {/* ── Link as companion device ── */}
          {step === 'phone' && (
            <View style={styles.companionSection}>
              <View style={styles.companionDivider}>
                <View style={styles.companionDividerLine} />
                <AppText style={styles.companionDividerText}>or</AppText>
                <View style={styles.companionDividerLine} />
              </View>

              <AppText style={styles.companionTitle}>Link as Companion Device</AppText>
              <AppText style={styles.companionSubtitle}>
                Already signed in on another device? Show a QR code and scan it from the device that's already signed in.
              </AppText>

              {companionError && (
                <View style={styles.companionError}>
                  <AppIcon name="alert-circle" size={15} color={COLORS.missed} fixedColor />
                  <AppText style={styles.companionErrorText} fixedColor>{companionError}</AppText>
                </View>
              )}

              <View style={styles.companionButtons}>
                {/* Show QR — new device generates and displays it */}
                <TouchableOpacity
                  style={[styles.companionBtn, bevel]}
                  activeOpacity={0.8}
                  disabled={companionLinking}
                  onPress={openCompanionQr}
                >
                  <LinearGradient colors={GRADIENTS.primary} style={styles.companionBtnIcon}>
                    <AppIcon name="qr-code-outline" size={20} color="#fff" fixedColor />
                  </LinearGradient>
                  <View style={{ flex: 1 }}>
                    <AppText style={styles.companionBtnTitle}>Show QR Code</AppText>
                    <AppText style={styles.companionBtnSub}>Scan from your signed-in device</AppText>
                  </View>
                  <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />
                </TouchableOpacity>
              </View>
            </View>
          )}

        </SafeAreaView>
      </View>

      {/* ── QR display modal ── */}
      {companionMode === 'qr' && (
        <Modal visible animationType="slide" onRequestClose={closeCompanionModal} statusBarTranslucent={true}>
          <View style={{ flex: 1 }}>
            <LinearGradient colors={GRADIENTS.bg} style={StyleSheet.absoluteFill} />
            
            {/* Using insets.top ensures the header is ALWAYS below the notch/status bar */}
            <View style={{ flex: 1, paddingTop: insets.top }}>
              
              {/* Header - Fixed touch issues */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 16 }}>
                <Pressable
                  onPress={closeCompanionModal}
                  hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
                  style={({ pressed }) => [
                    styles.modalBackBtn,
                    pressed && { opacity: 0.7 }
                  ]}
                >
                  {/* pointerEvents="none" prevents the icon from swallowing the press */}
                  <View pointerEvents="none">
                    <AppIcon name="chevron-back" size={24} color={COLORS.blue} fixedColor />
                  </View>
                </Pressable>
                <AppText style={{ flex: 1, textAlign: 'center', fontSize: 18, fontWeight: '700', color: COLORS.text }}>
                  Link This Device
                </AppText>
                <View style={{ width: 44 }} />
              </View>

              <ScrollView contentContainerStyle={{ alignItems: 'center', paddingHorizontal: 24, paddingBottom: insets.bottom + 24, paddingTop: 8 }}>

                {companionApproved ? (
                  /* ── Success state ── */
                  <View style={{ alignItems: 'center', gap: 16, paddingTop: 60 }}>
                    <View style={{ width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(34,197,94,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                      <AppIcon name="checkmark-circle" size={52} color={COLORS.green} fixedColor />
                    </View>
                    <AppText style={{ fontSize: 22, fontWeight: '800', color: COLORS.text, textAlign: 'center' }}>
                      Device Linked!
                    </AppText>
                    <AppText style={{ fontSize: 15, color: COLORS.sub, textAlign: 'center', lineHeight: 22 }}>
                      Opening your inbox…
                    </AppText>
                    <ActivityIndicator size="small" color={COLORS.blue} style={{ marginTop: 8 }} />
                  </View>
                ) : companionLinking ? (
                  /* ── Linking in progress ── */
                  <View style={{ alignItems: 'center', gap: 16, paddingTop: 60 }}>
                    <ActivityIndicator size="large" color={COLORS.blue} />
                    <AppText style={{ fontSize: 17, fontWeight: '600', color: COLORS.text }}>Linking device…</AppText>
                    <AppText style={{ fontSize: 13, color: COLORS.sub }}>Just a moment</AppText>
                  </View>
                ) : (
                  /* ── Waiting for scan ── */
                  <>
                    {/* Step instructions - Improved padding, contrast, and alignment */}
                    <View style={[bevel, { borderRadius: 16, paddingHorizontal: 20, paddingVertical: 16, marginBottom: 24, width: '100%', backgroundColor: 'rgba(255, 255, 255, 0.85)' }]}>
                      <AppText style={{ fontSize: 14, fontWeight: '700', color: COLORS.text, marginBottom: 12 }}>
                        On your signed-in device:
                      </AppText>
                      {[
                        'Settings  →  Linked Devices & Team',
                        'Tap the  +  button',
                        'Choose  Scan QR Code  or  Enter Code',
                        'Scan this QR or type the code below',
                      ].map((step, i) => (
                        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: COLORS.blue, alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <AppText style={{ fontSize: 12, fontWeight: '800', color: '#fff' }} fixedColor>{i+1}</AppText>
                          </View>
                          <AppText style={{ flex: 1, fontSize: 14, color: COLORS.text, lineHeight: 20 }}>{step}</AppText>
                        </View>
                      ))}
                    </View>

                    {/* QR code */}
                    {companionRequest && (
                      <>
                        {/* Increased padding around QR code */}
                        <View style={[styles.qrFrame, { marginBottom: 24 }]}>
                          {/* NOTE: To fix the black square behind the logo, you MUST replace 
                              chitchat-logo.png with a transparent PNG version. */}
                          <QRCode
                            value={`chitchat://link/${companionRequest.requestId}`}
                            size={QR_SIZE}
                            ecl="H"
                            color="#000000"
                            backgroundColor="#FFFFFF"
                            quietZone={8}
                            logo={require('../../assets/chitchat-logo.png')}
                            logoSize={QR_LOGO_SIZE}
                            logoBackgroundColor="#FFFFFF"
                            logoBorderRadius={16} // Increased for smoother corners
                            logoMargin={8} // Increased to give the logo more breathing room
                          />
                        </View>

                        {/* 10-char human-typable code */}
                        <AppText style={{ fontSize: 12, fontWeight: '700', color: COLORS.sub, letterSpacing: 1.5, marginBottom: 12 }}>
                          OR USE THIS CODE INSTEAD
                        </AppText>
                        <View style={[styles.qrCodeDisplay, { marginBottom: 32 }]}>
                          <AppText style={styles.qrCodeDisplayText}>
                            {companionRequest.displayCode.slice(0, 5)}-{companionRequest.displayCode.slice(5, 10)}
                          </AppText>
                        </View>
                      </>
                    )}

                    {/* Waiting indicator */}
                    {companionError ? (
                      <View style={styles.companionError}>
                        <AppIcon name="alert-circle" size={15} color={COLORS.missed} fixedColor />
                        <AppText style={styles.companionErrorText} fixedColor>{companionError}</AppText>
                        <Pressable
                          onPress={openCompanionQr}
                          hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
                        >
                          <AppText pointerEvents="none" style={{ color: COLORS.blue, fontWeight: '700', fontSize: 13 }}>Refresh</AppText>
                        </Pressable>
                      </View>
                    ) : (
                      <View style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          <ActivityIndicator size="small" color={COLORS.blue} />
                          <AppText style={{ color: COLORS.sub, fontSize: 14 }}>Waiting for your other device…</AppText>
                        </View>
                        <AppText style={{ color: COLORS.sub, fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                          Code expires in 10 minutes
                        </AppText>
                      </View>
                    )}
                  </>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
      )}

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
    backgroundColor: 'rgba(30,156,240,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  otpBoxFilled: {
    borderColor: COLORS.blue,
    backgroundColor: 'rgba(30,156,240,0.12)',
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

  // ── Companion device section ──────────────────────────────────────────────
  companionSection: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    paddingTop: 4,
  },
  companionDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
    marginTop: 4,
  },
  companionDividerLine: { flex: 1, height: 1, backgroundColor: COLORS.border },
  companionDividerText: { fontSize: 12, color: COLORS.sub, fontWeight: '600' },
  companionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 6,
    textAlign: 'center',
  },
  companionSubtitle: {
    fontSize: 13,
    color: COLORS.sub,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: 16,
  },
  companionError: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(232,67,67,0.10)',
    borderRadius: RADIUS.sm,
    padding: 10,
    marginBottom: 12,
  },
  companionErrorText: { flex: 1, fontSize: 13, color: COLORS.missed },
  companionButtons: { gap: 10 },
  companionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  companionBtnIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    ...SHADOW.button,
  },
  companionBtnTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  companionBtnSub:   { fontSize: 12, color: COLORS.sub, marginTop: 1 },

  // ── QR display modal ──────────────────────────────────────────────────────
  modalBackBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.9)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
    zIndex: 10, // Ensure it's on top of any overlapping views
  },
  qrFrame: {
    borderRadius: 20, // Slightly larger radius for a softer look
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    padding: 16, // Increased padding to give the QR code breathing room
    ...SHADOW.card,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
  },
  qrCodeDisplay: {
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: RADIUS.md,
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.20)',
    // marginBottom removed here as it's added inline for specific spacing
  },
  qrCodeDisplayText: {
    fontSize: 24, // Slightly larger
    fontWeight: '800',
    letterSpacing: 5, // More breathing room between characters
    color: COLORS.text,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
  },
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
  itemSelected: { backgroundColor: 'rgba(30,156,240,0.08)' },

  flag: { fontSize: 24, width: 32, textAlign: 'center' },
  countryName: { flex: 1, fontSize: 15, color: COLORS.text },
  dialCode: { fontSize: 14, fontWeight: '600', color: COLORS.sub },
  check: { marginLeft: 4 },

  sep: { height: 1, backgroundColor: COLORS.border, marginLeft: 64 },
  empty: { textAlign: 'center', color: COLORS.sub, marginTop: 40, fontSize: 14 },
});