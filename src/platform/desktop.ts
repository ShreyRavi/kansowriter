import { invoke } from '@tauri-apps/api/core';
import { flushOpenDrafts } from '../storage/lifecycle';

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
  }
}

export function startDesktop(target: Window = window): void {
  target.__kansoBeforeQuit = () => void beforeQuit();
}
