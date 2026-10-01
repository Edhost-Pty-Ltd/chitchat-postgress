// ─── Screen: Profile ─────────────────────────────────────────────────────────
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
import { getAuth } from '@react-native-firebase/auth';
import { db } from '../config/firebase';
import { uploadFile, generateFileName } from '../config/storage';
import { useAuth } from '../context/AuthContext';
import { AppBg, AppText, AppIcon, useForeground, useTypography } from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SHADOW, GRADIENTS } from '../types/theme';
import { CatalogItem, CatalogCollection } from '../types';
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
  const [newItemCollectionId, setNewItemCollectionId] = useState<string | null>(null);
  // Share sheet state — which item is pending share
  const [shareItem, setShareItem] = useState<CatalogItem | null>(null);

  // Collections
  const [collections, setCollections] = useState<CatalogCollection[]>([]);
  // Multi-step collection creator:
  //   null        → closed
  //   'pick'      → step 1: select products
  //   'name'      → step 2: name the collection
  const [collectionStep, setCollectionStep] = useState<null | 'pick' | 'name'>(null);
  const [newColName, setNewColName] = useState('');
  const [newColEmoji, setNewColEmoji] = useState('');
  const [newColItems, setNewColItems] = useState<string[]>([]); // selected item ids
  const [savingCollection, setSavingCollection] = useState(false);
  // which collection is expanded in the catalog list (null = all visible)
  const [expandedCollection, setExpandedCollection] = useState<string | null>(null);
  // collection picker inside add-item modal
  const [colPickerOpen, setColPickerOpen] = useState(false);

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
          setCollections(data.collections || []);
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

  // ── Collection management ──────────────────────────────────────────────────
  const saveCollections = async (updated: CatalogCollection[]) => {
    setCollections(updated);
    try {
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({ collections: updated });
      }
    } catch (err) {
      console.warn('[ProfileScreen] Error saving collections:', err);
    }
  };

  const addCollection = async () => {
    if (!newColName.trim()) return;
    setSavingCollection(true);
    try {
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;

      const newCol: CatalogCollection = {
        id:        Date.now().toString(),
        name:      newColName.trim(),
        emoji:     newColEmoji.trim() || null,   // null not undefined — Firestore rejects undefined
        createdAt: Date.now(),
      };

      // Stamp the selected items with the new collection id.
      // strip() removes every undefined field before writing — Firestore rejects undefined.
      const strip = <T extends object>(obj: T): T =>
        Object.fromEntries(
          Object.entries(obj).filter(([, v]) => v !== undefined)
        ) as T;

      const updatedCatalog = catalog.map(item =>
        newColItems.includes(item.id)
          ? strip({ ...item, collectionId: newCol.id })
          : strip({ ...item }),
      );

      // Also strip undefined from the collection object itself
      const updatedCollections = [...collections, strip(newCol)];

      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({
          collections: updatedCollections,
          catalog:     updatedCatalog,
        });
      }

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
    Alert.alert(
      'Delete Collection?',
      'The collection will be removed. Items inside will become uncategorised.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            // un-assign items belonging to this collection
            const updatedCatalog = catalog.map(i =>
              i.collectionId === colId ? { ...i, collectionId: null } : i,
            );
            setCatalog(updatedCatalog);
            const updatedCols = collections.filter(c => c.id !== colId);
            try {
              const authInstance = getAuth();
              const currentUser = authInstance.currentUser;
              if (currentUser) {
                const fsDb = db as ReturnType<typeof firestore>;
                await fsDb.collection('users').doc(currentUser.uid).update({
                  catalog: updatedCatalog,
                  collections: updatedCols,
                });
              }
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
              {autoResponderPending && (
                <AppText style={{ fontSize: 12, color: COLORS.blue, marginBottom: 8, fontFamily }}>
                  ✏️  Edit your message below then tap Save to activate.
                </AppText>
              )}

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
          {/* Section header with two action buttons */}
          <View style={styles.sectionHeader}>
            <AppText style={[styles.sectionTitle, { color: COLORS.sub, fontFamily }]}>CATALOG</AppText>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <TouchableOpacity
                onPress={() => { setNewColItems([]); setCollectionStep('pick'); }}
                style={[styles.addBtn, { backgroundColor: 'rgba(9,178,238,0.08)' }]}
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
              {/* ── Collections ── */}
              {collections.map((col) => {
                const colItems = catalog.filter(i => i.collectionId === col.id);
                const isOpen = expandedCollection === col.id;
                return (
                  <View key={col.id} style={styles.collectionGroup}>
                    {/* Collection header row */}
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
                        <TouchableOpacity
                          onPress={() => removeCollection(col.id)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          style={{ padding: 4 }}
                        >
                          <AppIcon name="trash-outline" size={16} color={COLORS.missed} fixedColor />
                        </TouchableOpacity>
                        <AppIcon
                          name={isOpen ? 'chevron-up' : 'chevron-down'}
                          size={18}
                          color={COLORS.sub}
                        />
                      </View>
                    </TouchableOpacity>

                    {/* Items inside this collection */}
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
                          />
                        ))
                      )
                    )}
                  </View>
                );
              })}

              {/* ── Uncategorised items ── */}
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

              {/* Header row */}
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

                {/* Collection assignment */}
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

      {/* ── Create Collection — 2-step playlist-style modal ── */}
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

              {/* ── Step indicator ── */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, marginBottom: 16 }}>
                <View style={[colModalStyles.stepDot, { backgroundColor: COLORS.blue }]} />
                <View style={[colModalStyles.stepLine, { backgroundColor: collectionStep === 'name' ? COLORS.blue : 'rgba(0,0,0,0.10)' }]} />
                <View style={[colModalStyles.stepDot, { backgroundColor: collectionStep === 'name' ? COLORS.blue : 'rgba(0,0,0,0.15)' }]} />
              </View>

              {collectionStep === 'pick' ? (
                /* ── STEP 1: Pick products ─────────────────────────────────── */
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
                              {/* Image or placeholder */}
                              {item.imageUri ? (
                                <Image source={{ uri: item.imageUri }} style={colModalStyles.productTileImg} resizeMode="cover" />
                              ) : (
                                <View style={colModalStyles.productTileImgPlaceholder}>
                                  <AppIcon name="cube-outline" size={24} color={COLORS.blue} fixedColor />
                                </View>
                              )}
                              {/* Checkmark overlay when selected */}
                              {selected && (
                                <View style={colModalStyles.checkOverlay} pointerEvents="none">
                                  <LinearGradient colors={['rgba(9,178,238,0.55)', 'rgba(10,114,196,0.55)']} style={colModalStyles.checkOverlayGrad}>
                                    <AppIcon name="checkmark-circle" size={28} color="#fff" fixedColor />
                                  </LinearGradient>
                                </View>
                              )}
                              {/* Name + price */}
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
                /* ── STEP 2: Name the collection ───────────────────────────── */
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

                  {/* Selected items preview strip */}
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

                  {/* Emoji */}
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

                  {/* Collection name */}
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

      {/* ── Collection Picker Modal (inside Add Item flow) ── */}
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
              {/* None option */}
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
                  <View style={[styles.catalogItemPlaceholder, { backgroundColor: 'rgba(9,178,238,0.10)' }]}>
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

            {/* ── Day schedule list ── */}
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
    </View>
  );
}

