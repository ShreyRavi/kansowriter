import { invoke } from '@tauri-apps/api/core';
import { addFlusher, flushOpenDrafts } from '../storage/lifecycle';
import { setDesktop } from '../ui/desktopBridge';
import { createDesktopFiles } from './desktopFiles';
import type { FileOps, FileStat } from './fileSync';

/**
 * The macOS app (Tauri, `vite build --mode desktop`). Only loaded in that build: the web app
 * never bundles this file. Everything else a browser does for the page is native (src-tauri):
 * downloads go to ~/Downloads, outside links open in the default browser.
 *
 * Quitting: a closing WKWebView fires no pagehide, so ⌘Q, ⌘W, the close button, the Dock and
 * logout ask the page first (src-tauri/src/main.rs evals `__kansoBeforeQuit`). It saves every
 * open draft and answers `quit_ready`. With words still unsaved the app stays open once and says
 * so; quitting again within QUIT_NOTICE_MS goes through (src-tauri/src/quit.rs).
 */
export const SAVE_BEFORE_QUIT_MS = 2000;
/** keys typed just before ⌘Q can still be on their way to the page: save again after this pause */
export const SETTLE_MS = 100;
/** how long a second quit is forced after a failed save: quit::FORCE_WINDOW in src-tauri/src/quit.rs */
export const QUIT_NOTICE_MS = 30_000;
export const QUIT_NOTICE_TEXT = 'Still saving your newest words. Quit again to quit anyway.';

type Send = (cmd: string, args: { saved: boolean }) => Promise<unknown>;

/**
 * Say why a quit was ignored: the app's own notice bar (the `.notice` style), for as long as a
 * second quit is forced. Outside React so the editor needs no desktop code.
 */
export function showQuitNotice(doc: Document = document): HTMLElement {
  doc.getElementById('kanso-quit-notice')?.remove();
  const el = doc.createElement('div');
  el.id = 'kanso-quit-notice';
  el.className = 'notice';
  el.setAttribute('role', 'alert');
  const text = doc.createElement('span');
  text.textContent = QUIT_NOTICE_TEXT;
  el.append(text);
  doc.body.append(el);
  setTimeout(() => el.remove(), QUIT_NOTICE_MS);
  return el;
}

/**
 * Save until two saves in a row, SETTLE_MS apart, leave nothing unsaved (the last keystrokes
 * before ⌘Q may land after the first one), or until `timeoutMs` runs out. Then answer; when
 * something is still unsaved, show the notice first (the app stays open unless this quit was
 * already the forced second one).
 */
export async function beforeQuit(
  flush: () => Promise<boolean> = flushOpenDrafts,
  send: Send = invoke,
  timeoutMs = SAVE_BEFORE_QUIT_MS,
  notify: () => void = showQuitNotice,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const wait = (ms: number) => new Promise<false>((resolve) => setTimeout(() => resolve(false), Math.max(0, ms)));
  let saved = false;
  let clean = 0;
  while (clean < 2 && Date.now() < deadline) {
    try {
      saved = await Promise.race([flush(), wait(deadline - Date.now())]);
    } catch {
      saved = false;
    }
    clean = saved ? clean + 1 : 0;
    if (clean < 2 && Date.now() < deadline) await wait(Math.min(SETTLE_MS, deadline - Date.now()));
  }
  if (!saved) {
    try {
      notify();
    } catch {
      // the answer below matters more than the notice
    }
  }
  await send('quit_ready', { saved });
}

declare global {
  interface Window {
    __kansoBeforeQuit?: () => void;
    /** files were handed to the app (Finder, Dock, `open -a`, File > Open…): src-tauri/src/main.rs */
    __kansoOpened?: () => void;
    /** a File menu item the page runs (Save to File…, Save as Kansowriter File) */
    __kansoMenu?: (id: string) => void;
  }
}

/** The file commands (src-tauri/src/files.rs), on granted paths only. */
export const fileOps: FileOps = {
  stat: (path) => invoke<FileStat | null>('file_stat', { path }),
  read: async (path) => new Uint8Array(await invoke<ArrayBuffer>('file_read', { path })),
  // the bytes go as the raw body (no JSON number arrays for a large .kanso); the path in a header
  // `expect`: what the page last saw; the write is refused ("changed") if the file moved on since
  write: (path, bytes, expect) =>
    invoke<FileStat>('file_write', bytes, {
      headers: {
        'x-kanso-path': encodeURIComponent(path),
        ...(expect ? { 'x-kanso-expect': `${expect.mtime}:${expect.size}` } : {}),
      },
    }),
};

export function startDesktop(target: Window = window): void {
  target.__kansoBeforeQuit = () => void beforeQuit();
  const files = createDesktopFiles(fileOps, (cmd, args) => invoke(cmd, args));
  setDesktop(files);
  // a quit waits for linked files too (flushOpenDrafts runs every flusher)
  addFlusher(() => files.flush());
  target.__kansoOpened = () => void files.opened();
  target.__kansoMenu = (id) => void files.menu(id);
  // edited elsewhere while Kansowriter was in the background: look when it comes back
  target.addEventListener('focus', () => files.focused());
  target.document.addEventListener('visibilitychange', () => {
    if (target.document.visibilityState === 'visible') files.focused();
  });
}
