// ─── Design Tokens — Clean iOS Light Theme ───────────────────────────────────

export const COLORS = {
  // ── Backgrounds ───────────────────────────────────────────────────────
  sky1:      '#F2F2F7',   // page background (iOS grouped)
  sky2:      '#E5E5EA',   // slightly darker surface
  sky3:      '#FFFFFF',   // pure white surface
  bg1:       '#F2F2F7',
  bg2:       '#FFFFFF',

  // ── Brand blue ─────────────────────────────────────────────────────────
  blue:      '#007AFF',
  blueDark:  '#0060DF',
  blueDeep:  '#0060DF',
  blueGlow:  'rgba(0,122,255,0.20)',

  // ── Surfaces ──────────────────────────────────────────────────────────
  glass:         '#FFFFFF',
  glassMid:      '#FFFFFF',
  glassHigh:     '#FFFFFF',
  glassBorder:   'rgba(0,0,0,0.08)',
  glassBorderSub:'rgba(0,122,255,0.15)',

  // ── Text ───────────────────────────────────────────────────────────────
  text:      '#1C1C1E',
  sub:       '#8E8E93',
  textSub:   '#8E8E93',
  textFaint: 'rgba(142,142,147,0.60)',

  // ── Utility ────────────────────────────────────────────────────────────
  white:     '#FFFFFF',
  missed:    '#FF3B30',
  green:     '#34C759',
  amber:     '#FF9500',
  border:    'rgba(0,0,0,0.08)',
  cardBg:    '#FFFFFF',
  inputBg:   '#E9E9EB',

  // ── Bg gradient aliases (kept for compatibility — all map to flat colours) ──
  bgGrad1:   '#F2F2F7',
  bgGrad2:   '#F2F2F7',
  bgGrad3:   '#FFFFFF',
} as const;

export const GRADIENTS = {
  primary:  ['#007AFF', '#0060DF']                              as [string, string],
  sky:      ['#007AFF', '#007AFF', '#0060DF']                   as [string, string, string],
  bg:       ['#F2F2F7', '#F2F2F7', '#FFFFFF']                   as [string, string, string],
  card:     ['#FFFFFF', '#FFFFFF']                              as [string, string],
  glow:     ['rgba(0,122,255,0.15)', 'rgba(0,122,255,0.0)']    as [string, string],
  chatSent: ['#007AFF', '#007AFF']                              as [string, string],
  chatRecv: ['#FFFFFF', '#FFFFFF']                              as [string, string],
} as const;

export const GLASS = {
  card: {
    backgroundColor: '#FFFFFF',
    borderWidth: 0,
  },
  elevated: {
    backgroundColor: '#FFFFFF',
    borderWidth: 0,
  },
  input: {
    backgroundColor: '#E9E9EB',
    borderWidth: 0,
  },
  nav: {
    backgroundColor: 'transparent',
    borderTopWidth: 0,
  },
  header: {
    backgroundColor: 'transparent',
    borderBottomWidth: 0,
  },
} as const;

export const RADIUS = {
  sm:   10,
  md:   14,
  lg:   18,
  xl:   24,
  full: 999,
} as const;

export const SHADOW = {
  card: {
    shadowColor:   '#000000',
    shadowOffset:  { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius:  4,
    elevation:     2,
  },
  button: {
    shadowColor:   '#007AFF',
    shadowOffset:  { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius:  8,
    elevation:     6,
  },
  glow: {
    shadowColor:   '#007AFF',
    shadowOffset:  { width: 0, height: 0 },
    shadowOpacity: 0.20,
    shadowRadius:  12,
    elevation:     8,
  },
} as const;
