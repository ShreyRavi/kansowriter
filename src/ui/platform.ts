import { TITLE_MAX } from '../core/draft';

/** Safari (macOS or iOS) running as a normal tab, not an installed home-screen app (R10). */
export function isSafariNotInstalled(): boolean {
  const ua = navigator.userAgent;
  const safari = /Safari\//.test(ua) && !/(Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg|OPR|Android)/.test(ua);
  const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return safari && !standalone;
}

/** Ask for durable storage once there is something to protect (R10). Best-effort. */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    // unsupported: the Safari hint and export reminder still cover it
  }
}

export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

export function safeFileName(title: string): string {
  return (
    (title || 'Untitled')
      .replace(/[\\/:*?"<>|]+/g, '')
      .trim()
      .slice(0, TITLE_MAX) || 'Untitled'
  );
}

const DAY = 86_400_000;

/** "Now", "Yesterday", weekday within a week, else "Oct 14" (sidebar artboard). */
export function when(at: number, now = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (now - at < 60_000) return 'Now';
  if (at >= today.getTime()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (at >= today.getTime() - DAY) return 'Yesterday';
  if (at >= today.getTime() - 6 * DAY) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function daysSince(at: number | null, now = Date.now()): number | null {
  return at === null ? null : Math.floor((now - at) / DAY);
}

export const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
