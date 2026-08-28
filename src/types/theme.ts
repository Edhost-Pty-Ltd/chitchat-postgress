// ─── Design Tokens — Light Sky Blue Glass ────────────────────────────────────

export const COLORS = {
  // ── Backgrounds ───────────────────────────────────────────────────────
  sky1:      '#C5E8F7',
  sky2:      '#87CEEB',
  sky3:      '#E8F6FF',
  bg1:       '#C5E8F7',
  bg2:       '#E8F6FF',

  // ── Brand blues ────────────────────────────────────────────────────────
  blue:      '#1E9CF0',
  blueDark:  '#0a72c4',
  blueDeep:  '#0a72c4',
  blueGlow:  'rgba(30,156,240,0.30)',

  // ── Glass surfaces — sky-blue tint, truly transparent ────────────────────
  glass:         'rgba(135,206,235,0.25)',
  glassMid:      'rgba(135,206,235,0.32)',
  glassHigh:     'rgba(135,206,235,0.40)',
  glassBorder:   'rgba(255,255,255,0.55)',
  glassBorderSub:'rgba(30,156,240,0.20)',

  // ── Text ───────────────────────────────────────────────────────────────
  text:      '#1a2840',
  sub:       '#5a7fa0',
  textSub:   '#5a7fa0',
  textFaint: 'rgba(90,127,160,0.55)',

  // ── Utility ────────────────────────────────────────────────────────────
  white:     '#ffffff',
  missed:    '#e84343',
  green:     '#22c55e',
  amber:     '#f59e0b',
  border:    'rgba(30,156,240,0.14)',
  cardBg:    'rgba(135,206,235,0.25)',
  inputBg:   'rgba(135,206,235,0.20)',

  // ── Bg gradient aliases ────────────────────────────────────────────────
  bgGrad1:   '#87CEEB',
  bgGrad2:   '#C5E8F7',
  bgGrad3:   '#E8F6FF',
} as const;

export const GRADIENTS = {
  primary:  ['#1E9CF0', '#0a72c4']                               as [string, string],
  sky:      ['#0a72c4', '#1E9CF0', '#87CEEB']                    as [string, string, string],
  bg:       ['#87CEEB', '#C5E8F7', '#E8F6FF']                    as [string, string, string],
  card:     ['rgba(135,206,235,0.30)', 'rgba(135,206,235,0.15)'] as [string, string],
  glow:     ['rgba(30,156,240,0.35)',  'rgba(30,156,240,0.0)']   as [string, string],
  chatSent: ['#1E9CF0', '#0a72c4']                               as [string, string],
  chatRecv: ['rgba(135,206,235,0.35)', 'rgba(135,206,235,0.20)'] as [string, string],
} as const;

export const GLASS = {
  // Clean flat cards — solid soft-white surface, no glass rim.
  card: {
    backgroundColor: 'rgba(255,255,255,0.85)',
    borderWidth: 0,
  },
  elevated: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderWidth: 0,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.7)',
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

// 3D glass shadows — light comes from top-left
export const SHADOW = {
  card: {
    shadowColor:   '#0e6ea8',
    shadowOffset:  { width: 2, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius:  10,
    elevation:     4,
  },
  button: {
    shadowColor:   '#1E9CF0',
    shadowOffset:  { width: 0, height: 4 },
    shadowOpacity: 0.40,
    shadowRadius:  12,
    elevation:     10,
  },
  glow: {
    shadowColor:   '#1E9CF0',
    shadowOffset:  { width: 0, height: 0 },
    shadowOpacity: 0.45,
    shadowRadius:  20,
    elevation:     14,
  },
} as const;
