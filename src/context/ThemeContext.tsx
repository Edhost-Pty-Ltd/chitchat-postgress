// ─── Theme / Background & Typography Context ─────────────────────────────────
import React, {
  createContext, useContext, useEffect, useMemo, useState, memo,
} from 'react';
import {
  ImageBackground, StyleSheet, View, ViewStyle,
  Text, TextProps, TextStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Gradient presets ─────────────────────────────────────────────────────────

export interface GradientPreset {
  id: string;
  label: string;
  colors: [string, string, ...string[]];
}

export const GRADIENT_PRESETS: GradientPreset[] = [
  { id: 'sky',       label: 'Default Light', colors: ['#F2F2F7', '#F2F2F7', '#FFFFFF'] },
  { id: 'ocean',     label: 'Ocean',     colors: ['#0f2027', '#203a43', '#2c5364'] },
  { id: 'sunset',    label: 'Sunset',    colors: ['#f7971e', '#ffd200', '#f7971e'] },
  { id: 'rose',      label: 'Rose',      colors: ['#f953c6', '#b91d73', '#f953c6'] },
  { id: 'forest',    label: 'Forest',    colors: ['#134e5e', '#71b280', '#134e5e'] },
  { id: 'midnight',  label: 'Midnight',  colors: ['#0f0c29', '#302b63', '#24243e'] },
  { id: 'peach',     label: 'Peach',     colors: ['#ed8d72', '#f6d365', '#ed8d72'] },
  { id: 'lavender',  label: 'Lavender',  colors: ['#c471ed', '#a1c4fd', '#c471ed'] },
  { id: 'mint',      label: 'Mint',      colors: ['#a8edea', '#fed6e3', '#a8edea'] },
  { id: 'charcoal',  label: 'Charcoal',  colors: ['#2c3e50', '#4a5568', '#2c3e50'] },
];

// ─── Typography presets ───────────────────────────────────────────────────────

export interface FontPreset {
  id: string;
  label: string;
  fontFamily: string;
  style: 'normal' | 'italic';
  weight: '400' | '600' | '700' | '800';
}

export const FONT_PRESETS: FontPreset[] = [
  { id: 'system',    label: 'System Default', fontFamily: 'System',                style: 'normal', weight: '400' },
  { id: 'serif',     label: 'Serif',          fontFamily: 'Georgia',               style: 'normal', weight: '400' },
  { id: 'mono',      label: 'Monospace',      fontFamily: 'Courier New',           style: 'normal', weight: '400' },
  { id: 'rounded',   label: 'Rounded',        fontFamily: 'Arial Rounded MT Bold', style: 'normal', weight: '700' },
  { id: 'cursive',   label: 'Cursive',        fontFamily: 'Palatino',              style: 'italic', weight: '400' },
  { id: 'condensed', label: 'Condensed',      fontFamily: 'Arial Narrow',          style: 'normal', weight: '600' },
];

export const TEXT_COLOR_PRESETS = [
  { id: 'auto',    label: 'Auto',       hex: null         },
  { id: 'white',   label: 'White',      hex: '#ffffff'    },
  { id: 'black',   label: 'Black',      hex: '#0a0a0a'    },
  { id: 'blue',    label: 'Ocean Blue', hex: '#09B2EE'    },
  { id: 'indigo',  label: 'Indigo',     hex: '#6366f1'    },
  { id: 'rose',    label: 'Rose',       hex: '#f43f5e'    },
  { id: 'amber',   label: 'Amber',      hex: '#f59e0b'    },
  { id: 'emerald', label: 'Emerald',    hex: '#10b981'    },
  { id: 'violet',  label: 'Violet',     hex: '#8b5cf6'    },
  { id: 'coral',   label: 'Coral',      hex: '#fb7185'    },
];

// ─── Icon colour presets ──────────────────────────────────────────────────────

export const ICON_COLOR_PRESETS = [
  { id: 'auto',    label: 'Auto',       hex: null         }, // uses FG.icon (adapts to bg)
  { id: 'blue',    label: 'Blue',       hex: '#09B2EE'    },
  { id: 'white',   label: 'White',      hex: '#ffffff'    },
  { id: 'black',   label: 'Black',      hex: '#0a0a0a'    },
  { id: 'indigo',  label: 'Indigo',     hex: '#6366f1'    },
  { id: 'rose',    label: 'Rose',       hex: '#f43f5e'    },
  { id: 'amber',   label: 'Amber',      hex: '#f59e0b'    },
  { id: 'emerald', label: 'Emerald',    hex: '#10b981'    },
  { id: 'violet',  label: 'Violet',     hex: '#8b5cf6'    },
  { id: 'coral',   label: 'Coral',      hex: '#fb7185'    },
  { id: 'teal',    label: 'Teal',       hex: '#0d9488'    },
  { id: 'gold',    label: 'Gold',       hex: '#d97706'    },
];

// ─── Combined preferences ─────────────────────────────────────────────────────

export interface TypographyPrefs {
  fontId:       string;
  textColorId:  string;
  iconColorId:  string;
}

const DEFAULT_TYPOGRAPHY: TypographyPrefs = {
  fontId:      'system',
  textColorId: 'auto',
  iconColorId: 'auto',
};

// ─── Luminance helpers ────────────────────────────────────────────────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace('#', '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16),
      g: parseInt(clean[1] + clean[1], 16),
      b: parseInt(clean[2] + clean[2], 16),
    };
  }
  if (clean.length === 6) {
    return {
      r: parseInt(clean.slice(0, 2), 16),
      g: parseInt(clean.slice(2, 4), 16),
      b: parseInt(clean.slice(4, 6), 16),
    };
  }
  return null;
}

