import type { FocusMode } from '../editor/focus';
import { THEME_COLOR } from './theme-colors';

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

const pickOf = <T>(x: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(x as T) ? (x as T) : fallback);
const numIn = (x: unknown, lim: { min: number; max: number }, fallback: number) =>
  typeof x === 'number' && Number.isFinite(x) ? clamp(x, lim) : fallback;

/** Stored settings come from an older version or another tab: keep only valid values. */
export function sanitizeSettings(raw: unknown): Settings {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULTS;
  return {
    theme: pickOf(s.theme, ['system', 'paper', 'night'] as const, d.theme),
    textSize: numIn(s.textSize, LIMITS.textSize, d.textSize),
    lineWidth: numIn(s.lineWidth, LIMITS.lineWidth, d.lineWidth),
    typeface: pickOf(s.typeface, Object.keys(TYPEFACES) as Typeface[], d.typeface),
    typewriter: typeof s.typewriter === 'boolean' ? s.typewriter : d.typewriter,
    focus: pickOf(s.focus, ['off', 'paragraph', 'sentence'] as const, d.focus),
    hideChrome: pickOf(s.hideChrome, ['never', 3, 10] as const, d.hideChrome),
    goal: numIn(s.goal, LIMITS.goal, d.goal),
    showProgress: typeof s.showProgress === 'boolean' ? s.showProgress : d.showProgress,
    lastExportedAt: typeof s.lastExportedAt === 'number' && Number.isFinite(s.lastExportedAt) ? s.lastExportedAt : null,
    safariHintDismissed: s.safariHintDismissed === true,
  };
}

/** The explicit theme saved synchronously by applyTheme (wins over a not-yet-committed IDB write). */
export function storedThemeChoice(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'paper' || v === 'night' ? v : null;
  } catch {
    return null;
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const resolved = resolveTheme(choice);
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[resolved]);
  try {
    if (choice === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch {
    // storage unavailable: theme still applies for this session
  }
}
