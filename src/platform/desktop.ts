import { invoke } from '@tauri-apps/api/core';
import { flushOpenDrafts } from '../storage/lifecycle';

/**
 * The macOS app (Tauri, `vite build --mode desktop`). Only loaded in that build: the web app
 * never bundles this file. Everything else a browser does for the page is native (src-tauri):
 * downloads go to ~/Downloads, outside links open in the default browser.
 *
 * Quitting: a closing WKWebView fires no pagehide, so ⌘Q, ⌘W and the close button ask the page
 * first (src-tauri/src/main.rs evals `__kansoBeforeQuit`). It saves every open draft and answers
 * `quit_ready`; with words still unsaved the app stays open on the editor's own notice, and the
 * next quit goes through regardless.
 */
export const SAVE_BEFORE_QUIT_MS = 2000;
/** keys typed just before ⌘Q can still be on their way to the page: save again after this pause */
export const SETTLE_MS = 100;

type Send = (cmd: string, args: { saved: boolean }) => Promise<unknown>;

/**
 * Save until two saves in a row, SETTLE_MS apart, leave nothing unsaved (the last keystrokes
 * before ⌘Q may land after the first one), or until `timeoutMs` runs out. Then answer.
 */
export async function beforeQuit(
  flush: () => Promise<boolean> = flushOpenDrafts,
  send: Send = invoke,
  timeoutMs = SAVE_BEFORE_QUIT_MS,
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