function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0.5;
  const chan = [rgb.r, rgb.g, rgb.b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2];
}

function isHexDark(hex: string): boolean {
  return relativeLuminance(hex) < 0.35;
}

// ─── Adaptive foreground tokens ───────────────────────────────────────────────

export interface ForegroundTokens {
  primary:     string;
  secondary:   string;
  faint:       string;
  icon:        string;
  glassBg:     string;
  glassBorder: string;
  // Beveled glass rim — directional borders give a 3D edge with a clear centre.
  // Light hits top/left (bright), bottom/right sits in shadow (dark).
  bevelBorder: string;
  bevelTop:    string;
  bevelLeft:   string;
  bevelBottom: string;
  bevelRight:  string;
}

const LIGHT_FG: ForegroundTokens = {
  primary:     '#1C1C1E',
  secondary:   '#8E8E93',
  faint:       'rgba(142,142,147,0.60)',
  icon:        '#8E8E93',
  glassBg:     '#FFFFFF',
  glassBorder: 'rgba(0,0,0,0.08)',
  bevelBorder: 'rgba(0,0,0,0.06)',
  bevelTop:    'rgba(255,255,255,0.90)',
  bevelLeft:   'rgba(255,255,255,0.60)',
  bevelBottom: 'rgba(0,0,0,0.06)',
  bevelRight:  'rgba(0,0,0,0.04)',
};

const DARK_FG: ForegroundTokens = {
  primary:     '#ffffff',
  secondary:   'rgba(255,255,255,0.75)',
  faint:       'rgba(255,255,255,0.45)',
  icon:        'rgba(255,255,255,0.80)',
  glassBg:     'rgba(255,255,255,0.15)',
  glassBorder: 'rgba(255,255,255,0.30)',
  // On dark backgrounds a dark shadow edge is invisible, so every edge uses a
  // white rim (brightest on top for the 3D highlight, dimmer on the bottom).
  // This keeps the full glass outline visible, matching the light-mode look.
  bevelBorder: 'rgba(255,255,255,0.30)',
  bevelTop:    'rgba(255,255,255,0.85)',
  bevelLeft:   'rgba(255,255,255,0.55)',
  bevelBottom: 'rgba(255,255,255,0.30)',
  bevelRight:  'rgba(255,255,255,0.38)',
};

