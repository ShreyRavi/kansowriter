import type { Command, KeyBinding } from '@codemirror/view';
import { inlineCommand, lineCommand, toggleChecksCommand, type InlineStyle, type LineStyle } from './format';

/**
 * Formatting shortcuts, as in Apple Notes where they don't collide (Mod = ⌘ on Apple, Ctrl elsewhere):
 *
 *   ⌘B bold · ⌘I italic · ⌘U underline · ⌘⇧X strikethrough
 *   ⌘⇧7 numbered · ⌘⇧8 bullet · ⌘⇧9 checklist · ⌘' quote · ⌘↵ check / uncheck
 *   ⌘⇧H heading · ⌘⇧J subheading · ⌘⇧B normal · ⌘⇧1 title
 *
 * Changed from Notes: Title is ⌘⇧1, not ⌘⇧T (⌘⇧T is the app's typewriter toggle and every browser's
 * "reopen closed tab", which pages can't take). Off Apple, Subheading is Ctrl ⇧G: Ctrl ⇧J opens the
 * browser's developer console in Chrome, Edge and Firefox and can't be taken either.
 */
export type FormatId = LineStyle | 'normal' | InlineStyle;

interface Shortcut {
  /** CodeMirror key (Mod- = ⌘ / Ctrl) */
  key: string;
  /** Apple-only key, when it differs */
  mac?: string;
  run: Command;
}

const line = (s: LineStyle | 'normal') => lineCommand(s);
const inline = (s: InlineStyle) => inlineCommand(s);

export const SHORTCUTS: Record<FormatId, Shortcut> = {
  title: { key: 'Mod-Shift-1', run: line('title') },
  heading: { key: 'Mod-Shift-h', run: line('heading') },
  subheading: { key: 'Mod-Shift-g', mac: 'Mod-Shift-j', run: line('subheading') },
  normal: { key: 'Mod-Shift-b', run: line('normal') },
  bullet: { key: 'Mod-Shift-8', run: line('bullet') },
  numbered: { key: 'Mod-Shift-7', run: line('numbered') },
  check: { key: 'Mod-Shift-9', run: line('check') },
  quote: { key: "Mod-'", run: line('quote') },
  bold: { key: 'Mod-b', run: inline('bold') },
  italic: { key: 'Mod-i', run: inline('italic') },
  underline: { key: 'Mod-u', run: inline('underline') },
  strike: { key: 'Mod-Shift-x', run: inline('strike') },
};

export const formatKeymap: KeyBinding[] = [
  ...Object.values(SHORTCUTS).map(({ key, mac, run }) => ({ key, mac, run, preventDefault: true })),
  { key: 'Mod-Enter', run: toggleChecksCommand },
];

/** "⌘⇧H" / "Ctrl ⇧H": the label a tooltip or menu shows for a shortcut */
export function shortcutLabel(id: FormatId, mac: boolean): string {
  const s = SHORTCUTS[id];
  const key = (mac && s.mac) || s.key;
  const parts = key.split('-');
  const last = parts.pop()!;
  const mods = parts.map((p) => (p === 'Mod' ? (mac ? '⌘' : 'Ctrl ') : p === 'Shift' ? '⇧' : p === 'Alt' ? (mac ? '⌥' : 'Alt ') : ''));
  return mods.join('') + last.toUpperCase();
}
