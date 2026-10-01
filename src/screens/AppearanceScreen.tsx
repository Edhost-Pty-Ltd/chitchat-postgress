// ─── Screen: Appearance ──────────────────────────────────────────────────────
import React, { useState } from 'react';
import {
  View, TouchableOpacity, StyleSheet, ScrollView,
  Alert, Image, Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import {
  AppBg, AppText, AppIcon, useTheme, useGlass,
  GRADIENT_PRESETS, AppBackground,
  FONT_PRESETS, TEXT_COLOR_PRESETS, ICON_COLOR_PRESETS, TypographyPrefs,
} from '../context/ThemeContext';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SHADOW, GLASS, GRADIENTS } from '../types/theme';

const SOLID_COLORS = [
  { id: 'white',   label: 'White',    hex: '#ffffff' },
  { id: 'black',   label: 'Black',    hex: '#0a0a0a' },
  { id: 'slate',   label: 'Slate',    hex: '#475569' },
  { id: 'teal',    label: 'Teal',     hex: '#0d9488' },
  { id: 'indigo',  label: 'Indigo',   hex: '#4f46e5' },
  { id: 'rose',    label: 'Rose Red', hex: '#e11d48' },
  { id: 'amber',   label: 'Amber',    hex: '#d97706' },
  { id: 'emerald', label: 'Emerald',  hex: '#059669' },
];

