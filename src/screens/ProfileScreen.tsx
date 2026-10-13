// ─── Screen: Profile ─────────────────────────────────────────────────────────
//
// COMPANION NOTE
//   This screen reads and writes users/{ownerUid}. On the primary, ownerUid
//   is the caller's own uid. On a companion it is the OWNER's real uid, so
//   the same document loads and displays on both devices.
//
//   Every write is guarded: on a companion, edit gestures are ignored and
//   the UI shows a "Read-only on this device" banner instead. This matches
//   the rules layer, which requires request.auth.uid == userId for
//   users/{uid} updates — companions cannot satisfy that.
//
import React, { useRef, useState, useEffect } from 'react';
import {
  View, TouchableOpacity, StyleSheet, ScrollView,
  Image, Alert, Platform, TextInput, Modal,
  KeyboardAvoidingView, Switch, ActivityIndicator,
} from 'react-native';
import DateTimePickerModal from 'react-native-modal-datetime-picker';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import firestore from '@react-native-firebase/firestore';
import { db } from '../config/firebase';
import { uploadFile, generateFileName } from '../config/storage';
import { useAuth } from '../context/AuthContext';
import { AppBg, AppText, AppIcon, useForeground, useTypography, useGlass } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { CatalogItem, CatalogCollection, INDUSTRY_CATEGORIES, BusinessAddress } from '../types';
import { CatalogShareSheet } from '../components/CatalogShareSheet';

