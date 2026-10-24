import type { FocusMode } from '../editor/focus';

export type Typeface = 'newsreader' | 'instrument' | 'plex';
export type ThemeChoice = 'system' | 'paper' | 'night';

export interface Settings {
  theme: ThemeChoice;
  textSize: number; // 17–25
  lineWidth: number; // 560–800
  typeface: Typeface;
  typewriter: boolean;
  focus: FocusMode;
  hideChrome: 'never' | 3 | 10;
  goal: number;
  showProgress: boolean;
  lastExportedAt: number | null;
  safariHintDismissed: boolean;
}

export const DEFAULTS: Settings = {
  theme: 'system',
  textSize: 21,
  lineWidth: 680,
  typeface: 'newsreader',
  typewriter: true,
  focus: 'paragraph',
  hideChrome: 3,
  goal: 750,
  showProgress: true,
  lastExportedAt: null,
  safariHintDismissed: false,
};

export const LIMITS = {
  textSize: { min: 17, max: 25, step: 1 },
  lineWidth: { min: 560, max: 800, step: 20 },
  goal: { min: 50, max: 10_000, step: 50 },
} as const;

export const TYPEFACES: Record<Typeface, { label: string; family: string; line: number }> = {
  newsreader: { label: 'Newsreader', family: 'var(--type-writing)', line: 1.7 },
  instrument: { label: 'Instrument Sans', family: 'var(--type-sans)', line: 1.65 },
  plex: { label: 'IBM Plex Mono', family: 'var(--type-mono)', line: 1.6 },
};

/** The theme bootstrap in index.html reads this key before first paint (21A). */
export const THEME_KEY = 'kansowriter-theme';

export function clamp(n: number, { min, max }: { min: number; max: number }): number {
  return Math.min(max, Math.max(min, n));
}

export function resolveTheme(choice: ThemeChoice): 'paper' | 'night' {
  if (choice !== 'system') return choice;
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'paper';
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice);
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage unavailable: theme still applies for this session
  }
}
