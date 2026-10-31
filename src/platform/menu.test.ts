import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import menu from '../../src-tauri/menu-shortcuts.json';
import { formatKeymap, SHORTCUTS } from '../editor/keys';
import { GLOBAL_SHORTCUTS } from '../ui/globalKeys';

/** "Alt+CmdOrCtrl+S" (Tauri) or "Mod-Shift-s" (CodeMirror) → "alt+mod+s", modifiers sorted */
function chord(s: string): string {
  const parts = s.split(/[+-]/).filter(Boolean);
  const key = parts.pop()!.toLowerCase();
  const mods = parts.map((p) => ({ CmdOrCtrl: 'mod', Cmd: 'mod', Mod: 'mod', Shift: 'shift', Alt: 'alt', Ctrl: 'ctrl' })[p] ?? p).sort();
  return [...mods, key].join('+');
}

const appChords = () => {
  const out = new Map<string, string>();
  for (const k of GLOBAL_SHORTCUTS) out.set(chord(k), `app ${k}`);
  for (const [id, s] of Object.entries(SHORTCUTS)) {
    out.set(chord(s.key), `format ${id}`);
    if (s.mac) out.set(chord(s.mac), `format ${id} (mac)`);
  }
  for (const b of formatKeymap) if (b.key?.includes('Mod')) out.set(chord(b.key), `editor ${b.key}`);
  return out;
};

describe('macOS menu key equivalents', () => {
  it('none of the custom menu items takes a shortcut the app uses (⌘⇧S dims sentences, ⌘E exports…)', () => {
    const app = appChords();
    for (const [item, accel] of Object.entries(menu.custom)) {
      if (!accel) continue;
      expect(app.get(chord(accel)), `${item} (${accel})`).toBeUndefined();
    }
  });

  it('none of the system items does either, except the Edit items that mean the same thing', () => {
    const app = appChords();
    const sameMeaning = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
    for (const [item, accel] of Object.entries(menu.system)) {
      if (sameMeaning.has(item)) continue;
      expect(app.get(chord(accel)), `${item} (${accel})`).toBeUndefined();
    }
  });

  it('menu items never share a key equivalent', () => {
    const all = [...Object.values(menu.custom), ...Object.values(menu.system)].filter((a): a is string => !!a).map(chord);
    expect(new Set(all).size).toBe(all.length);
  });

  it('the app’s list matches EditorShell’s keydown handler', () => {
    const src = readFileSync('src/ui/EditorShell.tsx', 'utf8');
    const found = new Set<string>();
    for (const m of src.matchAll(/mod && (!?)(e\.shiftKey && )?k === '(\w)'/g)) {
      const [, not, shift, key] = m;
      if (shift && !not) found.add(`mod+shift+${key}`);
      else if (shift) found.add(`mod+${key}`);
      else {
        // no Shift test: both chords (⌘E Markdown, ⌘⇧E plain text)
        found.add(`mod+${key}`);
        found.add(`mod+shift+${key}`);
      }
    }
    for (const m of src.matchAll(/mod && !e\.shiftKey && k === '(\w)'/g)) found.add(`mod+${m[1]}`);
    expect([...found].sort()).toEqual(GLOBAL_SHORTCUTS.map(chord).sort());
  });
});