// ─── CatalogItemRow ───────────────────────────────────────────────────────────
function CatalogItemRow({
  item, textColor, fgSecondary, fontFamily, onShare, onRemove,
}: {
  item: import('../types').CatalogItem;
  textColor: string;
  fgSecondary: string;
  fontFamily: string;
  onShare: () => void;
  onRemove: () => void;
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
      <TouchableOpacity
        onPress={onRemove}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={styles.deleteBtn}
      >
        <AppIcon name="close-circle" size={20} color={COLORS.missed} fixedColor />
      </TouchableOpacity>
    </View>
  );
}

// ─── Collection modal styles ──────────────────────────────────────────────────
const TILE_SIZE = 150;

const colModalStyles = StyleSheet.create({
  // Step progress indicator
  stepDot:  { width: 8, height: 8, borderRadius: 4, flex: 0 },
  stepLine: { flex: 1, height: 2, marginHorizontal: 4 },

  // Next button (step 1 header)
  nextBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: RADIUS.full,
  },
  nextBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  stepHint: { fontSize: 12, marginBottom: 8, marginLeft: 2 },

  // Product grid (step 1)
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
    backgroundColor: 'rgba(9,178,238,0.07)',
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

  // Selected items preview strip (step 2)
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
    backgroundColor: 'rgba(9,178,238,0.08)',
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
    backgroundColor: 'rgba(9,178,238,0.10)',
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
    backgroundColor: 'rgba(9,178,238,0.08)',
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
    borderColor: 'rgba(9,178,238,0.2)',
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
    width: 120,
  },
  dayLabel: { fontSize: 14, fontWeight: '600' },
  dayTimes: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'flex-end' },
  timePill: {
    paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: 'rgba(9,178,238,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(9,178,238,0.15)',
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
    backgroundColor: 'rgba(9,178,238,0.08)',
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
    borderColor: 'rgba(9,178,238,0.20)',
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

  // ── Collections ─────────────────────────────────────────────────────────────
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
    backgroundColor: 'rgba(9,178,238,0.10)',
    alignItems: 'center' as const, justifyContent: 'center' as const,
  },
  collectionEmoji:  { fontSize: 20 },
  collectionName:   { fontSize: 14, fontWeight: '700' as const },
  collectionCount:  { fontSize: 11, marginTop: 1 },
  colEmptyHint:     { paddingHorizontal: 14, paddingBottom: 12 },
}); 