export default function AppearanceScreen() {
  const navigation = useNavigation();
  const { background, setBackground, typography, setTypography } = useTheme();
  const { bevel } = useGlass();
  const insets = useSafeAreaInsets();

  const [bgPreview, setBgPreview] = useState<AppBackground>(background);
  // typoPreview reads directly from context so it's always current
  const typoPreview = typography;

  // ── Background helpers ───────────────────────────────────────────────────

  const applyBg = async (bg: AppBackground) => {
    setBgPreview(bg);
    await setBackground(bg);
  };

  const isBgActive = (bg: AppBackground): boolean => {
    if (bg.type !== bgPreview.type) return false;
    if (bg.type === 'gradient') return bg.gradientId === bgPreview.gradientId;
    if (bg.type === 'color')    return bg.color === bgPreview.color;
    if (bg.type === 'image')    return bg.imageUri === bgPreview.imageUri;
    return false;
  };

  const pickImage = async () => {
    if (Platform.OS !== 'web') {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission needed', 'Allow photo library access to set a custom background.');
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'] as any,
      allowsEditing: false,
      quality: 0.85,
    });
    if (!result.canceled && result.assets[0]) {
      applyBg({ type: 'image', imageUri: result.assets[0].uri });
    }
  };

  // ── Typography helpers ───────────────────────────────────────────────────

  const applyTypo = async (patch: Partial<TypographyPrefs>) => {
    const next = { ...typography, ...patch };
    await setTypography(next);
  };

  // Resolved values for the live preview
  const previewFont  = FONT_PRESETS.find((f) => f.id === typoPreview.fontId) ?? FONT_PRESETS[0];
  const previewColor = TEXT_COLOR_PRESETS.find((c) => c.id === typoPreview.textColorId);
  const previewIconColorPreset = ICON_COLOR_PRESETS.find((c) => c.id === typoPreview.iconColorId);
  const resolvedIconColor = previewIconColorPreset?.hex ?? '#5a7fa0';

  return (
    <View style={styles.root}>
      <AppBg />

      {/* Header */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'web' ? 16 : insets.top + 14 }]}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <AppIcon name="chevron-back" size={24} color={COLORS.blue} />
        </TouchableOpacity>
        <AppText style={styles.title}>Appearance</AppText>
        <View style={{ width: 36 }} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scroll}>

        {/* ── Live preview ── */}
        <View style={[styles.previewCard, bevel]}>
          <View style={styles.previewBg}>
            {bgPreview.type === 'image' && bgPreview.imageUri ? (
              <Image source={{ uri: bgPreview.imageUri }} style={styles.previewImg} resizeMode="cover" />
            ) : bgPreview.type === 'color' && bgPreview.color ? (
              <View style={[styles.previewImg, { backgroundColor: bgPreview.color }]} />
            ) : (
              <LinearGradient
                colors={(GRADIENT_PRESETS.find((p) => p.id === bgPreview.gradientId) ?? GRADIENT_PRESETS[0]).colors}
                style={styles.previewImg}
              />
            )}
            <View style={styles.bubbleRow}>
              <View style={styles.bubbleIn}>
                <AppText style={[styles.bubbleText, { fontFamily: previewFont.fontFamily }]}>Hey! 👋</AppText>
              </View>
            </View>
            <View style={[styles.bubbleRow, { justifyContent: 'flex-end' }]}>
              <View style={styles.bubbleOut}>
                <AppText style={[styles.bubbleTextOut, {
                  fontFamily: previewFont.fontFamily,
                  color: typoPreview.textColorId === 'auto' ? '#1a2840' : (previewColor?.hex ?? '#1a2840'),
                }]}>
                  Looks great!
                </AppText>
              </View>
            </View>
            {/* Icon colour preview row */}
            <View style={styles.iconPreviewRow}>
              {(['chatbubble', 'call', 'heart', 'star', 'notifications', 'settings'] as const).map((iconName) => (
                <AppIcon key={iconName} name={iconName} size={20} color={resolvedIconColor} fixedColor />
              ))}
            </View>
          </View>
          <AppText style={styles.previewLabel}>Preview</AppText>
        </View>

        {/* ── TYPOGRAPHY ── */}
        <View style={styles.section}>
          <AppText style={styles.sectionLabel}>FONT STYLE</AppText>
          <View style={styles.fontGrid}>
            {FONT_PRESETS.map((f) => {
              const active = typoPreview.fontId === f.id;
              return (
                <TouchableOpacity
                  key={f.id}
                  style={[styles.fontTile, active && styles.fontTileActive]}
                  onPress={() => applyTypo({ fontId: f.id })}
                  activeOpacity={0.8}
                >
                  <AppText style={[
                    styles.fontTilePreview,
                    { fontFamily: f.fontFamily, fontStyle: f.style, fontWeight: f.weight },
                    active && { color: COLORS.blue },
                  ]}>
                    Aa
                  </AppText>
                  <AppText style={[styles.fontTileLabel, active && { color: COLORS.blue }]}>{f.label}</AppText>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── TEXT COLOUR ── */}
        <View style={styles.section}>
          <AppText style={styles.sectionLabel}>TEXT COLOUR</AppText>
          <View style={styles.colorGrid}>
            {TEXT_COLOR_PRESETS.map((c) => {
              const active = typoPreview.textColorId === c.id;
              const displayColor = c.hex ?? '#1a2840';
              return (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.colorDot, active && styles.colorDotActive]}
                  onPress={() => applyTypo({ textColorId: c.id })}
                  activeOpacity={0.8}
                >
                  {c.hex === null ? (
                    // Auto — split circle
                    <LinearGradient
                      colors={['#1a2840', '#ffffff']}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                      style={styles.colorDotInner}
                    />
                  ) : (
                    <View style={[styles.colorDotInner, { backgroundColor: displayColor,
                      borderWidth: c.hex === '#ffffff' ? 1 : 0,
                      borderColor: 'rgba(0,0,0,0.15)',
                    }]} />
                  )}
                  {active && (
                    <View style={styles.colorCheck}>
                      <AppIcon name="checkmark" size={10} color={
                        c.hex === '#ffffff' || c.hex === null ? '#000' : '#fff'
                      } fixedColor />
                    </View>
                  )}
                  <AppText style={styles.colorLabel}>{c.label}</AppText>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── ICON COLOUR ── */}
        <View style={styles.section}>
          <AppText style={styles.sectionLabel}>ICON COLOUR</AppText>
          <View style={styles.colorGrid}>
            {ICON_COLOR_PRESETS.map((c) => {
              const active = typoPreview.iconColorId === c.id;
              const displayColor = c.hex ?? '#1a2840';
              return (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.colorDot, active && styles.colorDotActive]}
                  onPress={() => applyTypo({ iconColorId: c.id })}
                  activeOpacity={0.8}
                >
                  {c.hex === null ? (
                    // Auto — split circle
                    <LinearGradient
                      colors={['#1a2840', '#ffffff']}
                      start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                      style={styles.colorDotInner}
                    />
                  ) : (
                    <View style={[styles.colorDotInner, { backgroundColor: displayColor,
                      borderWidth: c.hex === '#ffffff' ? 1 : 0,
                      borderColor: 'rgba(0,0,0,0.15)',
                    }]} />
                  )}
                  {active && (
                    <View style={styles.colorCheck}>
                      <AppIcon name="checkmark" size={10} color={
                        c.hex === '#ffffff' || c.hex === null ? '#000' : '#fff'
                      } fixedColor />
                    </View>
                  )}
                  <AppText style={styles.colorLabel}>{c.label}</AppText>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── CUSTOM IMAGE ── */}
        <View style={styles.section}>
          <AppText style={styles.sectionLabel}>CUSTOM IMAGE</AppText>
          <TouchableOpacity style={[styles.photoPickerBtn, bevel]} onPress={pickImage} activeOpacity={0.8}>
            <View style={styles.photoPickerIcon}>
              <AppIcon name="image-outline" size={26} color={COLORS.blue} />
            </View>
            <View style={{ flex: 1 }}>
              <AppText style={styles.photoPickerTitle}>Choose from library</AppText>
              <AppText style={styles.photoPickerSub}>
                {bgPreview.type === 'image' ? 'Custom image selected ✓' : 'Use any photo as background'}
              </AppText>
            </View>
            <AppIcon name="chevron-forward" size={18} color={COLORS.sub} />
          </TouchableOpacity>
        </View>

        {/* ── GRADIENTS ── */}
        <View style={styles.section}>
          <AppText style={styles.sectionLabel}>GRADIENTS</AppText>
          <View style={styles.swatchGrid}>
            {GRADIENT_PRESETS.map((preset) => {
              const active = isBgActive({ type: 'gradient', gradientId: preset.id });
              return (
                <TouchableOpacity
                  key={preset.id}
                  style={[styles.swatch, active && styles.swatchActive]}
                  onPress={() => applyBg({ type: 'gradient', gradientId: preset.id })}
                  activeOpacity={0.8}
                >
                  <LinearGradient colors={preset.colors} style={styles.swatchGrad} />
                  {active && <View style={styles.swatchCheck}><AppIcon name="checkmark" size={14} color="#fff" fixedColor /></View>}
                  <AppText style={styles.swatchLabel} numberOfLines={1}>{preset.label}</AppText>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        {/* ── SOLID COLOURS ── */}
        <View style={styles.section}>
          <AppText style={styles.sectionLabel}>SOLID COLOURS</AppText>
          <View style={styles.swatchGrid}>
            {SOLID_COLORS.map((c) => {
              const active = isBgActive({ type: 'color', color: c.hex });
              return (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.swatch, active && styles.swatchActive]}
                  onPress={() => applyBg({ type: 'color', color: c.hex })}
                  activeOpacity={0.8}
                >
                  <View style={[styles.swatchGrad, { backgroundColor: c.hex }]} />
                  {active && (
                    <View style={styles.swatchCheck}>
                      <AppIcon name="checkmark" size={14} color={c.hex === '#ffffff' ? '#000' : '#fff'} fixedColor />
                    </View>
                  )}
                  <AppText style={styles.swatchLabel} numberOfLines={1}>{c.label}</AppText>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },

  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingTop: 0, paddingBottom: 12, paddingHorizontal: 14,
    gap: 8, ...GLASS.header,
  },
  backBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.8)',
  },
  title:   { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: COLORS.text },

  scroll: { padding: 16, paddingBottom: 48, gap: 20 },

  // ── Preview ──────────────────────────────────────────────────────────────
  previewCard:  { 
    borderRadius: RADIUS.xl, 
    overflow: 'hidden',
  },
  previewBg:    { height: 180, overflow: 'hidden' },
  previewImg:   { ...StyleSheet.absoluteFill },
  previewLabel: { textAlign: 'center', fontSize: 11, fontWeight: '600', color: COLORS.sub, paddingVertical: 8 },
  bubbleRow:    { flexDirection: 'row', paddingHorizontal: 14, marginTop: 18 },
  iconPreviewRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 14, paddingHorizontal: 14, marginTop: 10, marginBottom: 8,
  },
  bubbleIn: {
    backgroundColor: COLORS.blue, borderRadius: 14, borderBottomLeftRadius: 4,
    paddingHorizontal: 12, paddingVertical: 7, maxWidth: '60%',
  },
  bubbleOut: {
    backgroundColor: 'rgba(255,255,255,0.85)', borderRadius: 14, borderBottomRightRadius: 4,
    paddingHorizontal: 12, paddingVertical: 7, maxWidth: '60%',
  },
  bubbleText:    { color: '#fff', fontSize: 13 },
  bubbleTextOut: { fontSize: 13 },

  // ── Sections ─────────────────────────────────────────────────────────────
  section:      { gap: 10 },
  sectionLabel: { fontSize: 10, fontWeight: '700', color: COLORS.sub, letterSpacing: 1.2, paddingHorizontal: 2 },

  // ── Font tiles ────────────────────────────────────────────────────────────
  fontGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  fontTile: {
    width: 90, paddingVertical: 12, paddingHorizontal: 8,
    alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderRadius: RADIUS.md,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  fontTileActive: {
    borderColor: COLORS.blue,
    backgroundColor: 'rgba(74,153,233,0.08)',
  },
  fontTilePreview:{ fontSize: 26, color: COLORS.text },
  fontTileLabel:  { fontSize: 9, fontWeight: '600', color: COLORS.sub, textAlign: 'center' },

  // ── Text colour dots ──────────────────────────────────────────────────────
  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  colorDot: {
    alignItems: 'center', gap: 4,
    borderRadius: RADIUS.sm, padding: 3,
    borderWidth: 2, borderColor: 'transparent',
  },
  colorDotActive:  { borderColor: COLORS.blue },
  colorDotInner:   { width: 36, height: 36, borderRadius: 18 },
  colorCheck: {
    position: 'absolute', top: 6, right: 0,
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: COLORS.blue,
    alignItems: 'center', justifyContent: 'center',
  },
  colorLabel: { fontSize: 9, fontWeight: '500', color: COLORS.sub, textAlign: 'center', maxWidth: 42 },

  // ── Photo picker ──────────────────────────────────────────────────────────
  photoPickerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    borderRadius: RADIUS.lg,
    paddingHorizontal: 14, paddingVertical: 14,
  },
  photoPickerIcon: {
    width: 46, height: 46, borderRadius: RADIUS.md,
    backgroundColor: 'rgba(74,153,233,0.12)',
    borderWidth: 1, borderColor: 'rgba(74,153,233,0.20)',
    alignItems: 'center', justifyContent: 'center',
  },
  photoPickerTitle: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  photoPickerSub:   { fontSize: 12, color: COLORS.sub, marginTop: 2 },

  // ── Swatches ──────────────────────────────────────────────────────────────
  swatchGrid:   { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch:       { width: 72, alignItems: 'center', gap: 5, padding: 3, borderRadius: RADIUS.md, borderWidth: 2, borderColor: 'transparent' },
  swatchActive: { 
    borderColor: COLORS.blue,
    shadowColor: '#4A99E9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.40,
    shadowRadius: 12,
    elevation: 10,
  },
  swatchGrad:   { width: 66, height: 50, borderRadius: RADIUS.sm, overflow: 'hidden' },
  swatchCheck: {
    position: 'absolute', top: 18, right: 6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: COLORS.blue, 
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#4A99E9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.40,
    shadowRadius: 12,
    elevation: 10,
  },
  swatchLabel: { fontSize: 10, fontWeight: '500', color: COLORS.sub, textAlign: 'center' },
});