// ─── Background type ──────────────────────────────────────────────────────────

export type BgType = 'gradient' | 'image' | 'color';

export interface AppBackground {
  type:        BgType;
  gradientId?: string;
  imageUri?:   string;
  color?:      string;
}

const DEFAULT_BG: AppBackground   = { type: 'gradient', gradientId: 'sky' };
const STORAGE_KEY_BG   = 'app_background_v2';
const STORAGE_KEY_TYPO = 'app_typography_v2';

// ─── Context ──────────────────────────────────────────────────────────────────

interface ThemeContextValue {
  background:    AppBackground;
  setBackground: (bg: AppBackground) => Promise<void>;
  isDark:        boolean;
  FG:            ForegroundTokens;
  typography:    TypographyPrefs;
  setTypography: (t: TypographyPrefs) => Promise<void>;
  fontFamily:    string;
  textColor:     string;
  /** Resolved icon colour for use in <AppIcon> */
  iconColor:     string;
}

const ThemeContext = createContext<ThemeContextValue>({
  background:    DEFAULT_BG,
  setBackground: async () => {},
  isDark:        false,
  FG:            LIGHT_FG,
  typography:    DEFAULT_TYPOGRAPHY,
  setTypography: async () => {},
  fontFamily:    'System',
  textColor:     LIGHT_FG.primary,
  iconColor:     LIGHT_FG.icon,
});

// ─── isDark helper ────────────────────────────────────────────────────────────

function computeIsDark(bg: AppBackground): boolean {
  if (bg.type === 'image') return true;
  if (bg.type === 'color' && bg.color) return isHexDark(bg.color);
  if (bg.type === 'gradient') {
    const preset = GRADIENT_PRESETS.find((p) => p.id === bg.gradientId) ?? GRADIENT_PRESETS[0];
    const lum = (relativeLuminance(preset.colors[0]) + relativeLuminance(preset.colors[1])) / 2;
    return lum < 0.35;
  }
  return false;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [background, setBackgroundState] = useState<AppBackground>(DEFAULT_BG);
  const [typography, setTypographyState] = useState<TypographyPrefs>(DEFAULT_TYPOGRAPHY);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY_BG),
      AsyncStorage.getItem(STORAGE_KEY_TYPO),
    ]).then(([bgRaw, typoRaw]) => {
      if (bgRaw) {
        try { setBackgroundState(JSON.parse(bgRaw)); } catch {}
      }
      if (typoRaw) {
        try {
          // Merge with defaults so any new fields added later (e.g. iconColorId)
          // are present even when loading old saved data that predates them.
          const saved = JSON.parse(typoRaw);
          setTypographyState({ ...DEFAULT_TYPOGRAPHY, ...saved });
        } catch {}
      }
    });
  }, []);

  const setBackground = async (bg: AppBackground) => {
    setBackgroundState(bg);
    await AsyncStorage.setItem(STORAGE_KEY_BG, JSON.stringify(bg));
  };

  const setTypography = async (t: TypographyPrefs) => {
    setTypographyState(t);
    await AsyncStorage.setItem(STORAGE_KEY_TYPO, JSON.stringify(t));
  };

  const isDark = useMemo(() => computeIsDark(background), [background]);
  const FG     = isDark ? DARK_FG : LIGHT_FG;

  const fontFamily = useMemo(() => {
    const preset = FONT_PRESETS.find((f) => f.id === typography.fontId) ?? FONT_PRESETS[0];
    return preset.fontFamily;
  }, [typography.fontId]);

  const textColor = useMemo(() => {
    const preset = TEXT_COLOR_PRESETS.find((c) => c.id === typography.textColorId);
    return preset?.hex ?? FG.primary;
  }, [typography.textColorId, FG.primary]);

  const iconColor = useMemo(() => {
    const preset = ICON_COLOR_PRESETS.find((c) => c.id === typography.iconColorId);
    return preset?.hex ?? FG.icon;
  }, [typography.iconColorId, FG.icon]);

  // ── Memoized provider value — only re-creates when derived values change ──
  const value = useMemo<ThemeContextValue>(() => ({
    background, setBackground, isDark, FG,
    typography, setTypography, fontFamily, textColor, iconColor,
  }), [background, isDark, FG, typography, fontFamily, textColor, iconColor]);

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  );
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

