import { EditorView, type Command, type KeyBinding } from '@codemirror/view';
import { Prec, type Extension } from '@codemirror/state';
import { insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import {
  deleteMarkerBackward,
  endEmptyItem,
  inlineCommand,
  lineCommand,
  toggleChecksCommand,
  type InlineStyle,
  type LineStyle,
} from './format';
import type { EditorState, TransactionSpec } from '@codemirror/state';

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
 *
 * Headings toggle from their shortcuts (⌘⇧H on a heading makes it Normal); the style menu sets.
 *
 * Lists continue as in Notes: Enter on an item starts the next one ("- ", the next number,
 * "- [ ] ", "> "; @codemirror/lang-markdown's insertNewlineContinueMarkup, which reads the same
 * syntax tree since the writing language shares its language data). Enter on an empty item ends
 * the list at once and Backspace right after a marker removes it (format.ts: lang-markdown would
 * first loosen the list / leave the marker's indent). All are normal, recorded transactions.
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

const spec = (view: Parameters<Command>[0], f: (s: EditorState) => TransactionSpec | null) => {
  const s = f(view.state);
  if (s) view.dispatch(s);
  return !!s;
};

/** editing commands only where the text can change (a read-only view falls through to the defaults) */
const writable =
  (c: Command): Command =>
  (view) =>
    !view.state.readOnly && c(view);

/** the key-event fields a shortcut is matched on */
export type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** a key's base name: the letter typed (any case), else the physical number key, else "'" */
function baseKey(e: KeyLike): string | null {
  if (e.key.length === 1 && /[a-z]/i.test(e.key)) return e.key.toLowerCase();
  const num = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
  if (num) return num[1]!;
  if (/^\d$/.test(e.key)) return e.key;
  if (e.key === "'" || e.code === 'Quote') return "'";
  return null;
}

/**
 * Which formatting shortcut a key event is, matched on exact modifiers: Shift must be held for a
 * shifted chord and must not be for an unshifted one. (CodeMirror's keymap drops Shift when it
 * looks up a typed character, so on Linux, where Ctrl+Shift+B can arrive as key "b", Ctrl ⇧B
 * ran Bold instead of Normal.) The other platform modifier and Alt must be up.
 */
export function matchShortcut(e: KeyLike, mac: boolean): FormatId | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  const key = baseKey(e);
  if (!key) return null;
  for (const [id, s] of Object.entries(SHORTCUTS) as [FormatId, Shortcut][]) {
    const parts = ((mac && s.mac) || s.key).split('-');
    const last = parts.pop()!.toLowerCase();
    if (last === key && parts.includes('Shift') === e.shiftKey) return id;
  }
  return null;
}

const isApple = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** the formatting shortcuts, ahead of every keymap (read-only views take the key and do nothing) */
export const formatShortcuts: Extension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(e, view) {
      const id = matchShortcut(e, isApple());
      if (!id) return false;
      e.preventDefault();
      SHORTCUTS[id].run(view);
      return true;
    },
  }),
);

export const formatKeymap: KeyBinding[] = [
  { key: 'Mod-Enter', run: toggleChecksCommand },
  { key: 'Enter', run: writable((v) => spec(v, endEmptyItem) || insertNewlineContinueMarkup(v)) },
  { key: 'Backspace', run: writable((v) => spec(v, deleteMarkerBackward)) },
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
