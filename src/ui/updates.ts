import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker updates (R11): a new version installs and waits; this tab never reloads by
 * itself. The editor offers a quiet "Update ready · Reload" while nothing is unsaved, and only
 * that click activates the new worker and reloads. Registered from the bundle (no inline script).
 */
let ready = false;
/** this tab asked for the update: only then does the worker swap reload it */
let requested = false;
/** another tab already applied the update (this page now runs under the new worker) */
let swapped = false;
let updateSW: ((reload?: boolean) => Promise<void>) | null = null;
const listeners = new Set<() => void>();

function setReady() {
  ready = true;
  listeners.forEach((l) => l());
}

export function startUpdates(): void {
  if (updateSW || !('serviceWorker' in navigator)) return;
  updateSW = registerSW({
    onNeedRefresh: setReady,
    // without this the plugin reloads every open tab when any one of them applies the update
    onNeedReload: () => {
      if (requested) location.reload();
      else {
        swapped = true;
        setReady();
      }
    },
  });
}

export function applyUpdate(): void {
  requested = true;
  if (swapped) location.reload();
  else void updateSW?.(true);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useUpdateReady(): boolean {
  return useSyncExternalStore(subscribe, () => ready);
}
