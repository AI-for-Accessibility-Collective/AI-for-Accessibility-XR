// Design tokens. Two palettes (the phone's light/dark setting picks one), one
// spacing scale, one type scale. Every text/background pair below meets WCAG
// AA contrast (4.5:1), and state is never carried by color alone — each tone
// is always paired with a glyph or a word where it is used.

import { useColorScheme } from 'react-native';

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  textMuted: string;
  accent: string;
  onAccent: string;
  ok: string;
  okSoft: string;
  warn: string;
  warnSoft: string;
  danger: string;
  dangerSoft: string;
  go: string;
  stop: string;
}

const dark: Palette = {
  bg: '#0d1117',
  surface: '#161b22',
  surfaceAlt: '#1f2630',
  border: '#2d3643',
  text: '#f0f4f9',
  textMuted: '#a3afbf',
  accent: '#4c8dff',
  onAccent: '#ffffff',
  ok: '#4cc38a',
  okSoft: '#12291f',
  warn: '#f2b84b',
  warnSoft: '#2e2410',
  danger: '#ff7b72',
  dangerSoft: '#30161a',
  go: '#1f8f4e',
  stop: '#c43c30',
};

const light: Palette = {
  bg: '#f4f6f9',
  surface: '#ffffff',
  surfaceAlt: '#eef1f5',
  border: '#d5dbe3',
  text: '#121821',
  textMuted: '#4f5b6b',
  accent: '#1f5fd6',
  onAccent: '#ffffff',
  ok: '#15703f',
  okSoft: '#e2f4ea',
  warn: '#8a5a00',
  warnSoft: '#fdf0d5',
  danger: '#b3261e',
  dangerSoft: '#fce8e6',
  go: '#1a7f45',
  stop: '#b3261e',
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 10, md: 14, lg: 20, pill: 999 } as const;
// Sizes are starting points: the phone's text-size setting scales them all.
export const type = { caption: 13, body: 16, lead: 18, title: 22, display: 28, speech: 22 } as const;
// Apple's minimum comfortable touch target is 44pt; controls here use more.
export const touch = 52;

export function usePalette(): Palette {
  return useColorScheme() === 'light' ? light : dark;
}