export default function ProfileScreen() {
  const navigation = useNavigation();

  // ownerUid === the account whose profile we're viewing.
  // isCompanion gates every write.
  const {
    phone,
    displayName,
    setDisplayName,
    avatarUri,
    setAvatarUri,
    ownerUid,
    isCompanion,
  } = useAuth();

  const { FG }  = useForeground();
  const { fontFamily, textColor } = useTypography();
  const { bevel } = useGlass();
  const insets = useSafeAreaInsets();

  const [editingName, setEditingName] = useState(false);
  const [draftName,   setDraftName]   = useState(displayName || 'Demo Business');
  const nameInputRef = useRef<TextInput>(null);

  // Business fields
  const [email,   setEmail]   = useState('');
  const [website, setWebsite] = useState('');

  // ── Enhanced profile fields ──────────────────────────────────────────────
  const [industry,    setIndustry]    = useState('');
  const [description, setDescription] = useState('');
  const [address,     setAddress]     = useState({
    street: '', city: '', province: '', postalCode: '', country: '',
  });
  const [industryModalOpen, setIndustryModalOpen] = useState(false);
  const [auto_responder_message, setauto_responder_message] = useState('');
  const [autoResponderEnabled, setAutoResponderEnabled] = useState(false);
  const [autoResponderPending, setAutoResponderPending] = useState(false);
  const [draftAutoMessage, setDraftAutoMessage] = useState('');

  const [editingField, setEditingField] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const fieldInputRef = useRef<TextInput>(null);

  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

  interface DaySchedule { open: string; close: string; }

  const defaultSchedule: Record<string, DaySchedule> = {
    Monday:    { open: 'Closed', close: 'Closed' },
    Tuesday:   { open: 'Closed', close: 'Closed' },
    Wednesday: { open: 'Closed', close: 'Closed' },
    Thursday:  { open: 'Closed', close: 'Closed' },
    Friday:    { open: 'Closed', close: 'Closed' },
    Saturday:  { open: 'Closed', close: 'Closed' },
    Sunday:    { open: 'Closed', close: 'Closed' },
  };

  const [workSchedule, setWorkSchedule] = useState<Record<string, DaySchedule>>(defaultSchedule);
  const [hoursModalOpen, setHoursModalOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<{ day: string; field: 'open' | 'close' } | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
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
  const [newItemCollectionId, setNewItemCollectionId] = useState<string | null>(null);
  const [shareItem, setShareItem] = useState<CatalogItem | null>(null);

  // Collections
  const [collections, setCollections] = useState<CatalogCollection[]>([]);
  const [collectionStep, setCollectionStep] = useState<null | 'pick' | 'name'>(null);
  const [newColName, setNewColName] = useState('');
  const [newColEmoji, setNewColEmoji] = useState('');
  const [newColItems, setNewColItems] = useState<string[]>([]);
  const [savingCollection, setSavingCollection] = useState(false);
  const [expandedCollection, setExpandedCollection] = useState<string | null>(null);
  const [colPickerOpen, setColPickerOpen] = useState(false);

  const shownName = displayName || 'Demo Business';

  // ── Guard helper — every mutation goes through this on companion ─────────
  const guardEdit = (): boolean => {
    if (isCompanion) {
      Alert.alert(
        'Managed on your primary device',
        'Business profile changes are not available on companion devices. Open ChitChat on the phone you signed in with to make changes.',
      );
      return false;
    }
    return true;
  };

  // ── Load business fields from Firestore ─────────────────────────────────────
  // Reads users/{ownerUid} — on primary this is the caller's own uid; on
  // companion this is the owner's real uid, so the same doc loads.
  useEffect(() => {
    if (!ownerUid) return;
    const loadProfile = async () => {
      try {
        const fsDb = db as ReturnType<typeof firestore>;
        const userSnap = await fsDb.collection('users').doc(ownerUid).get();
        if (userSnap.exists()) {
          const data = userSnap.data()!;
          setEmail(data.email || '');
          setWebsite(data.website || '');
          setauto_responder_message(data.auto_responder_message || '');
          setAutoResponderEnabled(data.autoResponderEnabled || false);
          if (data.workSchedule) setWorkSchedule(data.workSchedule);
          setCatalog(data.catalog || []);
          setCollections(data.collections || []);
          // Enhanced profile fields
          setIndustry(data.industry || '');
          setDescription(data.description || '');
          if (data.address) setAddress({ ...address, ...data.address });
        }
      } catch (err) {
        console.warn('[ProfileScreen] Error loading profile:', err);
      }
    };
    loadProfile();
  }, [ownerUid]);

  // ── Save name ─────────────────────────────────────────────────────────────
  const saveName = async () => {
    if (!guardEdit()) { setEditingName(false); return; }
    const trimmed = draftName.trim();
    if (!trimmed) {
      setEditingName(false);
      return;
    }
    if (!ownerUid) return;

    try {
      await setDisplayName(trimmed);

      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({ displayName: trimmed });
    } catch (error) {
      console.error('[ProfileScreen] Error saving displayName:', error);
    }
    setEditingName(false);
  };

  // ── Save a business field ──────────────────────────────────────────────────
  const saveField = async (field: string, value: string) => {
    if (!guardEdit()) { setEditingField(null); return; }
    if (!ownerUid) return;
    try {
      if (field === 'email')       setEmail(value);
      else if (field === 'website')     setWebsite(value);
      else if (field === 'description') setDescription(value);
      else if (field === 'auto_responder_message') setauto_responder_message(value);

      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({ [field]: value });
    } catch (error) {
      console.warn('[ProfileScreen] Error saving field:', error);
    }
    setEditingField(null);
  };

  // ── Save industry ─────────────────────────────────────────────────────────
  const saveIndustry = async (id: string) => {
    if (!guardEdit()) return;
    if (!ownerUid) return;
    setIndustry(id);
    setIndustryModalOpen(false);
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({ industry: id });
    } catch (err) {
      console.warn('[ProfileScreen] Error saving industry:', err);
    }
  };

  // ── Save address field ─────────────────────────────────────────────────────
  const saveAddressField = async (field: keyof BusinessAddress, value: string) => {
    if (!guardEdit()) { setEditingField(null); return; }
    if (!ownerUid) return;
    const updated = { ...address, [field]: value };
    setAddress(updated);
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({ address: updated });
    } catch (err) {
      console.warn('[ProfileScreen] Error saving address:', err);
    }
    setEditingField(null);
  };

  // ── Auto Responder toggle ─────────────────────────────────────────────────
  const handleAutoResponderToggle = async (val: boolean) => {
    if (!guardEdit()) return;
    if (!ownerUid) return;

    if (val) {
      setDraftAutoMessage(
        auto_responder_message ||
        'Thanks for your message! We are currently closed. We will get back to you as soon as we open.'
      );
      setAutoResponderPending(true);
      return;
    }

    if (autoResponderPending) {
      setAutoResponderPending(false);
      setDraftAutoMessage('');
      return;
    }

    setAutoResponderEnabled(false);
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({ autoResponderEnabled: false });
    } catch (error) {
      console.warn('[ProfileScreen] Error saving autoResponderEnabled:', error);
    }
  };

  // ── Save Auto Responder (message + enabled flag together) ─────────────────
  const saveAutoResponder = async () => {
    if (!guardEdit()) return;
    if (!ownerUid) return;
    const msg = draftAutoMessage.trim();
    if (!msg) {
      Alert.alert(
        'Message required',
        'Please type the automatic reply message before saving. Otherwise, customers would receive empty replies.'
      );
      return;
    }

    setauto_responder_message(msg);
    setAutoResponderEnabled(true);
    setAutoResponderPending(false);

    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({
        autoResponderEnabled: true,
        auto_responder_message: msg,
      });
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
    if (!guardEdit()) return;
    if (!ownerUid) return;
    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({ workSchedule: updated });
    } catch (err) {
      console.warn('[ProfileScreen] Error saving work schedule:', err);
    }
  };

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
    if (!guardEdit()) return;
    setPickerTarget({ day, field });

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

  const getScheduleSummary = (): string => {
    const openDays = DAYS.filter(d => workSchedule[d] && workSchedule[d].open !== 'Closed');
    if (openDays.length === 0) return 'Not set (All days closed)';
    if (openDays.length === 7) return `Every day ${workSchedule[openDays[0]].open} - ${workSchedule[openDays[0]].close}`;
    const first = openDays[0];
    const last = openDays[openDays.length - 1];
    return `${first.slice(0, 3)}-${last.slice(0, 3)} ${workSchedule[first].open} - ${workSchedule[first].close}`;
  };

  const startEditField = (field: string, currentValue: string) => {
    if (!guardEdit()) return;
    setEditingField(field);
    setDraftValue(currentValue);
    setTimeout(() => fieldInputRef.current?.focus(), 50);
  };

  // ── Catalog management ─────────────────────────────────────────────────────
  const pickItemImage = async () => {
    if (!guardEdit()) return;
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
    if (!guardEdit()) return;
    if (!ownerUid) return;
    if (!newItemName.trim()) {
      Alert.alert('Required', 'Please enter a product/service name.');
      return;
    }

    try {
      // ── Upload image to Firebase Storage if one was picked ──────────────
      let finalImageUri: string | null = newItemImage;
      if (newItemImage) {
        setUploadingCatalogImage(true);
        try {
          const fileName = generateFileName('jpg');
          finalImageUri = await uploadFile(newItemImage, 'avatar', {
            userId: ownerUid,
            fileName: `catalog_${fileName}`,
          });
        } catch (uploadErr) {
          console.warn('[ProfileScreen] Catalog image upload failed, saving local URI:', uploadErr);
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
        collectionId: newItemCollectionId ?? null,
      };

      const updated = [...catalog, newItem];
      setCatalog(updated);
      setCatalogModalOpen(false);
      setNewItemName('');
      setNewItemPrice('');
      setNewItemDesc('');
      setNewItemImage(null);
      setNewItemCollectionId(null);

      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({ catalog: updated });
    } catch (err) {
      console.warn('[ProfileScreen] Error saving catalog item:', err);
      setUploadingCatalogImage(false);
    }
  };

  const removeCatalogItem = async (id: string) => {
    if (!guardEdit()) return;
    if (!ownerUid) return;
    const updated = catalog.filter(item => item.id !== id);
    setCatalog(updated);

    try {
      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({ catalog: updated });
    } catch (err) {
      console.warn('[ProfileScreen] Error removing catalog item:', err);
    }
  };

  // ── Collection management ──────────────────────────────────────────────────
  const addCollection = async () => {
    if (!guardEdit()) return;
    if (!ownerUid) return;
    if (!newColName.trim()) return;
    setSavingCollection(true);
    try {
      const newCol: CatalogCollection = {
        id:        Date.now().toString(),
        name:      newColName.trim(),
        emoji:     newColEmoji.trim() || null,
        createdAt: Date.now(),
      };

      const strip = <T extends object>(obj: T): T =>
        Object.fromEntries(
          Object.entries(obj).filter(([, v]) => v !== undefined)
        ) as T;

      const updatedCatalog = catalog.map(item =>
        newColItems.includes(item.id)
          ? strip({ ...item, collectionId: newCol.id })
          : strip({ ...item }),
      );

      const updatedCollections = [...collections, strip(newCol)];

      const fsDb = db as ReturnType<typeof firestore>;
      await fsDb.collection('users').doc(ownerUid).update({
        collections: updatedCollections,
        catalog:     updatedCatalog,
      });

      setCatalog(updatedCatalog);
      setCollections(updatedCollections);
      setNewColName('');
      setNewColEmoji('');
      setNewColItems([]);
      setCollectionStep(null);
      setExpandedCollection(newCol.id);
    } catch (err) {
      console.warn('[ProfileScreen] Error saving collection:', err);
    } finally {
      setSavingCollection(false);
    }
  };

  const removeCollection = async (colId: string) => {
    if (!guardEdit()) return;
    if (!ownerUid) return;
    Alert.alert(
      'Delete Collection?',
      'The collection will be removed. Items inside will become uncategorised.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const updatedCatalog = catalog.map(i =>
              i.collectionId === colId ? { ...i, collectionId: null } : i,
            );
            setCatalog(updatedCatalog);
            const updatedCols = collections.filter(c => c.id !== colId);
            try {
              const fsDb = db as ReturnType<typeof firestore>;
              await fsDb.collection('users').doc(ownerUid).update({
                catalog: updatedCatalog,
                collections: updatedCols,
              });
            } catch (err) {
              console.warn('[ProfileScreen] Error removing collection:', err);
            }
            setCollections(updatedCols);
          },
        },
      ],
    );
  };

  // ── Pick photo ────────────────────────────────────────────────────────────
  const pickPhoto = async () => {
    if (!guardEdit()) return;
    if (!ownerUid) return;

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
        const fsDb = db as ReturnType<typeof firestore>;
        const fileName = generateFileName('jpg');
        const downloadURL = await uploadFile(uri, 'avatar', {
          userId: ownerUid,
          fileName,
        }, (progress) => {
          console.log(`[ProfileScreen] Upload progress: ${progress}%`);
        });

        await setAvatarUri(uri);
        await fsDb.collection('users').doc(ownerUid).update({ photoURL: downloadURL });
      } catch (error: any) {
        console.error('[ProfileScreen] Error saving avatar:', error);
        await setAvatarUri(uri);
      }
    }
  };

  const initials = shownName.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);

  // ── Editable field card component ──────────────────────────────────────────
  const EditableField = ({ field, label, icon, value, placeholder, keyboardType ,isMultiline, readOnly}: {
    field: string; label: string; icon: string; value: string; placeholder: string; keyboardType?: any;isMultiline?:boolean; readOnly?: boolean;
  }) => (
    <TouchableOpacity
      style={styles.infoCard}
      activeOpacity={readOnly ? 1 : 0.8}
      onPress={() => { if (!readOnly) startEditField(field, value); }}
      disabled={readOnly}
    >
      <View style={styles.iconCircle}>
        <AppIcon name={icon as any} size={18} color={COLORS.blue} fixedColor />
      </View>
      <View style={styles.infoContent}>
        <AppText style={[styles.infoLabel, { fontFamily }]}>{label}</AppText>
        {editingField === field && !readOnly ? (
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
      {!readOnly && (
        editingField === field ? (
          <TouchableOpacity onPress={() => saveField(field, draftValue)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <AppIcon name="checkmark-circle" size={22} fixedColor color={COLORS.blue} />
          </TouchableOpacity>
        ) : (
          <AppIcon name="create-outline" size={16} color={COLORS.sub} />
        )
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

        {/* ── Companion read-only notice ── */}
        {isCompanion && (
          <View style={[styles.noticeCard, bevel]}>
            <LinearGradient
              colors={['#6366f1', '#8b5cf6']}
              style={styles.noticeIconWrap}
            >
              <AppIcon name="link-outline" size={18} color="#fff" fixedColor />
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <AppText style={[styles.noticeTitle, { color: textColor, fontFamily }]}>
                Read-only on this device
              </AppText>
              <AppText style={[styles.noticeBody, { color: FG.secondary }]}>
                You can view the business profile, but changes require the
                primary device.
              </AppText>
            </View>
          </View>
        )}

        {/* ── Avatar ── */}
        <View style={styles.avatarSection}>
          <TouchableOpacity
            onPress={pickPhoto}
            activeOpacity={isCompanion ? 1 : 0.85}
            style={styles.avatarWrap}
            disabled={isCompanion}
          >
            {avatarUri ? (
              <Image source={{ uri: avatarUri }} style={styles.avatarImg} />
            ) : (
              <LinearGradient colors={[COLORS.blue, COLORS.blueDark]} style={styles.avatarPlaceholder}>
                <AppText fixedColor style={styles.avatarInitials}>{initials}</AppText>
              </LinearGradient>
            )}
            {!isCompanion && (
              <View style={styles.cameraBadge}>
                <AppIcon name="camera" size={14} fixedColor color="#fff" />
              </View>
            )}
          </TouchableOpacity>
          <AppText style={[styles.tapHint, { color: FG.secondary, fontFamily }]}>
            {isCompanion ? 'Profile photo' : 'Tap photo to change'}
          </AppText>
        </View>

        {/* ── Business Info ── */}
        <View style={styles.section}>
          <AppText style={[styles.sectionTitle, { color: COLORS.sub, fontFamily }]}>BUSINESS INFO</AppText>

          {/* Name */}
          <TouchableOpacity
            style={styles.infoCard}
            activeOpacity={isCompanion ? 1 : 0.8}
            onPress={() => {
              if (isCompanion) { guardEdit(); return; }
              setDraftName(shownName);
              setEditingName(true);
              setTimeout(() => nameInputRef.current?.focus(), 50);
            }}
            disabled={isCompanion}
          >
            <View style={styles.iconCircle}>
              <AppIcon name="business-outline" size={18} color={COLORS.blue} fixedColor />
            </View>
            <View style={styles.infoContent}>
              <AppText style={[styles.infoLabel, { fontFamily }]}>Business Name</AppText>
              {editingName && !isCompanion ? (
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
            {!isCompanion && (
              editingName ? (
                <TouchableOpacity onPress={saveName} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <AppIcon name="checkmark-circle" size={22} fixedColor color={COLORS.blue} />
                </TouchableOpacity>
              ) : (
                <AppIcon name="create-outline" size={16} color={COLORS.sub} />
              )
            )}
          </TouchableOpacity>

          {/* Phone */}
          <TouchableOpacity
            style={styles.infoCard}
            activeOpacity={isCompanion ? 1 : 0.8}
            onPress={() => {
              if (isCompanion) { guardEdit(); return; }
              navigation.navigate('ChangeNumber' as never);
            }}
            disabled={isCompanion}
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
            {!isCompanion && <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />}
          </TouchableOpacity>

          {/* Email */}
          <EditableField
            field="email"
            label="Email"
            icon="mail-outline"
            value={email}
            placeholder="Add email address"
            keyboardType="email-address"
            readOnly={isCompanion}
          />

          {/* Website */}
          <EditableField
            field="website"
            label="Website"
            icon="globe-outline"
            value={website}
            placeholder="Add website URL"
            keyboardType="url"
            readOnly={isCompanion}
          />

          {/* Industry */}
          <TouchableOpacity
            style={styles.infoCard}
            activeOpacity={isCompanion ? 1 : 0.8}
            onPress={() => { if (isCompanion) { guardEdit(); return; } setIndustryModalOpen(true); }}
            disabled={isCompanion}
          >
            <View style={styles.iconCircle}>
              <AppIcon name="briefcase-outline" size={18} color={COLORS.blue} fixedColor />
            </View>
            <View style={styles.infoContent}>
              <AppText style={[styles.infoLabel, { fontFamily }]}>Industry</AppText>
              <AppText style={[styles.infoValue, {
                color: industry ? textColor : COLORS.textFaint, fontFamily
              }]}>
                {industry
                  ? (() => {
                      const cat = INDUSTRY_CATEGORIES.find((c) => c.id === industry);
                      return cat ? `${cat.emoji}  ${cat.label}` : industry;
                    })()
                  : 'Select your industry'}
              </AppText>
            </View>
            {!isCompanion && <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />}
          </TouchableOpacity>

          {/* Description */}
          <EditableField
            field="description"
            label="About the Business"
            icon="document-text-outline"
            value={description}
            placeholder="Tell customers what your business does…"
            isMultiline
            readOnly={isCompanion}
          />

          {/* Work Hours */}
          <TouchableOpacity
            style={styles.infoCard}
            activeOpacity={isCompanion ? 1 : 0.8}
            onPress={() => {
              if (isCompanion) { guardEdit(); return; }
              setHoursModalOpen(true);
            }}
            disabled={isCompanion}
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
            {!isCompanion && <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />}
          </TouchableOpacity>
        </View>

        {/* ── Address ── */}
        <View style={styles.section}>
          <AppText style={[styles.sectionTitle, { color: COLORS.sub, fontFamily }]}>PHYSICAL ADDRESS</AppText>

          {(['street', 'city', 'province', 'postalCode', 'country'] as const).map((field) => {
            const labels: Record<string, string> = {
              street:     'Street Address',
              city:       'City',
              province:   'Province / State',
              postalCode: 'Postal Code',
              country:    'Country',
            };
            const icons: Record<string, string> = {
              street:     'location-outline',
              city:       'map-outline',
              province:   'flag-outline',
              postalCode: 'barcode-outline',
              country:    'earth-outline',
            };
            return (
              <TouchableOpacity
                key={field}
                style={styles.infoCard}
                activeOpacity={isCompanion ? 1 : 0.8}
                onPress={() => {
                  if (isCompanion) { guardEdit(); return; }
                  startEditField(`addr_${field}`, address[field]);
                }}
                disabled={isCompanion}
              >
                <View style={styles.iconCircle}>
                  <AppIcon name={icons[field] as any} size={18} color={COLORS.blue} fixedColor />
                </View>
                <View style={styles.infoContent}>
                  <AppText style={[styles.infoLabel, { fontFamily }]}>{labels[field]}</AppText>
                  {editingField === `addr_${field}` && !isCompanion ? (
                    <TextInput
                      ref={fieldInputRef}
                      style={[styles.infoInput, { color: textColor, fontFamily }]}
                      value={draftValue}
                      onChangeText={setDraftValue}
                      placeholder={`Enter ${labels[field].toLowerCase()}`}
                      placeholderTextColor={COLORS.textFaint}
                      returnKeyType="done"
                      autoFocus
                      onSubmitEditing={() => saveAddressField(field, draftValue)}
                      onBlur={() => saveAddressField(field, draftValue)}
                    />
                  ) : (
                    <AppText style={[styles.infoValue, {
                      color: address[field] ? textColor : COLORS.textFaint, fontFamily,
                    }]}>
                      {address[field] || `Add ${labels[field].toLowerCase()}`}
                    </AppText>
                  )}
                </View>
                {!isCompanion && (
                  editingField === `addr_${field}` ? (
                    <TouchableOpacity
                      onPress={() => saveAddressField(field, draftValue)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <AppIcon name="checkmark-circle" size={22} fixedColor color={COLORS.blue} />
                    </TouchableOpacity>
                  ) : (
                    <AppIcon name="create-outline" size={16} color={COLORS.sub} />
                  )
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Auto Responder ── */}
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
              disabled={isCompanion}
              trackColor={{ false: 'rgba(0,0,0,0.1)', true: COLORS.blue }}
              thumbColor={'#fff'}
            />
          </View>

          {showAutoResponderEditor && (
            <View style={styles.autoEditorCard}>
              <AppText style={[styles.infoLabel, { fontFamily, marginBottom: 6 }]}>
                Auto Reply Message
              </AppText>

              {autoResponderPending && !isCompanion ? (
                <TextInput
                  style={[styles.autoEditorInput, { color: textColor, fontFamily }]}
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
                <EditableField
                  field="auto_responder_message"
                  label="Message"
                  icon="document-text-outline"
                  isMultiline={true}
                  value={auto_responder_message}
                  placeholder="No message set"
                  keyboardType="default"
                  readOnly={isCompanion}
                />
              )}

              {autoResponderPending && !isCompanion && (
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
            {/* Hide add buttons on companion */}
            {!isCompanion && (
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TouchableOpacity
                  onPress={() => { setNewColItems([]); setCollectionStep('pick'); }}
                  style={[styles.addBtn, { backgroundColor: 'rgba(30,156,240,0.08)' }]}
                  activeOpacity={0.8}
                >
                  <AppIcon name="folder-open-outline" size={16} color={COLORS.blue} fixedColor />
                  <AppText style={[styles.addBtnText, { fontFamily }]}>Collection</AppText>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => setCatalogModalOpen(true)}
                  style={styles.addBtn}
                  activeOpacity={0.8}
                >
                  <AppIcon name="add-circle" size={18} color={COLORS.blue} fixedColor />
                  <AppText style={[styles.addBtnText, { fontFamily }]}>Add Item</AppText>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {catalog.length === 0 && collections.length === 0 ? (
            <View style={styles.emptyCard}>
              <AppIcon name="storefront-outline" size={36} color={COLORS.textFaint} />
              <AppText style={[styles.emptyText, { color: COLORS.textFaint, fontFamily }]}>
                No items yet.{'\n'}Add products or services your customers can browse.
              </AppText>
            </View>
          ) : (
            <>
              {collections.map((col) => {
                const colItems = catalog.filter(i => i.collectionId === col.id);
                const isOpen = expandedCollection === col.id;
                return (
                  <View key={col.id} style={styles.collectionGroup}>
                    <TouchableOpacity
                      style={styles.collectionHeader}
                      activeOpacity={0.75}
                      onPress={() => setExpandedCollection(isOpen ? null : col.id)}
                    >
                      <View style={styles.collectionHeaderLeft}>
                        <View style={styles.collectionIconWrap}>
                          <AppText style={styles.collectionEmoji}>{col.emoji || '📦'}</AppText>
                        </View>
                        <View>
                          <AppText style={[styles.collectionName, { color: textColor, fontFamily }]}>
                            {col.name}
                          </AppText>
                          <AppText style={[styles.collectionCount, { color: FG.secondary }]}>
                            {colItems.length} item{colItems.length !== 1 ? 's' : ''}
                          </AppText>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        {/* Delete only on primary */}
                        {!isCompanion && (
                          <TouchableOpacity
                            onPress={() => removeCollection(col.id)}
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            style={{ padding: 4 }}
                          >
                            <AppIcon name="trash-outline" size={16} color={COLORS.missed} fixedColor />
                          </TouchableOpacity>
                        )}
                        <AppIcon
                          name={isOpen ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color={COLORS.sub}
                        />
                      </View>
                    </TouchableOpacity>

                    {isOpen && (
                      colItems.length === 0 ? (
                        <View style={styles.colEmptyHint}>
                          <AppText style={[{ color: FG.secondary, fontSize: 12, fontStyle: 'italic' }]}>
                            No items in this collection yet. Assign items using "Add Item".
                          </AppText>
                        </View>
                      ) : (
                        colItems.map((item) => (
                          <CatalogItemRow
                            key={item.id}
                            item={item}
                            textColor={textColor}
                            fgSecondary={FG.secondary}
                            fontFamily={fontFamily}
                            onShare={() => setShareItem(item)}
                            onRemove={() => removeCatalogItem(item.id)}
                            hideRemove={isCompanion}
                          />
                        ))
                      )
                    )}
                  </View>
                );
              })}

              {(() => {
                const uncategorised = catalog.filter(i => !i.collectionId);
                if (uncategorised.length === 0 && collections.length > 0) return null;
                return (
                  <View style={styles.collectionGroup}>
                    {collections.length > 0 && (
                      <TouchableOpacity
                        style={styles.collectionHeader}
                        activeOpacity={0.75}
                        onPress={() => setExpandedCollection(
                          expandedCollection === '__uncategorised' ? null : '__uncategorised',
                        )}
                      >
                        <View style={styles.collectionHeaderLeft}>
                          <View style={styles.collectionIconWrap}>
                            <AppText style={styles.collectionEmoji}>🗂️</AppText>
                          </View>
                          <View>
                            <AppText style={[styles.collectionName, { color: textColor, fontFamily }]}>
                              Uncategorised
                            </AppText>
                            <AppText style={[styles.collectionCount, { color: FG.secondary }]}>
                              {uncategorised.length} item{uncategorised.length !== 1 ? 's' : ''}
                            </AppText>
                          </View>
                        </View>
                        <AppIcon
                          name={expandedCollection === '__uncategorised' ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color={COLORS.sub}
                        />
                      </TouchableOpacity>
                    )}
                    {(collections.length === 0 || expandedCollection === '__uncategorised') &&
                      uncategorised.map((item) => (
                        <CatalogItemRow
                          key={item.id}
                          item={item}
                          textColor={textColor}
                          fgSecondary={FG.secondary}
                          fontFamily={fontFamily}
                          onShare={() => setShareItem(item)}
                          onRemove={() => removeCatalogItem(item.id)}
                          hideRemove={isCompanion}
                        />
                      ))
                    }
                  </View>
                );
              })()}
            </>
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

              <View style={styles.modalHeaderRow}>
                <AppText style={[styles.modalTitle, { color: textColor, fontFamily }]}>
                  New Item
                </AppText>
                <TouchableOpacity
                  onPress={() => { setCatalogModalOpen(false); setNewItemName(''); setNewItemPrice(''); setNewItemDesc(''); setNewItemImage(null); setNewItemCollectionId(null); }}
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

                {collections.length > 0 && (
                  <>
                    <AppText style={[styles.fieldLabel, { color: COLORS.sub, fontFamily }]}>Collection</AppText>
                    <TouchableOpacity
                      style={[styles.modalInput, { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14 }]}
                      onPress={() => setColPickerOpen(true)}
                      activeOpacity={0.8}
                    >
                      <AppText style={[styles.modalInputText, { color: newItemCollectionId ? textColor : COLORS.textFaint, paddingVertical: 0 }]}>
                        {newItemCollectionId
                          ? (() => { const c = collections.find(x => x.id === newItemCollectionId); return c ? `${c.emoji || '📦'} ${c.name}` : 'Select collection'; })()
                          : 'None (uncategorised)'}
                      </AppText>
                      <AppIcon name="chevron-forward" size={16} color={COLORS.sub} />
                    </TouchableOpacity>
                  </>
                )}

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
        </KeyboardAvoidingView
        >
      </Modal>

      {/* ── Create Collection Modal ── */}
      <Modal
        visible={collectionStep !== null}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (collectionStep === 'name') { setCollectionStep('pick'); return; }
          setCollectionStep(null);
          setNewColName(''); setNewColEmoji(''); setNewColItems([]);
        }}
      >
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={styles.modalOverlay}>
            <View style={[styles.modalSheet, { maxHeight: '90%' }]}>
              <View style={styles.modalHandle} />

              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, marginBottom: 16 }}>
                <View style={[colModalStyles.stepDot, { backgroundColor: COLORS.blue }]} />
                <View style={[colModalStyles.stepLine, { backgroundColor: collectionStep === 'name' ? COLORS.blue : 'rgba(0,0,0,0.10)' }]} />
                <View style={[colModalStyles.stepDot, { backgroundColor: collectionStep === 'name' ? COLORS.blue : 'rgba(0,0,0,0.15)' }]} />
              </View>

              {collectionStep === 'pick' ? (
                <>
                  <View style={styles.modalHeaderRow}>
                    <TouchableOpacity onPress={() => { setCollectionStep(null); setNewColItems([]); }} style={{ padding: 4 }}>
                      <AppIcon name="close" size={22} color={COLORS.sub} />
                    </TouchableOpacity>
                    <AppText style={[styles.modalTitle, { color: textColor, fontFamily, flex: 1, textAlign: 'center' }]}>
                      Select Products
                    </AppText>
                    <TouchableOpacity
                      onPress={() => { if (newColItems.length > 0) setCollectionStep('name'); }}
                      disabled={newColItems.length === 0}
                      style={{ opacity: newColItems.length === 0 ? 0.35 : 1 }}
                    >
                      <LinearGradient colors={GRADIENTS.primary} style={colModalStyles.nextBtn}>
                        <AppText fixedColor style={colModalStyles.nextBtnText}>
                          Next ({newColItems.length})
                        </AppText>
                        <AppIcon name="arrow-forward" size={15} color="#fff" fixedColor />
                      </LinearGradient>
                    </TouchableOpacity>
                  </View>

                  <AppText style={[colModalStyles.stepHint, { color: FG.secondary }]}>
                    Tap products to add them to your collection
                  </AppText>

                  {catalog.length === 0 ? (
                    <View style={[styles.emptyCard, { marginHorizontal: 0, marginTop: 8 }]}>
                      <AppIcon name="storefront-outline" size={32} color={COLORS.textFaint} />
                      <AppText style={[styles.emptyText, { color: COLORS.textFaint, fontFamily }]}>
                        Add some products to your catalog first.
                      </AppText>
                    </View>
                  ) : (
                    <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                      <View style={colModalStyles.productGrid}>
                        {catalog.map(item => {
                          const selected = newColItems.includes(item.id);
                          return (
                            <TouchableOpacity
                              key={item.id}
                              style={[colModalStyles.productTile, selected && colModalStyles.productTileSelected]}
                              activeOpacity={0.78}
                              onPress={() => setNewColItems(prev =>
                                prev.includes(item.id) ? prev.filter(x => x !== item.id) : [...prev, item.id]
                              )}
                            >
                              {item.imageUri ? (
                                <Image source={{ uri: item.imageUri }} style={colModalStyles.productTileImg} resizeMode="cover" />
                              ) : (
                                <View style={colModalStyles.productTileImgPlaceholder}>
                                  <AppIcon name="cube-outline" size={24} color={COLORS.blue} fixedColor />
                                </View>
                              )}
                              {selected && (
                                <View style={colModalStyles.checkOverlay} pointerEvents="none">
                                  <LinearGradient colors={['rgba(30,156,240,0.55)', 'rgba(10,114,196,0.55)']} style={colModalStyles.checkOverlayGrad}>
                                    <AppIcon name="checkmark-circle" size={28} color="#fff" fixedColor />
                                  </LinearGradient>
                                </View>
                              )}
                              <View style={colModalStyles.productTileInfo}>
                                <AppText style={[colModalStyles.productTileName, { color: textColor }]} numberOfLines={1}>
                                  {item.name}
                                </AppText>
                                {!!item.price && (
                                  <AppText style={colModalStyles.productTilePrice}>{item.price}</AppText>
                                )}
                              </View>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </ScrollView>
                  )}
                </>
              ) : (
                <>
                  <View style={styles.modalHeaderRow}>
                    <TouchableOpacity onPress={() => setCollectionStep('pick')} style={{ padding: 4 }}>
                      <AppIcon name="chevron-back" size={22} color={COLORS.blue} fixedColor />
                    </TouchableOpacity>
                    <AppText style={[styles.modalTitle, { color: textColor, fontFamily, flex: 1, textAlign: 'center' }]}>
                      Name Your Collection
                    </AppText>
                    <View style={{ width: 30 }} />
                  </View>

                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={colModalStyles.previewStrip}>
                    {catalog.filter(i => newColItems.includes(i.id)).map(item => (
                      <View key={item.id} style={colModalStyles.previewChip}>
                        {item.imageUri ? (
                          <Image source={{ uri: item.imageUri }} style={colModalStyles.previewChipImg} />
                        ) : (
                          <View style={colModalStyles.previewChipPlaceholder}>
                            <AppIcon name="cube-outline" size={14} color={COLORS.blue} fixedColor />
                          </View>
                        )}
                        <AppText style={[colModalStyles.previewChipName, { color: textColor }]} numberOfLines={1}>
                          {item.name}
                        </AppText>
                      </View>
                    ))}
                  </ScrollView>

                  <AppText style={[colModalStyles.stepHint, { color: FG.secondary, marginBottom: 12 }]}>
                    {newColItems.length} product{newColItems.length !== 1 ? 's' : ''} selected
                  </AppText>

                  <AppText style={[styles.fieldLabel, { color: COLORS.sub, fontFamily }]}>Emoji (optional)</AppText>
                  <View style={styles.modalInput}>
                    <TextInput
                      style={[styles.modalInputText, { color: textColor, fontFamily }]}
                      placeholder="e.g. 🌸 🍹 👗"
                      placeholderTextColor={COLORS.textFaint}
                      value={newColEmoji}
                      onChangeText={setNewColEmoji}
                      returnKeyType="next"
                      maxLength={4}
                    />
                  </View>

                  <AppText style={[styles.fieldLabel, { color: COLORS.sub, fontFamily }]}>Collection Name</AppText>
                  <View style={styles.modalInput}>
                    <TextInput
                      style={[styles.modalInputText, { color: textColor, fontFamily }]}
                      placeholder="e.g. Beverages, Flowers, Clothing"
                      placeholderTextColor={COLORS.textFaint}
                      value={newColName}
                      onChangeText={setNewColName}
                      returnKeyType="done"
                      autoFocus
                    />
                  </View>

                  <TouchableOpacity
                    onPress={addCollection}
                    activeOpacity={0.85}
                    disabled={savingCollection || !newColName.trim()}
                    style={{ marginTop: 4 }}
                  >
                    <LinearGradient
                      colors={newColName.trim() ? GRADIENTS.primary : ['#ccc', '#bbb']}
                      style={styles.modalPrimaryBtn}
                    >
                      {savingCollection
                        ? <ActivityIndicator size="small" color="#fff" />
                        : <>
                            <AppIcon name="checkmark-circle-outline" size={18} color="#fff" fixedColor style={{ marginRight: 6 }} />
                            <AppText fixedColor style={styles.modalPrimaryBtnText}>Create Collection</AppText>
                          </>
                      }
                    </LinearGradient>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Collection Picker ── */}
      <Modal
        visible={colPickerOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setColPickerOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { maxHeight: '60%' }]}>
            <View style={styles.modalHandle} />
            <View style={styles.modalHeaderRow}>
              <AppText style={[styles.modalTitle, { color: textColor, fontFamily }]}>Assign Collection</AppText>
              <TouchableOpacity onPress={() => setColPickerOpen(false)}>
                <AppIcon name="close" size={22} color={COLORS.sub} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <TouchableOpacity
                style={[styles.catalogCard, newItemCollectionId === null && { borderColor: COLORS.blue, borderWidth: 1.5 }]}
                onPress={() => { setNewItemCollectionId(null); setColPickerOpen(false); }}
                activeOpacity={0.75}
              >
                <View style={styles.catalogItemPlaceholder}>
                  <AppIcon name="close-circle-outline" size={20} color={COLORS.sub} fixedColor />
                </View>
                <View style={styles.catalogItemContent}>
                  <AppText style={[styles.catalogItemName, { color: textColor, fontFamily }]}>None (uncategorised)</AppText>
                </View>
                {newItemCollectionId === null && <AppIcon name="checkmark-circle" size={20} color={COLORS.blue} fixedColor />}
              </TouchableOpacity>
              {collections.map(col => (
                <TouchableOpacity
                  key={col.id}
                  style={[styles.catalogCard, newItemCollectionId === col.id && { borderColor: COLORS.blue, borderWidth: 1.5 }]}
                  onPress={() => { setNewItemCollectionId(col.id); setColPickerOpen(false); }}
                  activeOpacity={0.75}
                >
                  <View style={[styles.catalogItemPlaceholder, { backgroundColor: 'rgba(30,156,240,0.10)' }]}>
                    <AppText style={{ fontSize: 20 }}>{col.emoji || '📦'}</AppText>
                  </View>
                  <View style={styles.catalogItemContent}>
                    <AppText style={[styles.catalogItemName, { color: textColor, fontFamily }]}>{col.name}</AppText>
                    <AppText style={[styles.catalogItemDesc, { color: FG.secondary }]}>
                      {catalog.filter(i => i.collectionId === col.id).length} items
                    </AppText>
                  </View>
                  {newItemCollectionId === col.id && <AppIcon name="checkmark-circle" size={20} color={COLORS.blue} fixedColor />}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Work Hours Modal ── */}
      <Modal
        visible={hoursModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setHoursModalOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { maxHeight: '90%' }]}>
            <View style={styles.modalHandle} />

            {pickerVisible ? (
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
                              if (isCompanion) { guardEdit(); return; }
                              const updated = { ...workSchedule };
                              if (val) {
                                updated[day] = { open: '8:00 AM', close: '5:00 PM' };
                              } else {
                                updated[day] = { open: 'Closed', close: 'Closed' };
                              }
                              setWorkSchedule(updated);
                              saveWorkSchedule(updated);
                            }}
                            disabled={isCompanion}
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
                                disabled={isCompanion}
                              >
                                <AppText style={[styles.timePillText, { color: textColor, fontFamily }]}>{schedule.open}</AppText>
                              </TouchableOpacity>
                              <AppText style={{ color: COLORS.sub, fontSize: 12 }}>to</AppText>
                              <TouchableOpacity
                                style={styles.timePill}
                                onPress={() => openTimePicker(day, 'close')}
                                disabled={isCompanion}
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

      {/* ── Time Picker Modal ── */}
      <DateTimePickerModal
        isVisible={pickerVisible}
        mode="time"
        date={pickerDate}
        onConfirm={confirmTime}
        onCancel={() => { setPickerVisible(false); setPickerTarget(null); }}
        is24Hour={false}
      />

      {/* ── Catalog Share Sheet ── */}
      {shareItem && (
        <CatalogShareSheet
          visible={!!shareItem}
          item={shareItem}
          onClose={() => setShareItem(null)}
        />
      )}

      {/* ── Industry Picker Modal ── */}
      <Modal
        visible={industryModalOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIndustryModalOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: 'transparent' }}>
          <AppBg />
          <View style={[ { paddingTop: 20 }]}>
            <TouchableOpacity onPress={() => setIndustryModalOpen(false)} style={{ width: 36 }}>
              <AppIcon name="close" size={22} color={COLORS.text} />
            </TouchableOpacity>
            <AppText style={[styles.modalTitle, { color: textColor, fontFamily }]}>
              Select Industry
            </AppText>
            <View style={{ width: 36 }} />
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40, gap: 8 }}>
            {INDUSTRY_CATEGORIES.map((cat) => {
              const selected = industry === cat.id;
              return (
                <TouchableOpacity
                  key={cat.id}
                  style={[styles.industryOption, selected && styles.industryOptionSelected, { backgroundColor: selected ? COLORS.blue : 'rgba(255,255,255,0.7)' }]}
                  activeOpacity={0.8}
                  onPress={() => saveIndustry(cat.id)}
                >
                  <AppText style={[styles.industryEmoji]}>{cat.emoji}</AppText>
                  <AppText style={[styles.industryLabel, { color: selected ? '#fff' : textColor, fontFamily }]}>
                    {cat.label}
                  </AppText>
                  {selected && <AppIcon name="checkmark-circle" size={20} color="#fff" fixedColor />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

// ─── CatalogItemRow ───────────────────────────────────────────────────────────
function CatalogItemRow({
  item, textColor, fgSecondary, fontFamily, onShare, onRemove, hideRemove,
}: {
  item: import('../types').CatalogItem;
  textColor: string;
  fgSecondary: string;
  fontFamily: string;
  onShare: () => void;
  onRemove: () => void;
  hideRemove?: boolean;
}) {
  return (
    <View style={styles.catalogCard}>
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
          <AppText style={[styles.catalogItemPrice, { fontFamily }]}>{item.price}</AppText>
        ) : null}
        {item.description ? (
          <AppText style={[styles.catalogItemDesc, { color: fgSecondary, fontFamily }]} numberOfLines={2}>
            {item.description}
          </AppText>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={onShare}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={styles.deleteBtn}
      >
        <AppIcon name="share-social-outline" size={20} color={COLORS.blue} fixedColor />
      </TouchableOpacity>
      {!hideRemove && (
        <TouchableOpacity
          onPress={onRemove}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={styles.deleteBtn}
        >
          <AppIcon name="close-circle" size={20} color={COLORS.missed} fixedColor />
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Collection modal styles ──────────────────────────────────────────────────
const TILE_SIZE = 150;

const colModalStyles = StyleSheet.create({
  stepDot:  { width: 8, height: 8, borderRadius: 4, flex: 0 },
  stepLine: { flex: 1, height: 2, marginHorizontal: 4 },

  nextBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: RADIUS.full,
  },
  nextBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  stepHint: { fontSize: 12, marginBottom: 8, marginLeft: 2 },

  productGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    paddingBottom: 20,
    paddingTop: 4,
  },
  productTile: {
    width: TILE_SIZE,
    borderRadius: RADIUS.md,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderWidth: 2,
    borderColor: 'transparent',
    ...SHADOW.card,
  },
  productTileSelected: {
    borderColor: COLORS.blue,
  },
  productTileImg: {
    width: TILE_SIZE,
    height: TILE_SIZE,
  },
  productTileImgPlaceholder: {
    width: TILE_SIZE,
    height: TILE_SIZE * 0.7,
    backgroundColor: 'rgba(30,156,240,0.07)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOverlay: {
    position: 'absolute',
    top: 0, left: 0,
    width: TILE_SIZE,
    height: TILE_SIZE,
  },
  checkOverlayGrad: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  productTileInfo: {
    padding: 8,
    gap: 2,
  },
  productTileName:  { fontSize: 12, fontWeight: '700' },
  productTilePrice: { fontSize: 12, fontWeight: '800', color: COLORS.blue },

  previewStrip: {
    paddingHorizontal: 2,
    paddingBottom: 12,
    gap: 8,
    flexDirection: 'row',
  },
  previewChip: {
    alignItems: 'center',
    gap: 4,
    width: 60,
  },
  previewChipImg: {
    width: 52, height: 52, borderRadius: 10,
  },
  previewChipPlaceholder: {
    width: 52, height: 52, borderRadius: 10,
    backgroundColor: 'rgba(30,156,240,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  previewChipName: {
    fontSize: 10, fontWeight: '600', textAlign: 'center',
    maxWidth: 58,
  },
});

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

  // Companion notice
  noticeCard: {
    flexDirection: 'row', gap: 12,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 14,
  },
  noticeIconWrap: {
    width: 38, height: 38, borderRadius: 11,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
    ...SHADOW.button,
  },
  noticeTitle: { fontSize: 13, fontWeight: '800', marginBottom: 3 },
  noticeBody:  { fontSize: 12, lineHeight: 17 },

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

  section:       { gap: 8 },
  sectionTitle:  { fontSize: 12, fontWeight: '700', letterSpacing: 0.8, color: COLORS.sub, marginBottom: 4, marginLeft: 2 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },

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

  addBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 8,
  },
  addBtnText: { fontSize: 13, fontWeight: '600', color: COLORS.blue },

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
    width: 120,
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

  collectionGroup: {
    borderRadius: 14,
    overflow: 'hidden',
    marginBottom: 4,
    backgroundColor: 'rgba(255,255,255,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)',
  },
  collectionHeader: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  collectionHeaderLeft: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    flex: 1,
  },
  collectionIconWrap: {
    width: 38, height: 38, borderRadius: 10,
    backgroundColor: 'rgba(30,156,240,0.10)',
    alignItems: 'center' as const, justifyContent: 'center' as const,
  },
  collectionEmoji:  { fontSize: 20 },
  collectionName:   { fontSize: 14, fontWeight: '700' as const },
  collectionCount:  { fontSize: 11, marginTop: 1 },
  colEmptyHint:     { paddingHorizontal: 14, paddingBottom: 12 },

  // ── Industry picker ──────────────────────────────────────────────────────
  industryOption: {
    flexDirection:     'row',
    alignItems:        'center',
    gap:               12,
    borderRadius:      RADIUS.md,
    paddingHorizontal: 16,
    paddingVertical:   14,
    borderWidth:       1,
    borderColor:       'rgba(255,255,255,0.7)',
  },
  industryOptionSelected: {
    borderColor: COLORS.blue,
  },
  industryEmoji: { fontSize: 22, width: 30 },
  industryLabel: { flex: 1, fontSize: 15, fontWeight: '500' },
});