// ─── Design Tokens — Clean iOS Light Theme ───────────────────────────────────

export const COLORS = {
  // ── Backgrounds — pure white throughout ──────────────────────────────────
  sky1:      '#FFFFFF',   // page background
  sky2:      '#F2F2F7',   // subtle grey surface (dividers / insets)
  sky3:      '#FFFFFF',   // pure white surface
  bg1:       '#FFFFFF',
  bg2:       '#FFFFFF',

  // ── Brand blue — sparkly pool cyan ───────────────────────────────────────
  blue:      '#09B2EE',
  blueDark:  '#0890C9',
  blueDeep:  '#0890C9',
  blueGlow:  'rgba(9,178,238,0.20)',

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
  primary:  ['#09B2EE', '#0890C9']                              as [string, string],
  sky:      ['#09B2EE', '#09B2EE', '#0890C9']                   as [string, string, string],
  bg:       ['#FFFFFF', '#FFFFFF', '#FFFFFF']                   as [string, string, string],
  card:     ['#FFFFFF', '#FFFFFF']                              as [string, string],
  glow:     ['rgba(9,178,238,0.15)', 'rgba(9,178,238,0.0)']    as [string, string],
  chatSent: ['#09B2EE', '#09B2EE']                              as [string, string],
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
    shadowColor:   '#09B2EE',
    shadowOffset:  { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius:  8,
    elevation:     6,
  },
  glow: {
    shadowColor:   '#09B2EE',
    shadowOffset:  { width: 0, height: 0 },
    shadowOpacity: 0.20,
    shadowRadius:  12,
    elevation:     8,
  },
} as const;
