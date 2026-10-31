// ─── Admin-assisted agent registration ───────────────────────────────────────
// This is intentionally NOT self-liveness enrollment. A business owner or
// admin confirms the agent is present and consents, captures or selects one
// face image, and sends it directly to Django under a signed one-time grant.
// Django stores only an encrypted embedding; neither this component nor Node
// stores the raw image.

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { AppBg, AppIcon, AppText, useForeground, useGlass, useTypography } from '../context/ThemeContext';
import { COLORS, GRADIENTS, RADIUS, SHADOW } from '../types/theme';
import {
  agentApi,
  enrollAdminAssistedAgentFace,
  type AgentFaceGrantResponse,
  type TeamAgent,
} from '../api/agentApi';
import { disposeCameraFile } from '../utils/disposeCameraFile';
import { validateImage } from '../utils/validationUtils';
import {
  enrollFaceFromBase64,
  FaceAICode,
  isFaceAIModuleAvailable,
  isValidFaceFeature,
  removeLocalFaceFeature,
} from '../sdk/faceAI';

interface Props {
  visible: boolean;
  businessId: string;
  /** Set when a previously provisioned agent needs a fresh face upload. */
  existingAgent?: TeamAgent | null;
  onClose: () => void;
  onSaved: () => void;
}

const FACE_ERROR_COPY: Record<string, string> = {
  empty_feature: 'No saved face feature was produced. Take or choose a clear face image to finish enrollment.',
  bad_feature: 'The face feature returned by the SDK was invalid. Please take the photo again.',
  agent_grant_expired: 'The enrollment request expired. Request a fresh one and try again.',
  agent_grant_used: 'That enrollment request was already used. Request a fresh one and try again.',
  agent_grant_invalid: 'The enrollment request is not valid for this account.',
  already_enrolled: 'This agent already has an encrypted face reference.',
  service_unavailable: 'The face service is temporarily unavailable. Try again shortly.',
};

/**
 * Extract a 1024-char reference feature from the selected photo using the SDK.
 *
 * The feature is written into the SDK's local store under a throwaway id so
 * nothing lingers on the manager's device after upload. The server owns the
 * durable reference for the actual agent.
 */
