// ─── Screen: Create Account ──────────────────────────────────────────────────
// Mobile only. Collects business details (name, phone, email, website)
// + optional logo → OTP → biometric check.
import React, { useState, useRef, useMemo, useEffect } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
  Alert,
  Modal,
  FlatList,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';

// Platform-specific import for native-only modules
let LocalAuthentication: any = null;
if (Platform.OS !== 'web') {
  try {
    LocalAuthentication = require('expo-local-authentication');
  } catch (err) {
    console.warn('[CreateAccountScreen] expo-local-authentication not available:', err);
  }
} else {
  LocalAuthentication = {
    authenticateAsync: () => Promise.resolve({ success: false }),
    hasHardwareAsync: () => Promise.resolve(false),
    isEnrolledAsync: () => Promise.resolve(false),
    supportedAuthenticationTypesAsync: () => Promise.resolve([]),
    AuthenticationType: { FACIAL_RECOGNITION: 1, FINGERPRINT: 2 },
  };
}

import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../context/AuthContext';
import { useRegistration } from '../hooks/useRegistration';
import { setBiometricEnabled } from '../utils/biometrics';
import { COLORS, RADIUS, SHADOW, GRADIENTS, GLASS } from '../types/theme';
import { RootStackParamList } from '../types';
import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  Country,
  formatPhoneNumber,
} from '../data/countryCodes';
import { validateUsername, validatePhone, validateImage } from '../utils/validationUtils';
import { AvatarPreview } from '../components/AvatarPreview';
import { AppBg, AppText, AppIcon, useForeground, useGlass } from '../context/ThemeContext';

type NavProp = NativeStackNavigationProp<RootStackParamList, 'CreateAccount'>;
type Step = 'details' | 'otp' | 'biometric';

// ─── Biometric helper ─────────────────────────────────────────────────────────
async function runBiometric(): Promise<{ success: boolean; message: string }> {
  try {
    if (!LocalAuthentication) {
      return { success: true, message: 'no_module' };
    }
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return { success: true, message: 'no_hardware' };

    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!enrolled) return { success: true, message: 'not_enrolled' }; // skip gracefully

    const types =
      (await LocalAuthentication.supportedAuthenticationTypesAsync?.()) ?? [];
    const isFace =
      LocalAuthentication.AuthenticationType &&
      types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION);

    const promptMsg = isFace ? 'Confirm with Face ID' : 'Confirm with fingerprint';

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: promptMsg,
      fallbackLabel: 'Use PIN',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });

    return { success: result.success, message: result.success ? 'ok' : 'failed' };
  } catch (err) {
    console.warn('[runBiometric] unexpected error:', err);
    return { success: true, message: 'error_skip' }; // don't block on unexpected errors
  }
}

