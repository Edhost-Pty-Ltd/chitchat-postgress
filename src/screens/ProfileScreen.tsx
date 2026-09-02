// ─── Screen: Profile ─────────────────────────────────────────────────────────
import React, { useRef, useState, useEffect } from 'react';
import {
  View, TouchableOpacity, StyleSheet, ScrollView,
  Image, Alert, Platform, TextInput, FlatList, Modal,
} from 'react-native';
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

// ─── Catalog Item Type ────────────────────────────────────────────────────────
interface CatalogItem {
  id: string;
  name: string;
  price: string;
  description?: string;
  imageUri?: string | null;
}

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
  const [website, setWebsite] = useState('');
  const [editingField, setEditingField] = useState<string | null>(null);
  const [draftValue, setDraftValue] = useState('');
  const fieldInputRef = useRef<TextInput>(null);

  // Work hours — structured
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const HOURS = [
    'Closed',
    '5:00 AM', '5:30 AM', '6:00 AM', '6:30 AM', '7:00 AM', '7:30 AM',
    '8:00 AM', '8:30 AM', '9:00 AM', '9:30 AM', '10:00 AM', '10:30 AM',
    '11:00 AM', '11:30 AM', '12:00 PM', '12:30 PM', '1:00 PM', '1:30 PM',
    '2:00 PM', '2:30 PM', '3:00 PM', '3:30 PM', '4:00 PM', '4:30 PM',
    '5:00 PM', '5:30 PM', '6:00 PM', '6:30 PM', '7:00 PM', '7:30 PM',
    '8:00 PM', '8:30 PM', '9:00 PM', '9:30 PM', '10:00 PM', '10:30 PM',
    '11:00 PM', '11:30 PM', '12:00 AM',
  ];

  interface DaySchedule { open: string; close: string; }
  const defaultSchedule: Record<string, DaySchedule> = {
    Monday: { open: '8:00 AM', close: '5:00 PM' },
    Tuesday: { open: '8:00 AM', close: '5:00 PM' },
    Wednesday: { open: '8:00 AM', close: '5:00 PM' },
    Thursday: { open: '8:00 AM', close: '5:00 PM' },
    Friday: { open: '8:00 AM', close: '5:00 PM' },
    Saturday: { open: 'Closed', close: 'Closed' },
    Sunday: { open: 'Closed', close: 'Closed' },
  };

  const [workSchedule, setWorkSchedule] = useState<Record<string, DaySchedule>>(defaultSchedule);
  const [hoursModalOpen, setHoursModalOpen] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<{ day: string; field: 'open' | 'close' } | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);

  // Catalog
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogModalOpen, setCatalogModalOpen] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemDesc, setNewItemDesc] = useState('');
  const [newItemImage, setNewItemImage] = useState<string | null>(null);

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
        if (userSnap.exists) {
          const data = userSnap.data()!;
          setEmail(data.email || '');
          setWebsite(data.website || '');
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

  const selectTime = (time: string) => {
    if (!pickerTarget) return;
    const updated = { ...workSchedule };
    updated[pickerTarget.day] = { ...updated[pickerTarget.day], [pickerTarget.field]: time };
    // If marking as closed, set both
    if (time === 'Closed') {
      updated[pickerTarget.day] = { open: 'Closed', close: 'Closed' };
    }
    setWorkSchedule(updated);
    setPickerVisible(false);
    setPickerTarget(null);
    saveWorkSchedule(updated);
  };

  // Format schedule summary for display
  const getScheduleSummary = (): string => {
    const openDays = DAYS.filter(d => workSchedule[d]?.open !== 'Closed');
    if (openDays.length === 0) return 'All days closed';
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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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

    const newItem: CatalogItem = {
      id: Date.now().toString(),
      name: newItemName.trim(),
      price: newItemPrice.trim(),
      description: newItemDesc.trim() || undefined,
      imageUri: newItemImage,
    };

    const updated = [...catalog, newItem];
    setCatalog(updated);
    setCatalogModalOpen(false);
    setNewItemName('');
    setNewItemPrice('');
    setNewItemDesc('');
    setNewItemImage(null);

    // Save to Firestore
    try {
      const authInstance = getAuth();
      const currentUser = authInstance.currentUser;
      if (currentUser) {
        const fsDb = db as ReturnType<typeof firestore>;
        await fsDb.collection('users').doc(currentUser.uid).update({ catalog: updated });
      }
    } catch (err) {
      console.warn('[ProfileScreen] Error saving catalog:', err);
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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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
  const EditableField = ({ field, label, icon, value, placeholder, keyboardType }: {
    field: string; label: string; icon: string; value: string; placeholder: string; keyboardType?: any;
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
          <AppText style={[styles.infoValue, { color: value ? textColor : COLORS.textFaint, fontFamily }]}>
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
            <TouchableOpacity onPress={addCatalogItem} activeOpacity={0.85} style={{ marginTop: 6 }}>
              <LinearGradient colors={GRADIENTS.primary} style={styles.modalPrimaryBtn}>
                <AppIcon name="add-circle-outline" size={18} color="#fff" fixedColor style={{ marginRight: 6 }} />
                <AppText fixedColor style={styles.modalPrimaryBtnText}>Add to Catalog</AppText>
              </LinearGradient>
            </TouchableOpacity>
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
          <View style={[styles.modalSheet, { maxHeight: '80%' }]}>
            <View style={styles.modalHandle} />
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
                    <AppText style={[styles.dayLabel, { color: textColor, fontFamily }]}>{day}</AppText>
                    <View style={styles.dayTimes}>
                      {isClosed ? (
                        <TouchableOpacity
                          style={styles.closedBadge}
                          onPress={() => { setPickerTarget({ day, field: 'open' }); setPickerVisible(true); }}
                        >
                          <AppText style={[styles.closedText, { fontFamily }]}>Closed</AppText>
                        </TouchableOpacity>
                      ) : (
                        <>
                          <TouchableOpacity
                            style={styles.timePill}
                            onPress={() => { setPickerTarget({ day, field: 'open' }); setPickerVisible(true); }}
                          >
                            <AppText style={[styles.timePillText, { color: textColor, fontFamily }]}>{schedule.open}</AppText>
                          </TouchableOpacity>
                          <AppText style={[{ color: COLORS.sub, fontSize: 12 }]}>to</AppText>
                          <TouchableOpacity
                            style={styles.timePill}
                            onPress={() => { setPickerTarget({ day, field: 'close' }); setPickerVisible(true); }}
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
          </View>
        </View>
      </Modal>

      {/* ── Time Picker Modal ── */}
      <Modal
        visible={pickerVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPickerVisible(false)}
      >
        <TouchableOpacity
          style={styles.modalOverlay}
          activeOpacity={1}
          onPress={() => setPickerVisible(false)}
        >
          <View style={styles.pickerSheet}>
            <View style={styles.modalHandle} />
            <AppText style={[styles.pickerTitle, { color: textColor, fontFamily }]}>
              {pickerTarget ? `${pickerTarget.day} — ${pickerTarget.field === 'open' ? 'Opens at' : 'Closes at'}` : 'Select Time'}
            </AppText>
            <ScrollView style={{ maxHeight: 300 }} showsVerticalScrollIndicator={false}>
              {HOURS.map((time) => (
                <TouchableOpacity
                  key={time}
                  style={[
                    styles.pickerItem,
                    pickerTarget && workSchedule[pickerTarget.day]?.[pickerTarget.field] === time && styles.pickerItemActive,
                  ]}
                  onPress={() => selectTime(time)}
                >
                  <AppText style={[
                    styles.pickerItemText,
                    { color: textColor, fontFamily },
                    pickerTarget && workSchedule[pickerTarget.day]?.[pickerTarget.field] === time && { color: COLORS.blue, fontWeight: '700' },
                  ]}>
                    {time}
                  </AppText>
                  {pickerTarget && workSchedule[pickerTarget.day]?.[pickerTarget.field] === time && (
                    <AppIcon name="checkmark" size={18} color={COLORS.blue} fixedColor />
                  )}
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </TouchableOpacity>
      </Modal>
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
    paddingBottom: 40,
    backgroundColor: '#fff',
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
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.04)',
  },
  dayLabel: { fontSize: 14, fontWeight: '600', width: 90 },
  dayTimes: { flexDirection: 'row', alignItems: 'center', gap: 8 },
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
});
