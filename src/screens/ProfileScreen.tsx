// ─── Screen: Profile ─────────────────────────────────────────────────────────
import React, { useRef, useState, useEffect } from 'react';
import {
  View, TouchableOpacity, StyleSheet, ScrollView,
  Image, Alert, Platform, TextInput, Modal,
  KeyboardAvoidingView, Switch, ActivityIndicator,
} from 'react-native';
import DatePicker from 'react-native-date-picker';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import firestore from '@react-native-firebase/firestore';
import { getAuth } from '@react-native-firebase/auth';
import { db } from '../config/firebase';
import { uploadFile, generateFileName } from '../config/storage';
import { useAuth } from '../context/AuthContext';
import { AppBg, AppText, AppIcon, useForeground, useTypography } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { CatalogItem } from '../types';
import { CatalogShareSheet } from '../components/CatalogShareSheet';

export default function ProfileScreen() {
  const navigation = useNavigation();
  const { phone, displayName, setDisplayName, avatarUri, setAvatarUri } = useAuth();
  const { FG }  = useForeground();
  const { fontFamily, textColor } = useTypography();
  const insets = useSafeAreaInsets();

  const [editingName, setEditingName] = useState(false);
  const [draftName,   setDraftName]   = useState(displayName || 'Demo Business');
  const nameInputRef = useRef<TextInput>(null);

  // Business fields
  const [email, setEmail] = useState('');
  const [auto_responder_message, setauto_responder_message] = useState('');
  const [autoResponderEnabled, setAutoResponderEnabled] = useState(false);
  const [autoResponderPending, setAutoResponderPending] = useState(false);
  const [draftAutoMessage, setDraftAutoMessage] = useState('');
  const [website, setWebsite] = useState('');
  const [editingField, setEditingField] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const fieldInputRef = useRef<TextInput>(null);

  // Work hours — structured
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  interface DaySchedule { open: string; close: string; }

  // Default to completely closed until the user sets their own schedule
  const defaultSchedule: Record<string, DaySchedule> = {
    Monday: { open: 'Closed', close: 'Closed' },
    Tuesday: { open: 'Closed', close: 'Closed' },
    Wednesday: { open: 'Closed', close: 'Closed' },
    Thursday: { open: 'Closed', close: 'Closed' },
    Friday: { open: 'Closed', close: 'Closed' },
    Saturday: { open: 'Closed', close: 'Closed' },
    Sunday: { open: 'Closed', close: 'Closed' },
  };

  const [workSchedule, setWorkSchedule] = useState<Record<string, DaySchedule>>(defaultSchedule);
  const [hoursModalOpen, setHoursModalOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<{ day: string; field: 'open' | 'close' } | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  // Single Date object drives the native drum-roll picker
  const [pickerDate, setPickerDate] = useState<Date>(() => {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    return d;
  });

  // Catalog
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemDesc, setNewItemDesc] = useState('');
  const [newItemImage, setNewItemImage] = useState<string | null>(null);
  const [uploadingCatalogImage, setUploadingCatalogImage] = useState(false);
  // Share sheet state — which item is pending share
  const [shareItem, setShareItem] = useState<CatalogItem | null>(null);

  const shownName = displayName || 'Demo Business';

  // ── Load business fields from Firestore ─────────────────────────────────────
  useEffect(() => {
    const loadProfile = async () => {
      try {
        const authInstance = getAuth();
        const currentUser = authInstance.currentUser;
        if (!currentUser) return;

        const fsDb = db as ReturnType<typeof firestore>;
        const userSnap = await fsDb.collection('users').doc(currentUser.uid).get();
        if (userSnap.exists()) {
          const data = userSnap.data()!;
          setEmail(data.email || '');
          setWebsite(data.website || '');
          setauto_responder_message(data.auto_responder_message || '');
          setAutoResponderEnabled(data.autoResponderEnabled || false);
          if (data.workSchedule) setWorkSchedule(data.workSchedule);
          setCatalog(data.catalog || []);
        }
      } catch (err) {
        console.warn('[ProfileScreen] Error loading profile:', err);
      }
    };
    loadProfile();
  }, []);

  // ── Save name ─────────────────────────────────────────────────────────────
  const saveName = async () => {
    const trimmed = draftName.trim();
    if (!trimmed) {
      setEditingName(false);
      return;
    }
    
    try {
      await setDisplayName(trimmed);
      
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({ displayName: trimmed });
      }
    } catch (error) {
      console.error('[ProfileScreen] Error saving displayName:', error);
    }
    
    setEditingName(false);
  };

  // ── Save a business field ──────────────────────────────────────────────────
  const saveField = async (field: string, value: string) => {
    try {
      if (field === 'email') setEmail(value);
      else if (field === 'website') setWebsite(value);
      else if (field === 'auto_responder_message') setauto_responder_message(value);

      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({ [field]: value });
      }
    } catch (error) {
      console.warn('[ProfileScreen] Error saving field:', error);
    }
    setEditingField(null);
  };

  // ── Auto Responder toggle (only starts a pending edit when turning ON) ─────
  const handleAutoResponderToggle = async (val: boolean) => {
    if (val) {
      // Begin pending edit. Do NOT persist yet — user must save with a message.
      setDraftAutoMessage(
        auto_responder_message ||
        'Thanks for your message! We are currently closed. We will get back to you as soon as we open.'
      );
      setAutoResponderPending(true);
      return;
    }

    // Turning OFF
    if (autoResponderPending) {
      // Cancel pending edit — nothing to persist.
      setAutoResponderPending(false);
      setDraftAutoMessage('');
      return;
    }

    // Was actually enabled → persist OFF.
    setAutoResponderEnabled(false);
    try {
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({ autoResponderEnabled: false });
      }
    } catch (error) {
      console.warn('[ProfileScreen] Error saving autoResponderEnabled:', error);
    }
  };

  // ── Save Auto Responder (message + enabled flag together) ─────────────────
  const saveAutoResponder = async () => {
    const msg = draftAutoMessage.trim();
    if (!msg) {
      Alert.alert(
        'Message required',
        'Please type the automatic reply message before saving. Otherwise, customers would receive empty replies.'
      );
      return;
    }

    // Optimistic local state
    setauto_responder_message(msg);
    setAutoResponderEnabled(true);
    setAutoResponderPending(false);

    try {
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({
          autoResponderEnabled: true,
          auto_responder_message: msg,
        });
      }
    } catch (error) {
      console.warn('[ProfileScreen] Error saving auto responder:', error);
    }
  };

  const cancelAutoResponder = () => {
    setAutoResponderPending(false);
    setDraftAutoMessage('');
  };

  // ── Save work schedule ─────────────────────────────────────────────────────
  const saveWorkSchedule = async (updated: Record<string, DaySchedule>) => {
    setWorkSchedule(updated);
    try {
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({ workSchedule: updated });
      }
    } catch (err) {
      console.warn('[ProfileScreen] Error saving work schedule:', err);
    }
  };

  // Convert a Date to a readable "H:MM AM/PM" string
  const formatPickerDate = (date: Date): string => {
    const h = date.getHours();
    const m = date.getMinutes();
    const period = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12;
    return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
  };

  const confirmTime = () => {
    if (!pickerTarget) return;
    const timeStr = formatPickerDate(pickerDate);
    const updated = { ...workSchedule };
    if (!updated[pickerTarget.day]) {
      updated[pickerTarget.day] = { open: '8:00 AM', close: '5:00 PM' };
    }
    updated[pickerTarget.day] = { ...updated[pickerTarget.day], [pickerTarget.field]: timeStr };
    setWorkSchedule(updated);
    setPickerVisible(false);
    setPickerTarget(null);
    saveWorkSchedule(updated);
  };

  const openTimePicker = (day: string, field: 'open' | 'close') => {
    setPickerTarget({ day, field });

    // Pre-seed the picker with the currently saved time for this slot
    const current = workSchedule[day]?.[field];
    const seed = new Date();
    if (current && current !== 'Closed') {
      const match = current.match(/^(\d+):(\d+)\s*(AM|PM)$/i);
      if (match) {
        const h12 = parseInt(match[1], 10);
        const min = parseInt(match[2], 10);
        const isPM = match[3].toUpperCase() === 'PM';
        const h24 = isPM ? (h12 === 12 ? 12 : h12 + 12) : (h12 === 12 ? 0 : h12);
        seed.setHours(h24, min, 0, 0);
      } else {
        seed.setHours(9, 0, 0, 0);
      }
    } else {
      seed.setHours(9, 0, 0, 0);
    }
    setPickerDate(seed);
    setPickerVisible(true);
  };

  // Format schedule summary for display
  const getScheduleSummary = (): string => {
    const openDays = DAYS.filter(d => workSchedule[d] && workSchedule[d].open !== 'Closed');
    if (openDays.length === 0) return 'Not set (All days closed)';
    if (openDays.length === 7) return `Every day ${workSchedule[openDays[0]].open} - ${workSchedule[openDays[0]].close}`;
    const first = openDays[0];
    const last = openDays[openDays.length - 1];
    return `${first.slice(0, 3)}-${last.slice(0, 3)} ${workSchedule[first].open} - ${workSchedule[first].close}`;
  };

  const startEditField = (field: string, currentValue: string) => {
    setEditingField(field);
    setDraftValue(currentValue);
    setTimeout(() => fieldInputRef.current?.focus(), 50);
  };

  // ── Catalog management ─────────────────────────────────────────────────────
  const pickItemImage = async () => {
    if (Platform.OS !== 'web') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Allow photo library access to add product images.');
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (!result.canceled && result.assets[0]) {
      setNewItemImage(result.assets[0].uri);
    }
  };

  const addCatalogItem = async () => {
    if (!newItemName.trim()) {
      Alert.alert('Required', 'Please enter a product/service name.');
      return;
    }

    try {
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;

      // ── Upload image to Firebase Storage if one was picked ──────────────
      let finalImageUri: string | null = newItemImage;
      if (newItemImage && currentUser) {
        setUploadingCatalogImage(true);
        try {
          const fileName = generateFileName('jpg');
          finalImageUri = await uploadFile(newItemImage, 'avatar', {
            userId: currentUser.uid,
            fileName: `catalog_${fileName}`,
          });
        } catch (uploadErr) {
          console.warn('[ProfileScreen] Catalog image upload failed, saving local URI:', uploadErr);
          // Fall back to local URI so the item is still saved
          finalImageUri = newItemImage;
        } finally {
          setUploadingCatalogImage(false);
        }
      }

      const newItem: CatalogItem = {
        id: Date.now().toString(),
        name: newItemName.trim(),
        price: newItemPrice.trim(),
        description: newItemDesc.trim() || undefined,
        imageUri: finalImageUri,
      };

      const updated = [...catalog, newItem];
      setCatalog(updated);
      setCatalogModalOpen(false);
      setNewItemName('');
      setNewItemPrice('');
      setNewItemDesc('');
      setNewItemImage(null);

      // Save to Firestore
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({ catalog: updated });
      }
    } catch (err) {
      console.warn('[ProfileScreen] Error saving catalog item:', err);
      setUploadingCatalogImage(false);
    }
  };

  const removeCatalogItem = async (id: string) => {
    const updated = catalog.filter(item => item.id !== id);
    setCatalog(updated);

    try {
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({ catalog: updated });
      }
    } catch (err) {
      console.warn('[ProfileScreen] Error removing catalog item:', err);
    }
  };

  // ── Pick photo ────────────────────────────────────────────────────────────
  const pickPhoto = async () => {
    if (Platform.OS !== 'web') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Allow photo library access to update your picture.');
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
      const uri = result.assets[0].uri;
      
      try {
        const authInstance = getAuth();
        const currentUser = authInstance.currentUser;
        
        if (!currentUser) {
          await setAvatarUri(uri);
          return;
        }
        
        const fsDb = db as ReturnType<typeof firestore>;
        const fileName = generateFileName('jpg');
        const downloadURL = await uploadFile(uri, 'avatar', {
          userId: currentUser.uid,
          fileName,
        }, (progress) => {
          console.log(`[ProfileScreen] Upload progress: ${progress}%`);
        });
        
        await setAvatarUri(uri);
        
        await fsDb.collection('users').doc(currentUser.uid).update({ photoURL: downloadURL });
      } catch (error: any) {
        console.error('[ProfileScreen] Error saving avatar:', error);
        // Still save local URI for demo mode
        await setAvatarUri(uri);
      }
    }
  };

  const initials = shownName.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);

  // ── Editable field card component ──────────────────────────────────────────
  const EditableField = ({ field, label, icon, value, placeholder, keyboardType ,isMultiline}: {
    field: string; label: string; icon: string; value: string; placeholder: string; keyboardType?: any;isMultiline?:boolean
  }) => (
    <TouchableOpacity
      style={styles.infoCard}
      activeOpacity={0.8}
      onPress={() => startEditField(field, value)}
    >
      <View style={styles.iconCircle}>
        <AppIcon name={icon as any} size={18} color={COLORS.blue} fixedColor />
      </View>
      <View style={styles.infoContent}>
        <AppText style={[styles.infoLabel, { fontFamily }]}>{label}</AppText>
        {editingField === field ? (
          <TextInput
            ref={fieldInputRef} 
            multiline={isMultiline}
            style={[styles.infoInput, { color: textColor, fontFamily }]}
            value={draftValue}
            onChangeText={setDraftValue}
            placeholder={placeholder}
            placeholderTextColor={COLORS.textFaint}
            returnKeyType="done"
            keyboardType={keyboardType}
            autoCapitalize="none"
            onSubmitEditing={() => saveField(field, draftValue)}
            onBlur={() => saveField(field, draftValue)}
            autoFocus
          />
        ) : (
          <AppText style={[styles.infoValue, { color: value ? textColor : COLORS.textFaint, fontFamily }]} numberOfLines={isMultiline ? 3 : 1}>
            {value || placeholder}
          </AppText>
        )}
      </View>
      {editingField === field ? (
        <TouchableOpacity onPress={() => saveField(field, draftValue)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <AppIcon name="checkmark-circle" size={22} fixedColor color={COLORS.blue} />
        </TouchableOpacity>
      ) : (
        <AppIcon name="create-outline" size={16} color={COLORS.sub} />
      )}
    </TouchableOpacity>
  );

  const showAutoResponderEditor = autoResponderEnabled || autoResponderPending;

  return (
    <View style={styles.root}>
      <AppBg />

      {/* Header */}
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <AppIcon name="chevron-back" size={22} color={COLORS.blue} fixedColor />
        </TouchableOpacity>
        <AppText style={[styles.headerTitle, { color: textColor, fontFamily }]}>Business Profile</AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >

        {/* ── Avatar ── */}
        <View style={styles.avatarSection}>
          <TouchableOpacity onPress={pickPhoto} activeOpacity={0.85} style={styles.avatarWrap}>
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
            ) : (
              <LinearGradient colors={[COLORS.blue, COLORS.blueDark]} style={styles.avatarPlaceholder}>
                <AppText fixedColor style={styles.avatarInitials}>{initials}</AppText>
              </LinearGradient>
            )}
            <View style={styles.cameraBadge}>
              <AppIcon name="camera" size={14} fixedColor color="#fff" />
            </View>
          </TouchableOpacity>
          <AppText style={[styles.tapHint, { color: FG.secondary, fontFamily }]}>
            Tap photo to change
          </AppText>
        </View>

        {/* ── Business Info ── */}
        <View style={styles.section}>
          <AppText style={[styles.sectionTitle, { color: COLORS.sub, fontFamily }]}>BUSINESS INFO</AppText>

          {/* Name */}
          <TouchableOpacity
            style={styles.infoCard}
            activeOpacity={0.8}
            onPress={() => {
              setDraftName(shownName);
              setEditingName(true);
              setTimeout(() => nameInputRef.current?.focus(), 50);
            }}
          >
            <View style={styles.iconCircle}>
              <AppIcon name="business-outline" size={18} color={COLORS.blue} fixedColor />
            </View>
            <View style={styles.infoContent}>
              <AppText style={[styles.infoLabel, { fontFamily }]}>Business Name</AppText>
              {editingName ? (
                <TextInput
                  ref={nameInputRef}
                  style={[styles.infoInput, { color: textColor, fontFamily }]}
                  value={draftName}
                  onChangeText={setDraftName}
                  returnKeyType="done"
                  onSubmitEditing={saveName}
                  onBlur={saveName}
                  autoFocus
                />
              ) : (
                <AppText style={[styles.infoValue, { color: textColor, fontFamily }]}>
                  {shownName}
                </AppText>
              )}
            </View>
            {editingName ? (
              <TouchableOpacity onPress={saveName} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <AppIcon name="checkmark-circle" size={22} fixedColor color={COLORS.blue} />
              </TouchableOpacity>
            ) : (
              <AppIcon name="create-outline" size={16} color={COLORS.sub} />
            )}
          </TouchableOpacity>

          {/* Phone */}
          <TouchableOpacity
            style={styles.infoCard}
            activeOpacity={0.8}
            onPress={() => navigation.navigate('ChangeNumber' as never)}
          >
            <View style={styles.iconCircle}>
              <AppIcon name="call-outline" size={18} color={COLORS.blue} fixedColor />
            </View>
            <View style={styles.infoContent}>
              <AppText style={[styles.infoLabel, { fontFamily }]}>Phone Number</AppText>
              <AppText style={[styles.infoValue, { color: textColor, fontFamily }]}>
                {phone || 'Not set'}
              </AppText>
            </View>
            <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />
          </TouchableOpacity>

          {/* Email */}
          <EditableField
            field="email"
            label="Email"
            icon="mail-outline"
            value={email}
            placeholder="Add email address"
            keyboardType="email-address"
          />
          
          {/* Website */}
          <EditableField
            field="website"
            label="Website"
            icon="globe-outline"
            value={website}
            placeholder="Add website URL"
            keyboardType="url"
          />

          {/* Work Hours — opens schedule modal */}
          <TouchableOpacity
            style={styles.infoCard}
            activeOpacity={0.8}
            onPress={() => setHoursModalOpen(true)}
          >
            <View style={styles.iconCircle}>
              <AppIcon name="time-outline" size={18} color={COLORS.blue} fixedColor />
            </View>
            <View style={styles.infoContent}>
              <AppText style={[styles.infoLabel, { fontFamily }]}>Work Hours</AppText>
              <AppText style={[styles.infoValue, { color: textColor, fontFamily }]}>
                {getScheduleSummary()}
              </AppText>
            </View>
            <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />
          </TouchableOpacity>
        </View>
        
        {/* ── Auto Responder Settings ── */}
        <View style={styles.section}>
          <AppText style={[styles.sectionTitle, { color: COLORS.sub, fontFamily }]}>AUTO RESPONDER</AppText>
          <View style={styles.infoCard}>
            <View style={styles.iconCircle}>
              <AppIcon name="chatbubble-ellipses-outline" size={18} color={COLORS.blue} fixedColor />
            </View>
            <View style={styles.infoContent}>
              <AppText style={[styles.infoLabel, { fontFamily }]}>Automatic Response</AppText>
              <AppText style={[styles.infoValue, { color: (autoResponderEnabled || autoResponderPending) ? COLORS.blue : COLORS.textFaint, fontFamily, fontSize: 13 }]}>
                {autoResponderPending
                  ? 'Add a message and save to enable'
                  : autoResponderEnabled
                    ? 'Replies during closed hours'
                    : 'Currently disabled'}
              </AppText>
            </View>
            <Switch
              value={autoResponderEnabled || autoResponderPending}
              onValueChange={handleAutoResponderToggle}
              trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.blue }}
              thumbColor={'#fff'}
            />
          </View>

          {showAutoResponderEditor && (
            <View style={styles.autoEditorCard}>
              <AppText style={[styles.infoLabel, { fontFamily, marginBottom: 6 }]}>
                Auto Reply Message
              </AppText>

              {autoResponderPending ? (
                // Pending edit — free text, save required
                <TextInput
                  style={[
                    styles.autoEditorInput,
                    { color: textColor, fontFamily },
                  ]}
                  value={draftAutoMessage}
                  onChangeText={setDraftAutoMessage}
                  placeholder="e.g. Thanks for your message! We are currently closed..."
                  placeholderTextColor={COLORS.textFaint}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                  autoFocus
                />
              ) : (
                // Already saved — allow quick inline edit via existing EditableField
                <EditableField
                  field="auto_responder_message"
                  label="Message"
                  icon="document-text-outline"
                  isMultiline={true}
                  value={auto_responder_message}
                  placeholder="No message set"
                  keyboardType="default"
                />
              )}

              {autoResponderPending && (
                <View style={styles.autoActionsRow}>
                  <TouchableOpacity
                    onPress={cancelAutoResponder}
                    activeOpacity={0.8}
                    style={[styles.autoCancelBtn]}
                  >
                    <AppText style={[styles.autoCancelText, { fontFamily, color: COLORS.sub }]}>
                      Cancel
                    </AppText>
                  </TouchableOpacity>

                  <TouchableOpacity
                    onPress={saveAutoResponder}
                    activeOpacity={0.85}
                    style={{ flex: 1 }}
                  >
                    <LinearGradient colors={GRADIENTS.primary} style={styles.autoSaveBtn}>
                      <AppIcon name="checkmark-circle-outline" size={18} color="#fff" fixedColor style={{ marginRight: 6 }} />
                      <AppText fixedColor style={styles.autoSaveText}>Save Changes</AppText>
                    </LinearGradient>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </View>

        {/* ── Catalog ── */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <AppText style={[styles.sectionTitle, { color: COLORS.sub, fontFamily }]}>CATALOG</AppText>
            <TouchableOpacity
              onPress={() => setCatalogModalOpen(true)}
              style={styles.addBtn}
              activeOpacity={0.8}
            >
              <AppIcon name="add-circle" size={18} color={COLORS.blue} fixedColor />
              <AppText style={[styles.addBtnText, { fontFamily }]}>Add Item</AppText>
            </TouchableOpacity>
          </View>

          {catalog.length === 0 ? (
            <View style={styles.emptyCard}>
              <AppIcon name="storefront-outline" size={36} color={COLORS.textFaint} />
              <AppText style={[styles.emptyText, { color: COLORS.textFaint, fontFamily }]}>
                No items yet.{'\n'}Add products or services your customers can browse.
              </AppText>
            </View>
          ) : (
            catalog.map((item) => (
              <View key={item.id} style={styles.catalogCard}>
                {item.imageUri ? (
                  <Image source={{ uri: item.imageUri }} style={styles.catalogItemImg} />
                ) : (
                  <View style={styles.catalogItemPlaceholder}>
                    <AppIcon name="cube-outline" size={20} color={COLORS.blue} fixedColor />
                  </View>
                )}
                <View style={styles.catalogItemContent}>
                  <AppText style={[styles.catalogItemName, { color: textColor, fontFamily }]}>
                    {item.name}
                  </AppText>
                  {item.price ? (
                    <AppText style={[styles.catalogItemPrice, { fontFamily }]}>
                      {item.price}
                    </AppText>
                  ) : null}
                  {item.description ? (
                    <AppText style={[styles.catalogItemDesc, { color: FG.secondary, fontFamily }]} numberOfLines={2}>
                      {item.description}
                    </AppText>
                  ) : null}
                </View>
                <TouchableOpacity
                  onPress={() => setShareItem(item)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.deleteBtn}
                >
                  <AppIcon name="share-social-outline" size={20} color={COLORS.blue} fixedColor />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => removeCatalogItem(item.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.deleteBtn}
                >
                  <AppIcon name="close-circle" size={20} color={COLORS.missed} fixedColor />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* ── Add Catalog Item Modal ── */}
      <Modal
        visible={catalogModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setCatalogModalOpen(false)}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalSheet}>
              <View style={styles.modalHandle} />

              {/* Header row */}
              <View style={styles.modalHeaderRow}>
                <AppText style={[styles.modalTitle, { color: textColor, fontFamily }]}>
                  New Item
                </AppText>
                <TouchableOpacity
                  onPress={() => { setCatalogModalOpen(false); setNewItemName(''); setNewItemPrice(''); setNewItemDesc(''); setNewItemImage(null); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <AppIcon name="close" size={22} color={COLORS.sub} />
                </TouchableOpacity>
              </View>

              <ScrollView
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ paddingBottom: 16 }}
              >
                {/* Item Image */}
                <TouchableOpacity onPress={pickItemImage} style={styles.itemImagePicker} activeOpacity={0.8}>
                  {newItemImage ? (
                    <Image source={{ uri: newItemImage }} style={styles.itemImagePreview} />
                  ) : (
                    <View style={styles.itemImagePlaceholder}>
                      <AppIcon name="image-outline" size={28} color={COLORS.blue} fixedColor />
                    </View>
                  )}
                </TouchableOpacity>
                <AppText style={[styles.photoHint, { color: COLORS.sub, fontFamily }]}>
                  {newItemImage ? 'Tap to change' : 'Tap to add photo'}
                </AppText>

                {/* Item Name */}
                <AppText style={[styles.fieldLabel, { color: COLORS.sub, fontFamily }]}>Name</AppText>
                <View style={styles.modalInput}>
                  <TextInput
                    style={[styles.modalInputText, { color: textColor, fontFamily }]}
                    placeholder="e.g. Haircut, T-shirt, Web Design"
                    placeholderTextColor={COLORS.textFaint}
                    value={newItemName}
                    onChangeText={setNewItemName}
                    returnKeyType="next"
                  />
                </View>

                {/* Item Price */}
                <AppText style={[styles.fieldLabel, { color: COLORS.sub, fontFamily }]}>Price</AppText>
                <View style={styles.modalInput}>
                  <TextInput
                    style={[styles.modalInputText, { color: textColor, fontFamily }]}
                    placeholder="e.g. R150, $25, or Free"
                    placeholderTextColor={COLORS.textFaint}
                    value={newItemPrice}
                    onChangeText={setNewItemPrice}
                    returnKeyType="next"
                  />
                </View>

                {/* Item Description */}
                <AppText style={[styles.fieldLabel, { color: COLORS.sub, fontFamily }]}>Description</AppText>
                <View style={[styles.modalInput, { minHeight: 80 }]}>
                  <TextInput
                    style={[styles.modalInputText, { color: textColor, fontFamily, textAlignVertical: 'top', minHeight: 60 }]}
                    placeholder="Optional — what customers should know"
                    placeholderTextColor={COLORS.textFaint}
                    value={newItemDesc}
                    onChangeText={setNewItemDesc}
                    multiline
                    numberOfLines={3}
                  />
                </View>

                {/* Add Button */}
                <TouchableOpacity onPress={addCatalogItem} activeOpacity={0.85} style={{ marginTop: 12 }} disabled={uploadingCatalogImage}>
                  <LinearGradient colors={GRADIENTS.primary} style={styles.modalPrimaryBtn}>
                    {uploadingCatalogImage ? (
                      <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
                    ) : (
                      <AppIcon name="add-circle-outline" size={18} color="#fff" fixedColor style={{ marginRight: 6 }} />
                    )}
                    <AppText fixedColor style={styles.modalPrimaryBtnText}>
                      {uploadingCatalogImage ? 'Uploading…' : 'Add to Catalog'}
                    </AppText>
                  </LinearGradient>
                </TouchableOpacity>
              </ScrollView>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Work Hours Modal (contains inline time picker to avoid nested Modal on iOS) ── */}
      <Modal
        visible={hoursModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (pickerVisible) {
            setPickerVisible(false);
            setPickerTarget(null);
          } else {
            setHoursModalOpen(false);
          }
        }}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { maxHeight: '90%' }]}>
            <View style={styles.modalHandle} />

            {pickerVisible ? (
              /* ── Inline Time Picker view (replaces day list) ── */
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <TouchableOpacity onPress={() => { setPickerVisible(false); setPickerTarget(null); }} style={{ padding: 4 }}>
                    <AppIcon name="chevron-back" size={22} color={COLORS.blue} fixedColor />
                  </TouchableOpacity>
                  <AppText style={[styles.modalTitle, { marginBottom: 0, color: textColor, fontFamily, fontSize: 16 }]}>
                    {pickerTarget
                      ? `${pickerTarget.day} — ${pickerTarget.field === 'open' ? 'Opens at' : 'Closes at'}`
                      : 'Select Time'}
                  </AppText>
                  <View style={{ width: 30 }} />
                </View>

                <View style={{ alignItems: 'center', marginVertical: 12 }}>
                  <DatePicker
                    date={pickerDate}
                    onDateChange={setPickerDate}
                    mode="time"
                    locale="en_US"
                  />
                </View>

                <View style={styles.pickerActions}>
                  <TouchableOpacity
                    onPress={() => { setPickerVisible(false); setPickerTarget(null); }}
                    style={[styles.pickerActionBtn, styles.pickerCancelBtn]}
                  >
                    <AppText style={[styles.pickerActionText, { color: COLORS.sub, fontFamily }]}>Cancel</AppText>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={confirmTime}
                    style={[styles.pickerActionBtn, styles.pickerConfirmBtn]}
                  >
                    <AppText fixedColor style={[styles.pickerActionText, { color: '#fff', fontFamily }]}>Set Time</AppText>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              /* ── Day schedule list ── */
              <>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <AppText style={[styles.modalTitle, { marginBottom: 0, color: textColor, fontFamily }]}>Work Hours</AppText>
                  <TouchableOpacity onPress={() => setHoursModalOpen(false)}>
                    <AppIcon name="close" size={22} color={COLORS.sub} />
                  </TouchableOpacity>
                </View>

                <ScrollView showsVerticalScrollIndicator={false}>
                  {DAYS.map((day) => {
                    const schedule = workSchedule[day] || { open: 'Closed', close: 'Closed' };
                    const isClosed = schedule.open === 'Closed';

                    return (
                      <View key={day} style={styles.dayRow}>
                        <View style={styles.dayToggleWrap}>
                          <Switch
                            value={!isClosed}
                            onValueChange={(val) => {
                              const updated = { ...workSchedule };
                              if (val) {
                                updated[day] = { open: '8:00 AM', close: '5:00 PM' };
                              } else {
                                updated[day] = { open: 'Closed', close: 'Closed' };
                              }
                              setWorkSchedule(updated);
                              saveWorkSchedule(updated);
                            }}
                            trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.blue }}
                            thumbColor={'#fff'}
                            style={{ transform: [{ scale: 0.8 }] }}
                          />
                          <AppText style={[styles.dayLabel, { color: textColor, fontFamily }]}>{day}</AppText>
                        </View>

                        <View style={styles.dayTimes}>
                          {isClosed ? (
                            <AppText style={[styles.closedText, { fontFamily, color: COLORS.sub }]}>Closed</AppText>
                          ) : (
                            <>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker(day, 'open')}
                              >
                                <AppText style={[styles.timePillText, { color: textColor, fontFamily }]}>{schedule.open}</AppText>
                              </TouchableOpacity>
                              <AppText style={{ color: COLORS.sub, fontSize: 12 }}>to</AppText>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker(day, 'close')}
                              >
                                <AppText style={[styles.timePillText, { color: textColor, fontFamily }]}>{schedule.close}</AppText>
                              </TouchableOpacity>
                            </>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </ScrollView>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* ── Catalog Share Sheet ── */}
      {shareItem && (
        <CatalogShareSheet
          visible={!!shareItem}
          item={shareItem}
          onClose={() => setShareItem(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 0, paddingBottom: 12, paddingHorizontal: 16,
    gap: 8,
  },
  headerTitle: {
    flex: 1, textAlign: 'center',
    fontSize: 18, fontWeight: '700', color: COLORS.text,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)',
  },

  scroll: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 48, gap: 28 },

  // Avatar
  avatarSection: { alignItems: 'center', gap: 10 },
  avatarWrap:    { width: 100, height: 100, borderRadius: 50 },
  avatarImg: {
    width: 100, height: 100, borderRadius: 50,
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.60)',
  },
  avatarPlaceholder: {
    width: 100, height: 100, borderRadius: 50,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: 'rgba(255,255,255,0.60)',
  },
  avatarInitials: { fontSize: 34, fontWeight: '800', color: '#fff' },
  cameraBadge: {
    position: 'absolute', bottom: 0, right: 0,
    width: 28, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: COLORS.blue,
    borderWidth: 2, borderColor: '#fff',
  },
  tapHint: { fontSize: 12, color: COLORS.sub },

  // Sections
  section:       { gap: 8 },
  sectionTitle:  { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, color: COLORS.sub, marginBottom: 4, marginLeft: 2 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },

  // Info cards — clean, no glass
  infoCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  iconCircle: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: 'rgba(30,156,240,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  infoContent: { flex: 1 },
  infoLabel:   { fontSize: 11, fontWeight: '600', color: COLORS.sub, marginBottom: 2 },
  infoValue:   { fontSize: 15, fontWeight: '600', color: COLORS.text },
  infoInput: {
    fontSize: 15, fontWeight: '600', color: COLORS.text,
    borderBottomWidth: 1.5,
    borderBottomColor: COLORS.blue,
    paddingBottom: 2,
    padding: 0, margin: 0,
  },

  // Auto responder editor
  autoEditorCard: {
    borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 14,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
    gap: 8,
  },
  autoEditorInput: {
    fontSize: 14,
    minHeight: 90,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#f5f7fa',
    lineHeight: 20,
  },
  autoActionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  autoCancelBtn: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoCancelText: { fontSize: 15, fontWeight: '700' },
  autoSaveBtn: {
    borderRadius: 14,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  autoSaveText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  // Add button
  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8,
  },
  addBtnText: { fontSize: 13, fontWeight: '600', color: COLORS.blue },

  // Empty catalog
  emptyCard: {
    alignItems: 'center', justifyContent: 'center',
    paddingVertical: 36, paddingHorizontal: 20,
    borderRadius: 14, gap: 10,
    backgroundColor: 'rgba(255,255,255,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    borderStyle: 'dashed',
  },
  emptyText: { fontSize: 13, textAlign: 'center', lineHeight: 19 },

  // Catalog item card
  catalogCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 12,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  catalogItemImg: {
    width: 48, height: 48, borderRadius: 10,
  },
  catalogItemPlaceholder: {
    width: 48, height: 48, borderRadius: 10,
    backgroundColor: 'rgba(30,156,240,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  catalogItemContent: { flex: 1 },
  catalogItemName:  { fontSize: 14, fontWeight: '600' },
  catalogItemPrice: { fontSize: 13, fontWeight: '700', color: COLORS.blue, marginTop: 1 },
  catalogItemDesc:  { fontSize: 12, marginTop: 2, lineHeight: 16 },
  deleteBtn: { padding: 4 },

  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 34 : 24,
    backgroundColor: '#fff',
    maxHeight: '90%',
  },
  modalHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: '#e0e0e0',
    alignSelf: 'center', marginBottom: 18,
  },
  modalHeaderRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 20,
  },
  modalTitle: { fontSize: 20, fontWeight: '700' },
  fieldLabel: { fontSize: 12, fontWeight: '600', marginBottom: 6, marginLeft: 2 },
  modalInput: {
    borderRadius: 12,
    paddingHorizontal: 16,
    marginBottom: 16,
    backgroundColor: '#f5f7fa',
  },
  modalInputText: { fontSize: 15, paddingVertical: 14 },
  modalPrimaryBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'center',
    ...SHADOW.button,
  },
  modalPrimaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  modalCancelBtn: { alignItems: 'center', paddingVertical: 14 },
  modalCancelText: { fontSize: 14, fontWeight: '600' },
  photoHint: { fontSize: 11, textAlign: 'center', marginBottom: 20, marginTop: 6 },

  // Item image picker in modal
  itemImagePicker: {
    alignSelf: 'center',
    width: 72, height: 72, borderRadius: 36,
    overflow: 'hidden',
    backgroundColor: '#f0f7ff',
    borderWidth: 2,
    borderColor: 'rgba(30,156,240,0.2)',
    borderStyle: 'dashed',
  },
  itemImagePreview: { width: 72, height: 72, borderRadius: 36 },
  itemImagePlaceholder: {
    width: 72, height: 72,
    alignItems: 'center', justifyContent: 'center',
  },
  itemImageText: { fontSize: 10, fontWeight: '600' },

  // Work hours modal
  dayRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  dayToggleWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    width: 120, // Prevents days from shifting the other elements
  },
  dayLabel: { fontSize: 14, fontWeight: '600' },
  dayTimes: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' },
  timePill: {
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: 'rgba(30,156,240,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.15)',
  },
  timePillText: { fontSize: 13, fontWeight: '600' },
  closedBadge: {
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.04)',
  },
  closedText: { fontSize: 13, fontWeight: '600', color: COLORS.sub },

  // Time picker
  pickerSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    backgroundColor: '#f8fbff',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 30,
  },
  pickerTitle: { fontSize: 15, fontWeight: '700', marginBottom: 12 },
  pickerHelper: { fontSize: 11, fontWeight: '600', marginTop: 10, marginBottom: 6, letterSpacing: 0.4 },
  pickerItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 13, paddingHorizontal: 14,
    borderRadius: 10,
    marginBottom: 2,
  },
  pickerItemActive: {
    backgroundColor: 'rgba(30,156,240,0.08)',
  },
  pickerItemText: { fontSize: 15 },

  // Number picker actions
  pickerActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
  },
  pickerActionBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pickerCancelBtn: {
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  pickerConfirmBtn: {
    backgroundColor: COLORS.blue,
  },
  pickerActionText: {
    fontSize: 15,
    fontWeight: '700',
  },

  // Legacy custom time input (no longer used but kept for compatibility)
  customTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  customTimeInput: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(30,156,240,0.20)',
  },
  customTimeBtn: {
    backgroundColor: COLORS.blue,
    paddingHorizontal: 18,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  customTimeBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});