// ─── Country Picker ───────────────────────────────────────────────────────────
function CountryPicker({
  visible,
  selected,
  onSelect,
  onClose,
}: {
  visible: boolean;
  selected: Country;
  onSelect: (c: Country) => void;
  onClose: () => void;
}) {
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
        <View style={picker.header}>
          <AppText style={picker.title}>Select Country</AppText>
          <TouchableOpacity onPress={onClose}>
            <AppIcon name="close" size={22} color={COLORS.text} />
          </TouchableOpacity>
        </View>
        <View style={[picker.searchWrap, bevel]}>
          <AppIcon
            name="search-outline"
            size={16}
            color={COLORS.sub}
            style={{ marginRight: 6 }}
          />
          <TextInput
            style={picker.searchInput}
            placeholder="Search…"
            placeholderTextColor={COLORS.textFaint}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
          />
        </View>
        <FlatList
          data={filtered}
          keyExtractor={(i) => i.code}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const sel = item.code === selected.code;
            return (
              <TouchableOpacity
                style={[picker.item, sel && picker.itemSelected]}
                onPress={() => {
                  onSelect(item);
                  onClose();
                  setQuery('');
                }}
                activeOpacity={0.7}
              >
                <AppText style={picker.flag}>{item.flag}</AppText>
                <AppText style={picker.countryName}>{item.name}</AppText>
                <AppText style={picker.dialCode}>+{item.dial}</AppText>
                {sel && (
                  <AppIcon
                    name="checkmark"
                    size={16}
                    color={COLORS.blue}
                    fixedColor
                  />
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

export default function CreateAccountScreen() {
  const navigation = useNavigation<NavProp>();
  const { signIn, setDisplayName, setAvatarUri } = useAuth();
  const {
    registrationStep,
    error: hookError,
    isLoading: hookLoading,
    submitRegistration,
    verifyOTP,
    resendOTP,
    resendCount,
    canResend,
    createProfile,
    retryProfileCreation,
    proceedWithoutPhoto,
  } = useRegistration();
  const { bevel } = useGlass();
  const { FG } = useForeground();

  const [step, setStep] = useState<Step>('details');
  const [name, setName] = useState('');
  const [country, setCountry] = useState<Country>(DEFAULT_COUNTRY);
  const [localNumber, setLocalNumber] = useState('');
  const [avatarUri, setLocalAvatar] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [nameError, setNameError] = useState('');
  const [resendTimer, setResendTimer] = useState(0);

  // Business-specific fields
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState('');

  const otpRefs = useRef<Array<TextInput | null>>([
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Resend countdown ──────────────────────────────────────────────────────
  const startResendTimer = () => {
    setResendTimer(60);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setResendTimer((t) => {
        if (t <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          return 0;
        }
        return t - 1;
      });
    }, 1000);
  };

  // Sync hook error to local errorMsg for display
  useEffect(() => {
    if (hookError) setErrorMsg(hookError);
  }, [hookError]);

  // Watch registrationStep to transition screen to 'otp' on successful OTP send
  useEffect(() => {
    if (registrationStep === 'otp' && step === 'details') {
      setStep('otp');
      startResendTimer();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registrationStep]);

  // When profile creation completes successfully, sign in and let AppNavigator
  // reactively switch to the authenticated stack.
  useEffect(() => {
    if (registrationStep !== 'done') return;
    let cancelled = false;
    (async () => {
      try {
        await signIn(fullNumber);
        await setDisplayName(name.trim());
        if (avatarUri) await setAvatarUri(avatarUri);
      } catch (err: any) {
        console.error('[CreateAccount] post-registration sign-in failed:', err);
        if (!cancelled) {
          setErrorMsg(
            err?.message ?? 'Signed in, but profile setup failed. Please restart the app.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registrationStep]);

  const rawDigits = localNumber.replace(/\D/g, '');
  const formatted = formatPhoneNumber(rawDigits, country.groups);
  const fullNumber = `+${country.dial}${rawDigits}`;

  // ── Photo pick ────────────────────────────────────────────────────────────
  const pickPhoto = async () => {
    if (Platform.OS !== 'web') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(
          'Permission needed',
          'Allow photo library access to set a profile picture.',
        );
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      const fileSize = asset.fileSize;
      const mimeType = asset.mimeType ?? '';
      if (fileSize != null && mimeType) {
        const validation = validateImage(fileSize, mimeType);
        if (!validation.valid) {
          Alert.alert('Invalid Image', validation.error!);
          return;
        }
      }
      setLocalAvatar(asset.uri);
    }
  };

  // ── Step 1: Send OTP ──────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!name.trim()) {
      setErrorMsg('Please enter your business name.');
      return;
    }
    if (rawDigits.length < country.digits) {
      setErrorMsg(
        `Enter a ${country.digits}-digit number for ${country.name}.`,
      );
      return;
    }
    setErrorMsg('');
    try {
      await submitRegistration(name.trim(), fullNumber, avatarUri, {
        email: email.trim() || undefined,
        website: website.trim() || undefined,
      });
      // Screen transition handled by useEffect watching registrationStep
    } catch (err: any) {
      console.error('[CreateAccount] submitRegistration threw:', err);
      setErrorMsg(err?.message ?? 'Failed to send code. Please try again.');
    }
  };

  // ── Step 2: Verify OTP → biometric ──────────────────────────────────────
  const handleVerify = async () => {
    const code = otp.join('');
    if (code.length < 6) {
      setErrorMsg('Enter all 6 digits.');
      return;
    }
    setErrorMsg('');
    try {
      const ok = await verifyOTP(code);
      if (ok) {
        // verifyOTP only confirms the code — profile creation happens in the
        // biometric step so the Firestore write happens exactly once.
        setStep('biometric');
      } else if (!hookError) {
        setErrorMsg('Incorrect code. Please try again.');
        setOtp(['', '', '', '', '', '']);
        otpRefs.current[0]?.focus();
      } else {
        setOtp(['', '', '', '', '', '']);
        otpRefs.current[0]?.focus();
      }
    } catch (err: any) {
      console.error('[CreateAccount] verifyOTP threw:', err);
      setErrorMsg(err?.message ?? 'Verification failed. Please try again.');
    }
  };

  // ── Step 3: Biometric → create profile ─────────────────────────────────
  const handleBiometric = async () => {
    setLoading(true);
    try {
      const { success, message } = await runBiometric();
      if (success) {
        if (message === 'ok') {
          await setBiometricEnabled(true);
        }
        await createProfile();
      } else {
        Alert.alert(
          'Authentication failed',
          'Biometric check did not pass. Please try again.',
          [
            { text: 'Try Again', onPress: handleBiometric },
            { text: 'Cancel', style: 'cancel' },
          ],
        );
      }
    } catch (err: any) {
      console.error('[CreateAccount] handleBiometric error:', err);
      setErrorMsg(err?.message ?? 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── OTP helpers ───────────────────────────────────────────────────────────
  const handleOtpChange = (text: string, i: number) => {
    const digit = text.replace(/\D/g, '').slice(-1);
    const next = [...otp];
    next[i] = digit;
    setOtp(next);
    if (digit && i < 5) otpRefs.current[i + 1]?.focus();
    if (!digit && i > 0 && text === '') otpRefs.current[i - 1]?.focus();
  };

  const handleOtpKey = (key: string, i: number) => {
    if (key === 'Backspace' && !otp[i] && i > 0) {
      const next = [...otp];
      next[i - 1] = '';
      setOtp(next);
      otpRefs.current[i - 1]?.focus();
    }
  };

  const handleResend = async () => {
    if (resendTimer > 0 || !canResend) return;
    setOtp(['', '', '', '', '', '']);
    setErrorMsg('');
    try {
      const sent = await resendOTP();
      if (sent) startResendTimer();
    } catch (err: any) {
      console.error('[CreateAccount] resendOTP threw:', err);
      setErrorMsg(err?.message ?? 'Failed to resend code.');
    }
  };

  // Compute form validity for button state
  const isFormValid =
    validateUsername(name.trim()).valid && validatePhone(fullNumber);

  // Compute initials from business name for avatar placeholder
  const avatarInitials = name.trim()
    ? name
        .trim()
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : 'B';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <SafeAreaView
        style={styles.root}
        edges={['top', 'left', 'right', 'bottom']}
      >
        <KeyboardAvoidingView
          style={styles.root}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <LinearGradient
            colors={GRADIENTS.bg}
            style={StyleSheet.absoluteFill}
          />
          <ScrollView
            contentContainerStyle={styles.scroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* Sign in link for existing users */}
            <TouchableOpacity
              style={styles.backRow}
              onPress={() => navigation.navigate('SignIn')}
            >
              <AppIcon
                name="chevron-back"
                size={18}
                color={COLORS.blue}
                fixedColor
              />
              <AppText style={styles.backText}>Sign In</AppText>
            </TouchableOpacity>

            <View style={[styles.card, bevel]}>
              {step === 'details' ? (
                <>
                  <AppText style={styles.cardTitle}>Register Business</AppText>
                  <AppText style={styles.cardSub}>
                    Fill in your business details to get started.
                  </AppText>

                  {/* Logo — same style as ProfileScreen */}
                  <View style={styles.avatarSection}>
                    <TouchableOpacity
                      onPress={pickPhoto}
                      activeOpacity={0.85}
                      style={styles.avatarWrap}
                    >
                      {avatarUri ? (
                        <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
                      ) : (
                        <LinearGradient
                          colors={[COLORS.blue, COLORS.blueDark]}
                          style={styles.avatarPlaceholder}
                        >
                          <AppText fixedColor style={styles.avatarInitials}>
                            {avatarInitials}
                          </AppText>
                        </LinearGradient>
                      )}
                      <View style={styles.cameraBadge}>
                        <AppIcon
                          name="camera"
                          size={16}
                          color={COLORS.blue}
                          fixedColor
                        />
                      </View>
                    </TouchableOpacity>
                    <AppText style={[styles.avatarHint, { color: FG.secondary }]}>
                      Tap to add logo
                    </AppText>
                  </View>

                  {/* Business Name */}
                  <View style={[styles.inputWrap, bevel]}>
                    <View style={[styles.iconTile, { marginLeft: 8 }]}>
                      <AppIcon
                        name="business-outline"
                        size={18}
                        color={COLORS.blue}
                        fixedColor
                      />
                    </View>
                    <TextInput
                      style={styles.input}
                      placeholder="Business name"
                      placeholderTextColor={COLORS.textFaint}
                      value={name}
                      onChangeText={(t) => {
                        setName(t);
                        setErrorMsg('');
                        setNameError('');
                      }}
                      onBlur={() => {
                        const trimmed = name.trim();
                        if (trimmed.length > 0) {
                          const result = validateUsername(trimmed);
                          if (!result.valid) setNameError(result.error!);
                          else setNameError('');
                        } else {
                          setNameError('');
                        }
                      }}
                      autoCapitalize="words"
                      returnKeyType="next"
                    />
                  </View>
                  {nameError ? (
                    <AppText style={styles.error}>{nameError}</AppText>
                  ) : null}

                  {/* Phone */}
                  <View style={styles.phoneRow}>
                    <TouchableOpacity
                      style={styles.flagBtn}
                      onPress={() => setPickerOpen(true)}
                      activeOpacity={0.65}
                    >
                      <AppText style={styles.dialFlag}>{country.flag}</AppText>
                    </TouchableOpacity>
                    <View style={[styles.inputWrap, styles.inputFlex, bevel]}>
                      <AppText style={styles.dialCodePrefix}>
                        +{country.dial}
                      </AppText>
                      <View style={styles.dialDivider} />
                      <TextInput
                        style={styles.input}
                        placeholder="Phone number"
                        placeholderTextColor={COLORS.textFaint}
                        keyboardType="phone-pad"
                        value={formatted}
                        onChangeText={(t) => {
                          const d = t
                            .replace(/\D/g, '')
                            .slice(0, country.digits);
                          setLocalNumber(d);
                          setErrorMsg('');
                        }}
                        returnKeyType="next"
                      />
                    </View>
                  </View>

                  {/* Email (optional) */}
                  <View style={[styles.inputWrap, bevel]}>
                    <View style={[styles.iconTile, { marginLeft: 8 }]}>
                      <AppIcon
                        name="mail-outline"
                        size={18}
                        color={COLORS.blue}
                        fixedColor
                      />
                    </View>
                    <TextInput
                      style={styles.input}
                      placeholder="Email (optional)"
                      placeholderTextColor={COLORS.textFaint}
                      value={email}
                      onChangeText={setEmail}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="next"
                    />
                  </View>

                  {/* Website (optional) */}
                  <View style={[styles.inputWrap, bevel]}>
                    <View style={[styles.iconTile, { marginLeft: 8 }]}>
                      <AppIcon
                        name="globe-outline"
                        size={18}
                        color={COLORS.blue}
                        fixedColor
                      />
                    </View>
                    <TextInput
                      style={styles.input}
                      placeholder="Website (optional)"
                      placeholderTextColor={COLORS.textFaint}
                      value={website}
                      onChangeText={setWebsite}
                      keyboardType="url"
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="done"
                      onSubmitEditing={handleSend}
                    />
                  </View>

                  {errorMsg ? (
                    <AppText style={styles.error}>{errorMsg}</AppText>
                  ) : null}

                  <TouchableOpacity
                    onPress={handleSend}
                    activeOpacity={0.85}
                    disabled={hookLoading || !isFormValid}
                  >
                    <LinearGradient
                      colors={GRADIENTS.primary}
                      style={[
                        styles.primaryBtn,
                        !isFormValid && { opacity: 0.5 },
                      ]}
                    >
                      {hookLoading ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <AppText style={styles.primaryBtnText} fixedColor>
                          Send Verification Code
                        </AppText>
                      )}
                    </LinearGradient>
                  </TouchableOpacity>
                </>
              ) : step === 'otp' ? (
                <>
                  <TouchableOpacity
                    style={styles.backRow}
                    onPress={() => {
                      setStep('details');
                      setErrorMsg('');
                      setOtp(['', '', '', '', '', '']);
                    }}
                  >
                    <AppIcon
                      name="chevron-back"
                      size={18}
                      color={COLORS.blue}
                      fixedColor
                    />
                    <AppText style={styles.backText}>Change details</AppText>
                  </TouchableOpacity>
                  <AppText style={styles.cardTitle}>Verify Code</AppText>
                  <AppText style={styles.cardSub}>
                    We sent a 6-digit code to{'\n'}
                    <AppText style={styles.phoneHighlight}>{fullNumber}</AppText>
                  </AppText>

                  <View style={styles.otpRow}>
                    {otp.map((digit, i) => (
                      <TextInput
                        key={i}
                        ref={(el) => {
                          otpRefs.current[i] = el;
                        }}
                        style={[
                          styles.otpBox,
                          digit ? styles.otpBoxFilled : null,
                        ]}
                        value={digit}
                        onChangeText={(t) => handleOtpChange(t, i)}
                        onKeyPress={({ nativeEvent }) =>
                          handleOtpKey(nativeEvent.key, i)
                        }
                        keyboardType="number-pad"
                        maxLength={1}
                        textAlign="center"
                        selectTextOnFocus
                      />
                    ))}
                  </View>

                  {errorMsg ? (
                    <AppText style={styles.error}>{errorMsg}</AppText>
                  ) : null}

                  <TouchableOpacity
                    onPress={handleVerify}
                    activeOpacity={0.85}
                    disabled={hookLoading}
                  >
                    <LinearGradient
                      colors={GRADIENTS.primary}
                      style={styles.primaryBtn}
                    >
                      {hookLoading ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <AppText style={styles.primaryBtnText} fixedColor>
                          Verify Code
                        </AppText>
                      )}
                    </LinearGradient>
                  </TouchableOpacity>

                  <View style={styles.resendRow}>
                    <AppText style={styles.resendLabel}>
                      Didn't receive a code?{' '}
                    </AppText>
                    <TouchableOpacity
                      onPress={handleResend}
                      disabled={resendTimer > 0 || !canResend}
                    >
                      <AppText
                        style={[
                          styles.resendLink,
                          (resendTimer > 0 || !canResend) &&
                            styles.resendLinkDisabled,
                        ]}
                      >
                        {resendTimer > 0
                          ? `Resend in ${resendTimer}s`
                          : 'Resend'}
                      </AppText>
                    </TouchableOpacity>
                  </View>
                  {!canResend && (
                    <AppText style={styles.resendLimitMsg}>
                      Maximum resend attempts reached
                    </AppText>
                  )}
                </>
              ) : (
                /* Biometric step */
                <View style={styles.biometricWrap}>
                  {registrationStep === 'creating' ? (
                    <>
                      <ActivityIndicator
                        size="large"
                        color={COLORS.blue}
                        style={{ marginBottom: 20 }}
                      />
                      <AppText style={styles.cardTitle}>
                        Creating your profile...
                      </AppText>
                      <AppText style={styles.cardSub}>
                        Please wait while we set up your account.
                      </AppText>
                    </>
                  ) : registrationStep === 'error' ? (
                    <>
                      <View style={styles.biometricIcon}>
                        <AppIcon
                          name="alert-circle-outline"
                          size={70}
                          color={COLORS.missed}
                          fixedColor
                        />
                      </View>
                      <AppText style={styles.cardTitle}>
                        Profile Creation Failed
                      </AppText>
                      <AppText
                        style={[
                          styles.cardSub,
                          { textAlign: 'center', marginBottom: 16 },
                        ]}
                      >
                        {hookError ?? 'Something went wrong. Please try again.'}
                      </AppText>

                      <TouchableOpacity
                        onPress={retryProfileCreation}
                        activeOpacity={0.85}
                      >
                        <LinearGradient
                          colors={GRADIENTS.primary}
                          style={styles.primaryBtn}
                        >
                          <AppText style={styles.primaryBtnText} fixedColor>
                            Retry
                          </AppText>
                        </LinearGradient>
                      </TouchableOpacity>

                      {hookError &&
                        (hookError.toLowerCase().includes('upload') ||
                          hookError.toLowerCase().includes('photo') ||
                          hookError.toLowerCase().includes('storage')) && (
                          <TouchableOpacity
                            onPress={proceedWithoutPhoto}
                            activeOpacity={0.85}
                            style={{ marginTop: 12 }}
                          >
                            <View style={styles.secondaryBtn}>
                              <AppText style={styles.secondaryBtnText}>
                                Continue without photo
                              </AppText>
                            </View>
                          </TouchableOpacity>
                        )}

                      <TouchableOpacity
                        onPress={() => {
                          setStep('details');
                          setErrorMsg('');
                        }}
                        activeOpacity={0.85}
                        style={{ marginTop: 12 }}
                      >
                        <View style={styles.secondaryBtn}>
                          <AppText style={styles.secondaryBtnText}>
                            Change Phone Number
                          </AppText>
                        </View>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <View style={styles.biometricIcon}>
                        <AppIcon
                          name="finger-print"
                          size={70}
                          color={COLORS.blue}
                          fixedColor
                        />
                      </View>
                      <AppText style={styles.cardTitle}>
                        Two-Factor Verification
                      </AppText>
                      <AppText style={styles.cardSub}>
                        For your security, please verify your identity using{'\n'}
                        your device's biometrics.
                      </AppText>

                      {errorMsg ? (
                        <AppText style={styles.error}>{errorMsg}</AppText>
                      ) : null}

                      <TouchableOpacity
                        onPress={handleBiometric}
                        activeOpacity={0.85}
                        disabled={loading}
                      >
                        <LinearGradient
                          colors={GRADIENTS.primary}
                          style={styles.primaryBtn}
                        >
                          {loading ? (
                            <ActivityIndicator color="#fff" />
                          ) : (
                            <AppText style={styles.primaryBtnText} fixedColor>
                              Verify with Biometrics
                            </AppText>
                          )}
                        </LinearGradient>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      <CountryPicker
        visible={pickerOpen}
        selected={country}
        onSelect={setCountry}
        onClose={() => setPickerOpen(false)}
      />
    </>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 56,
    paddingBottom: 48,
  },
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
  backText: {
    fontSize: 13,
    color: COLORS.blue,
    fontWeight: '600',
    marginLeft: 2,
  },
  card: { borderRadius: RADIUS.xl, padding: 22 },
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

  // Avatar — matches ProfileScreen
  avatarSection: { alignItems: 'center', marginBottom: 20, gap: 10 },
  avatarWrap: { width: 110, height: 110, borderRadius: 55, ...SHADOW.glow },
  avatarImg: {
    width: 110,
    height: 110,
    borderRadius: 55,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.50)',
  },
  avatarPlaceholder: {
    width: 110,
    height: 110,
    borderRadius: 55,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.50)',
  },
  avatarInitials: { fontSize: 38, fontWeight: '800', color: '#fff' },
  cameraBadge: {
    position: 'absolute',
    bottom: 2,
    right: 2,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(180,225,245,0.22)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.45)',
    ...SHADOW.button,
  },
  avatarHint: { fontSize: 12, color: COLORS.sub },

  inputWrap: {
    borderRadius: RADIUS.md,
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  iconTile: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputIcon: { paddingLeft: 14 },
  inputFlex: { flex: 1, marginBottom: 0 },
  input: {
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 13,
    fontSize: 15,
    color: COLORS.text,
  },

  phoneRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 12,
    alignItems: 'stretch',
  },
  flagBtn: {
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialFlag: { fontSize: 26 },
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

  error: {
    fontSize: 13,
    color: COLORS.missed,
    marginBottom: 10,
    marginTop: -4,
  },
  primaryBtn: {
    borderRadius: RADIUS.md,
    paddingVertical: 15,
    alignItems: 'center',
    ...SHADOW.button,
    marginTop: 4,
  },
  primaryBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  secondaryBtn: {
    borderRadius: RADIUS.md,
    paddingVertical: 15,
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: COLORS.blue,
    backgroundColor: 'rgba(30,156,240,0.08)',
  },
  secondaryBtnText: { color: COLORS.blue, fontSize: 15, fontWeight: '700' },
  phoneHighlight: { fontWeight: '700', color: COLORS.text },

    otpRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
    gap: 8, // Ensures consistent spacing between boxes
  },
  otpBox: {
    flex: 1, // Makes boxes responsive to screen width
    maxWidth: 58, // Prevents boxes from getting too wide on tablets/large screens
    height: 58,
    borderRadius: 16, // More rounded corners matching the image
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.text,
    textAlign: 'center',
    textAlignVertical: 'center',  
    lineHeight: 58,  
    paddingVertical: 0,
    paddingHorizontal: 0,
    backgroundColor: '#e6f1fa',  
    borderWidth: 1,
    borderColor: 'transparent',  
  },
  otpBoxFilled: {
    backgroundColor: '#d0e8f9', 
    borderColor: COLORS.blue,  
  },

  resendRow: { flexDirection: 'row', justifyContent: 'center', marginTop: 16 },
  resendLabel: { fontSize: 13, color: COLORS.sub },
  resendLink: { fontSize: 13, color: COLORS.blue, fontWeight: '700' },
  resendLinkDisabled: { color: COLORS.textFaint },
  resendLimitMsg: {
    fontSize: 12,
    color: COLORS.missed,
    textAlign: 'center',
    marginTop: 8,
  },

  // Biometric step
  biometricWrap: { alignItems: 'center', paddingVertical: 10 },
  biometricIcon: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(30,156,240,0.12)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
    ...SHADOW.glow,
  },
});

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
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 12,
    marginBottom: 6,
    borderRadius: RADIUS.md,
    paddingHorizontal: 10,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 11,
    fontSize: 14,
    color: COLORS.text,
  },
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
  sep: { height: 1, backgroundColor: COLORS.border, marginLeft: 64 },
  empty: {
    textAlign: 'center',
    color: COLORS.sub,
    marginTop: 40,
    fontSize: 14,
  },
});