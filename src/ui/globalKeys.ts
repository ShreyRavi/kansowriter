/**
 * The editor's window-level shortcuts (EditorShell's keydown handler), Mod = ⌘ / Ctrl, as
 * CodeMirror-style chords. Kept here so the macOS menu's key equivalents can be checked against
 * them (src/platform/menu.test.ts, which also checks this list against the handler).
 */
export const GLOBAL_SHORTCUTS = [
  'Mod-k', // command palette
  'Mod-Shift-l', // send as letter
  'Mod-Shift-n', // theme
  'Mod-e', // export Markdown
  'Mod-Shift-e', // export plain text
  'Mod-Shift-t', // typewriter
  'Mod-Shift-p', // dim paragraphs
  'Mod-Shift-s', // dim sentences
] as const;