async function extractAgentFaceFeature(imageUri: string): Promise<string | null> {
  if (!isFaceAIModuleAvailable()) return null;
  const tempId = `admin-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    // Normalize the picked photo before the SDK reads it. The contextual
    // ImageManipulator (SDK 57) re-renders UPRIGHT pixels, baking in EXIF
    // orientation — camera/library photos are frequently rotated, and the SDK's
    // still-image detector misses an otherwise clear face when it is sideways.
    // It also returns base64 directly, so we avoid expo-file-system, whose main
    // entry no longer exposes readAsStringAsync on SDK 54+ (it moved to
    // 'expo-file-system/legacy'); calling it here threw and surfaced as the
    // misleading "could not read face" error.
    const context = ImageManipulator.manipulate(imageUri);
    context.resize({ width: 1080 });
    const rendered = await context.renderAsync();
    const output = await rendered.saveAsync({
      base64: true,
      compress: 0.9,
      format: SaveFormat.JPEG,
    });
    if (!output.base64) return null;
    const result = await enrollFaceFromBase64(tempId, output.base64);
    if (result.code !== FaceAICode.VERIFY_SUCCESS || !isValidFaceFeature(result.faceFeature)) {
      return null;
    }
    return result.faceFeature;
  } catch (err) {
    console.warn('[AgentRegistration] face feature extraction failed:', err);
    return null;
  } finally {
    // Best effort: forget the throwaway id so the manager's device has no
    // residual biometric reference after the upload succeeds or fails.
    void removeLocalFaceFeature(tempId).catch(() => {});
  }
}

function normalizeE164(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits ? `+${digits}` : '';
}

export default function AgentRegistrationSheet({
  visible,
  businessId,
  existingAgent,
  onClose,
  onSaved,
}: Props) {
  const { FG } = useForeground();
  const { textColor, fontFamily } = useTypography();
  const { bevel } = useGlass();
  const isRetry = !!existingAgent;

  const [firstName, setFirstName] = useState(existingAgent?.firstName ?? '');
  const [surname, setSurname] = useState(existingAgent?.surname ?? '');
  const [phoneNumber, setPhoneNumber] = useState(existingAgent?.phoneNumber ?? '');
  const [faceUri, setFaceUri] = useState<string | null>(null);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pendingCompletion, setPendingCompletion] = useState<{
    agent: TeamAgent;
    receipt: string;
  } | null>(null);

  useEffect(() => {
    if (!visible) return;
    setFirstName(existingAgent?.firstName ?? '');
    setSurname(existingAgent?.surname ?? '');
    setPhoneNumber(existingAgent?.phoneNumber ?? '');
    setFaceUri(null);
    setConsentConfirmed(false);
    setSubmitting(false);
    setPendingCompletion(null);
  }, [existingAgent, visible]);

  useEffect(() => () => disposeCameraFile(faceUri), [faceUri]);

  const selectFace = useCallback(async (source: 'camera' | 'library') => {
    try {
      const permission = source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          'Permission needed',
          source === 'camera'
            ? 'Allow camera access to capture the agent’s face image.'
            : 'Allow photo-library access to choose the agent’s face image.',
        );
        return;
      }

      const result = source === 'camera'
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'] as any,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.85,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'] as any,
            allowsEditing: true,
            aspect: [1, 1],
            quality: 0.85,
          });
      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      if (asset.fileSize != null && asset.mimeType) {
        const valid = validateImage(asset.fileSize, asset.mimeType);
        if (!valid.valid) {
          disposeCameraFile(asset.uri);
          Alert.alert('Invalid face image', valid.error ?? 'Choose a JPEG or PNG image.');
          return;
        }
      }
      setFaceUri((previous) => {
        disposeCameraFile(previous);
        return asset.uri;
      });
    } catch {
      Alert.alert('Could not select image', 'Try taking or choosing the face image again.');
    }
  }, []);

  const completeReceipt = useCallback(async (agent: TeamAgent, receipt: string) => {
    const result = await agentApi.completeFaceEnrollment(businessId, agent.agentId, receipt);
    if (!result.ok) {
      setPendingCompletion({ agent, receipt });
      Alert.alert(
        'Face saved — finish setup later if needed',
        'The encrypted face embedding was stored, but the business dashboard could not be updated yet. Retry now, or close this sheet and use “Finish face enrollment” from the agent dashboard later.',
      );
      return false;
    }
    setPendingCompletion(null);
    onSaved();
    Alert.alert(
      'Agent registered',
      `${agent.displayName} is now part of your team. They can sign in on their own phone with ${agent.phoneNumber ?? 'their registered number'} to receive a normal SMS verification code and view their agent dashboard.`,
    );
    onClose();
    return true;
  }, [businessId, onClose, onSaved]);

  const submit = useCallback(async () => {
    if (submitting || pendingCompletion) return;
    const normalizedPhone = normalizeE164(phoneNumber);
    if (!isRetry && (!firstName.trim() || !surname.trim())) {
      Alert.alert('Missing details', 'Enter the agent’s first name and surname.');
      return;
    }
    if (!isRetry && !/^\+[1-9]\d{6,14}$/.test(normalizedPhone)) {
      Alert.alert('Invalid phone number', 'Enter the agent phone number in international format, for example +27821234567.');
      return;
    }
    if (!faceUri) {
      Alert.alert('Face image required', 'Take or choose one clear image of the agent’s face.');
      return;
    }
    if (!consentConfirmed) {
      Alert.alert('Consent required', 'Confirm that the agent is present and has agreed to this encrypted face enrollment.');
      return;
    }

    setSubmitting(true);
    let grantResponse: AgentFaceGrantResponse | null = null;
    try {
      if (isRetry && existingAgent) {
        const grant = await agentApi.requestFaceGrant(businessId, existingAgent.agentId);
        if (!grant.ok) throw new Error(grant.error.message);
        grantResponse = grant.data;
      } else {
        const created = await agentApi.createAgent(businessId, {
          firstName: firstName.trim(),
          surname: surname.trim(),
          phoneNumber: normalizedPhone,
          consentConfirmed: true,
        });
        if (!created.ok) throw new Error(created.error.message);
        grantResponse = created.data;
      }

      const feature = await extractAgentFaceFeature(faceUri);
      if (!feature) {
        Alert.alert(
          'Could not read face',
          'The SDK could not extract a face feature from that image. Use a clear, well-lit photo with only the agent in frame.',
        );
        return;
      }
      const enrolled = await enrollAdminAssistedAgentFace(
        grantResponse.enrollmentGrant,
        feature,
      );
      // The raw face image is no longer needed once Django has handled the
      // request, success or failure. It must not remain in the app cache.
      disposeCameraFile(faceUri);
      setFaceUri(null);
      if (!enrolled.ok) {
        const copy = FACE_ERROR_COPY[enrolled.error] ?? 'The agent face could not be enrolled. Request a fresh grant and try again.';
        Alert.alert('Could not enroll face', copy);
        return;
      }
      await completeReceipt(grantResponse.agent, enrolled.receipt);
    } catch (err) {
      Alert.alert(
        isRetry ? 'Could not restart enrollment' : 'Could not add agent',
        err instanceof Error ? err.message : 'Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  }, [businessId, completeReceipt, consentConfirmed, existingAgent, faceUri, firstName, isRetry, pendingCompletion, phoneNumber, submitting, surname]);

  const retryCompletion = useCallback(async () => {
    if (!pendingCompletion || submitting) return;
    setSubmitting(true);
    try {
      await completeReceipt(pendingCompletion.agent, pendingCompletion.receipt);
    } finally {
      setSubmitting(false);
    }
  }, [completeReceipt, pendingCompletion, submitting]);

  const reconcileSavedEnrollment = useCallback(async () => {
    if (!isRetry || !existingAgent || submitting) return;
    setSubmitting(true);
    try {
      const grant = await agentApi.requestFaceGrant(businessId, existingAgent.agentId);
      if (!grant.ok) throw new Error(grant.error.message);
      // No feature is supplied. Django will return a fresh completion receipt
      // only if an immutable profile for this exact signed target already
      // exists.
      const reconciled = await enrollAdminAssistedAgentFace(grant.data.enrollmentGrant);
      if (!reconciled.ok) {
        const copy = FACE_ERROR_COPY[reconciled.error] ?? 'No saved face enrollment could be confirmed. Take a face photo to continue.';
        Alert.alert('Could not finish from saved enrollment', copy);
        return;
      }
      await completeReceipt(grant.data.agent, reconciled.receipt);
    } catch (err) {
      Alert.alert('Could not check saved enrollment', err instanceof Error ? err.message : 'Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [businessId, completeReceipt, existingAgent, isRetry, submitting]);

  const close = useCallback(() => {
    if (submitting) return;
    disposeCameraFile(faceUri);
    setFaceUri(null);
    setPendingCompletion(null);
    onClose();
  }, [faceUri, onClose, submitting]);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <SafeAreaView style={styles.root}>
        <AppBg />
        <View style={[styles.header, { borderBottomColor: FG.glassBorder, backgroundColor: FG.glassBg }]}>
          <TouchableOpacity onPress={close} disabled={submitting} style={styles.closeButton}>
            <AppIcon name="close" size={22} color={COLORS.blue} />
          </TouchableOpacity>
          <AppText style={[styles.title, { color: textColor, fontFamily }]}>
            {isRetry ? 'Finish face enrollment' : 'Add team agent'}
          </AppText>
          <View style={styles.headerSpacer} />
        </View>

        <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <View style={[styles.notice, bevel]}>
              <AppIcon name="shield-outline" size={20} color="#92400E" fixedColor />
              <View style={styles.noticeCopy}>
                <AppText style={[styles.noticeTitle, { color: textColor }]}>Administrator-assisted enrollment</AppText>
                <AppText style={[styles.noticeText, { color: FG.secondary }]}>
                  Liveness and anti-spoofing are not run in this flow. The image is processed once to create an encrypted face embedding; the original photo is discarded.
                </AppText>
              </View>
            </View>

            {!isRetry ? (
              <>
                <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>AGENT DETAILS</AppText>
                <View style={[styles.row, bevel]}>
                  <AppIcon name="person-outline" size={19} color={COLORS.blue} />
                  <TextInput
                    value={firstName}
                    onChangeText={setFirstName}
                    placeholder="First name"
                    placeholderTextColor={COLORS.textFaint}
                    style={[styles.input, { color: textColor }]}
                    autoCapitalize="words"
                  />
                </View>
                <View style={[styles.row, bevel]}>
                  <AppIcon name="person-outline" size={19} color={COLORS.blue} />
                  <TextInput
                    value={surname}
                    onChangeText={setSurname}
                    placeholder="Surname"
                    placeholderTextColor={COLORS.textFaint}
                    style={[styles.input, { color: textColor }]}
                    autoCapitalize="words"
                  />
                </View>
                <View style={[styles.row, bevel]}>
                  <AppIcon name="call-outline" size={19} color={COLORS.blue} />
                  <TextInput
                    value={phoneNumber}
                    onChangeText={setPhoneNumber}
                    placeholder="Phone number, e.g. +27821234567"
                    placeholderTextColor={COLORS.textFaint}
                    style={[styles.input, { color: textColor }]}
                    keyboardType="phone-pad"
                    autoCapitalize="none"
                  />
                </View>
                <AppText style={[styles.helpText, { color: FG.secondary }]}>The agent will later sign in on their own phone using this number and the normal Firebase SMS code.</AppText>
              </>
            ) : (
              <View style={[styles.agentSummary, bevel]}>
                <AppIcon name="person-circle-outline" size={34} color={COLORS.blue} />
                <View style={styles.flex}>
                  <AppText style={[styles.agentName, { color: textColor }]}>{existingAgent?.displayName}</AppText>
                  <AppText style={[styles.helpText, { color: FG.secondary }]}>{existingAgent?.phoneNumber ?? 'Registered agent'}</AppText>
                </View>
              </View>
            )}

            <AppText style={[styles.sectionLabel, { color: FG.secondary }]}>FACE IMAGE</AppText>
            <View style={[styles.faceCard, bevel]}>
              {faceUri ? (
                <Image source={{ uri: faceUri }} style={styles.facePreview} />
              ) : (
                <View style={styles.facePlaceholder}>
                  <AppIcon name="scan-outline" size={42} color={COLORS.blue} />
                  <AppText style={[styles.helpText, { color: FG.secondary }]}>One clear face only</AppText>
                </View>
              )}
              <View style={styles.faceButtons}>
                <TouchableOpacity style={styles.outlineButton} onPress={() => selectFace('camera')} disabled={submitting || !!pendingCompletion}>
                  <AppIcon name="camera-outline" size={18} color={COLORS.blue} />
                  <AppText style={styles.outlineButtonText}>Take photo</AppText>
                </TouchableOpacity>
                <TouchableOpacity style={styles.outlineButton} onPress={() => selectFace('library')} disabled={submitting || !!pendingCompletion}>
                  <AppIcon name="images-outline" size={18} color={COLORS.blue} />
                  <AppText style={styles.outlineButtonText}>Choose photo</AppText>
                </TouchableOpacity>
              </View>
              {isRetry ? (
                <TouchableOpacity style={styles.reconcileButton} onPress={reconcileSavedEnrollment} disabled={submitting || !!pendingCompletion}>
                  <AppIcon name="shield-checkmark-outline" size={18} color={COLORS.blue} />
                  <AppText style={styles.reconcileText}>Finish using saved encrypted face</AppText>
                </TouchableOpacity>
              ) : null}
            </View>

            <TouchableOpacity
              style={[styles.consentRow, bevel, consentConfirmed && styles.consentSelected]}
              onPress={() => setConsentConfirmed((value) => !value)}
              disabled={submitting || !!pendingCompletion}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: consentConfirmed }}
            >
              <AppIcon name={consentConfirmed ? 'checkbox' : 'square-outline'} size={23} color={consentConfirmed ? COLORS.blue : FG.secondary} />
              <AppText style={[styles.consentText, { color: textColor }]}>I confirm this agent is present, has agreed to join this company, and has consented to their face being converted into an encrypted biometric template.</AppText>
            </TouchableOpacity>

            {pendingCompletion ? (
              <>
                <TouchableOpacity style={styles.primaryWrap} onPress={retryCompletion} disabled={submitting}>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.primaryButton}>
                    {submitting ? <ActivityIndicator color="#fff" /> : <><AppIcon name="refresh-outline" size={19} color="#fff" fixedColor /><AppText fixedColor style={styles.primaryText}>Retry finish</AppText></>}
                  </LinearGradient>
                </TouchableOpacity>
                <TouchableOpacity style={styles.finishLater} onPress={close} disabled={submitting}>
                  <AppText style={styles.finishLaterText}>Close and finish later</AppText>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity style={[styles.primaryWrap, submitting && styles.disabled]} onPress={submit} disabled={submitting}>
                <LinearGradient colors={GRADIENTS.primary} style={styles.primaryButton}>
                  {submitting ? <ActivityIndicator color="#fff" /> : <><AppIcon name="person-add-outline" size={19} color="#fff" fixedColor /><AppText fixedColor style={styles.primaryText}>{isRetry ? 'Enroll encrypted face' : 'Register agent'}</AppText></>}
                </LinearGradient>
              </TouchableOpacity>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  header: { minHeight: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderBottomWidth: 1 },
  closeButton: { width: 38, height: 38, justifyContent: 'center', alignItems: 'center' },
  headerSpacer: { width: 38 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '800' },
  scroll: { padding: 16, gap: 11, paddingBottom: 38 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, borderRadius: RADIUS.lg, padding: 14, backgroundColor: 'rgba(245,158,11,0.10)' },
  noticeCopy: { flex: 1 },
  noticeTitle: { fontSize: 14, fontWeight: '800', marginBottom: 3 },
  noticeText: { fontSize: 12.5, lineHeight: 18 },
  sectionLabel: { marginTop: 8, fontSize: 10.5, fontWeight: '800', letterSpacing: 1 },
  row: { minHeight: 54, paddingHorizontal: 14, borderRadius: RADIUS.md, flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { flex: 1, fontSize: 15, paddingVertical: 12 },
  helpText: { fontSize: 12.5, lineHeight: 18 },
  agentSummary: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: RADIUS.md },
  agentName: { fontSize: 16, fontWeight: '800' },
  faceCard: { borderRadius: RADIUS.lg, padding: 14, alignItems: 'center', gap: 12 },
  facePreview: { width: 150, height: 150, borderRadius: 75, borderWidth: 2, borderColor: COLORS.blue },
  facePlaceholder: { width: 150, height: 150, borderRadius: 75, justifyContent: 'center', alignItems: 'center', gap: 6, backgroundColor: 'rgba(9,178,238,0.10)' },
  faceButtons: { width: '100%', flexDirection: 'row', gap: 10 },
  outlineButton: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: RADIUS.md, borderWidth: 1, borderColor: COLORS.blue },
  outlineButtonText: { color: COLORS.blue, fontSize: 13, fontWeight: '700' },
  consentRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 14, borderRadius: RADIUS.md },
  consentSelected: { backgroundColor: 'rgba(9,178,238,0.08)' },
  consentText: { flex: 1, fontSize: 12.5, lineHeight: 18 },
  reconcileButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderColor: COLORS.blue, borderRadius: RADIUS.md },
  reconcileText: { color: COLORS.blue, fontSize: 13, fontWeight: '800' },
  finishLater: { alignItems: 'center', paddingVertical: 8 },
  finishLaterText: { color: COLORS.blue, fontSize: 13, fontWeight: '700' },
  primaryWrap: { marginTop: 8, borderRadius: RADIUS.md, overflow: 'hidden' },
  primaryButton: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: RADIUS.md, ...SHADOW.button },
  primaryText: { fontSize: 15, fontWeight: '800', color: '#fff' },
  disabled: { opacity: 0.45 },
});