export function useTheme() {
  return useContext(ThemeContext);
}

export function useForeground() {
  const { isDark, FG } = useContext(ThemeContext);
  return { isDark, FG };
}

export function useTypography() {
  const { fontFamily, textColor, iconColor, FG } = useContext(ThemeContext);
  return { fontFamily, textColor, iconColor, FG };
}

// ─── useGlass ─────────────────────────────────────────────────────────────────
export function useGlass() {
  const { FG } = useContext(ThemeContext);
  const isDark = FG.icon.includes('255');

  const bevel = useMemo(() => ({
    backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : '#FFFFFF',
    borderWidth: 0,
  }), [isDark]);

  const iconButton = useMemo(() => ({
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(9,178,238,0.10)',
    borderWidth: 0,
  }), [isDark]);

  return { bevel, iconButton, FG };
}

// ─── AppText ─────────────────────────────────────────────────────────────────
interface AppTextProps extends TextProps { fixedColor?: boolean; }

export const AppText = memo(function AppText({ style, children, fixedColor, ...rest }: AppTextProps) {
  const { fontFamily, textColor } = useContext(ThemeContext);
  const flat = StyleSheet.flatten(style) as TextStyle | undefined;
  return (
    <Text
      style={[flat, { fontFamily }, fixedColor ? undefined : { color: textColor }]}
      {...rest}
    >
      {children}
    </Text>
  );
});

// ─── AppIcon ─────────────────────────────────────────────────────────────────
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface AppIconProps {
  name:        IoniconName;
  size?:       number;
  color?:      string;
  fixedColor?: boolean;
  glass?:      boolean;
  tileSize?:   number;
  style?:      object;
}

export const AppIcon = memo(function AppIcon({
  name, size = 22, color, fixedColor, glass, tileSize = 40, style,
}: AppIconProps) {
  const { iconColor, FG } = useContext(ThemeContext);
  const resolvedColor = fixedColor ? (color ?? iconColor) : iconColor;
  const icon = <Ionicons name={name} size={size} color={resolvedColor} style={glass ? undefined : style} />;
  if (!glass) return icon;
  const isDark = FG.icon.includes('255');
  return (
    <View style={[{
      width: tileSize, height: tileSize, borderRadius: tileSize * 0.28,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(9,178,238,0.10)',
    }, style]}>
      {icon}
    </View>
  );
});

// ─── AppBg ───────────────────────────────────────────────────────────────────
interface AppBgProps { style?: ViewStyle; children?: React.ReactNode; }

export const AppBg = memo(function AppBg({ style, children }: AppBgProps) {
  const { background } = useContext(ThemeContext);
  if (background.type === 'image' && background.imageUri) {
    return (
      <ImageBackground
        source={{ uri: background.imageUri }}
        style={[StyleSheet.absoluteFill, style]}
        resizeMode="cover"
      >{children}</ImageBackground>
    );
  }
  if (background.type === 'color' && background.color) {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: background.color }, style]}>
        {children}
      </View>
    );
  }
  // Gradient preset — for the default 'sky' (now flat light), use solid colour for performance
  const preset = GRADIENT_PRESETS.find((p) => p.id === background.gradientId) ?? GRADIENT_PRESETS[0];
  const isFlat = preset.colors.every((c) => c === preset.colors[0]);
  if (isFlat) {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: preset.colors[0] }, style]}>
        {children}
      </View>
    );
  }
  return (
    <LinearGradient colors={preset.colors} style={[StyleSheet.absoluteFill, style]}>
      {children}
    </LinearGradient>
  );
});
