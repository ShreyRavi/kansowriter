import type { StorageAdapter } from '../core/storage';
import type { ChannelMessage } from '../storage/lifecycle';

/**
 * What the macOS app adds to the shared UI (linked Markdown files, .kanso files, the File menu),
 * as an interface only: the implementation lives in src/platform (desktop build only), so the
 * web app never bundles Tauri code. On the web `getDesktop()` is null and nothing here runs.
 */

/** A file problem the editor shows in its notice strip (one at a time, under the saving notices). */
export type FileNotice =
  /** both the file and the draft changed since the last sync */
  | { kind: 'file-conflict' }
  /** deleted, moved or unreadable: the draft is kept, writing stops until it is saved to a file again */
  | { kind: 'file-missing' }
  /** the file is there but couldn't be written (permissions, disk full) */
  | { kind: 'file-unwritable' };

/** The open draft as a linked file sees it (EditorShell provides this). */
export interface EditorPort {
  readonly draftId: string;
  /** the text as shown: what the linked file gets */
  text(): string;
  /** this window writes the draft (a writer, not read-only or stopped) */
  writable(): boolean;
  /** replace the text with `text` as one recorded edit (history and replay show it); false when it can't */
  replaceText(text: string): boolean;
  /** show or clear the file notice */
  fileNotice(notice: FileNotice | null): void;
  /** File > Save as Kansowriter File: the palette's command; the label, or null when cancelled */
  exportKanso(): Promise<string | null>;
}

export interface EditorLink {
  /** the text changed: write it to the linked file, debounced */
  changed(): void;
  /** the draft became writable (or the window came back into focus): look at the file */
  check(): void;
  /** conflict notice: take the file's text as an edit */
  useFile(): void;
  /** conflict notice: overwrite the file with the draft */
  keepMine(): void;
  dispose(): void;
}

/** The app around the editor (the Router provides this). */
export interface HostPort {
  storage: StorageAdapter;
  /** open a draft, through the unsaved-words guard */
  open(draftId: string): void;
  refreshDrafts(): Promise<unknown>;
  broadcast(m: ChannelMessage): void;
}

export interface DesktopBridge {
  attachHost(host: HostPort): () => void;
  attachEditor(port: EditorPort): EditorLink;
  /** the file a draft is linked to, or null */
  linkedPath(draftId: string): string | null;
  /** called whenever links change (sidebar glyph, header tooltip) */
  subscribe(listener: () => void): () => void;
  /** File > Save to File…: link the draft to a new Markdown file and write it; the row label, or null when cancelled */
  saveToFile(draftId: string): Promise<string | null>;
  /** save a .kanso through a save panel; the row label, or null when cancelled */
  saveKanso(name: string, bytes: Uint8Array): Promise<string | null>;
  /** make Kansowriter the default app for .md; the label to show */
  makeDefault(): Promise<string>;
}

let bridge: DesktopBridge | null = null;

export function setDesktop(b: DesktopBridge | null): void {
  bridge = b;
}

export function getDesktop(): DesktopBridge | null {
  return bridge;
}

/** "~/Documents/notes.md" for a path under the home folder (the header tooltip). */
export function displayPath(path: string, home?: string | null): string {
  const h = home ?? /^\/Users\/[^/]+/.exec(path)?.[0];
  return h && path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}
