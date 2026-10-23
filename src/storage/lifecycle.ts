import { BATCH_MS, type DraftWriter } from './writer';

export const STEAL_AFTER_MS = 2000;
const CHANNEL = 'kansowriter';

export type ChannelMessage =
  | { type: 'handover-request'; draftId: string }
  | { type: 'released'; draftId: string }
  | { type: 'committed'; draftId: string }
  | { type: 'drafts-changed' };

export function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
}

export interface SessionHandle {
  /** true while this tab holds the single-writer lock for the draft */
  readonly writable: boolean;
  /** ask the holder to release, stealing after 2 s if it doesn't answer (R23) */
  takeOver(): Promise<void>;
  dispose(): Promise<void>;
}

interface Hooks {
  onWritableChange(writable: boolean): void;
}

/**
 * Single writer per draft (Web Locks), flush timers and page-lifecycle flushes.
 *   holder tab                      second tab
 *   lock 'draft:<id>' ──held──►      request ifAvailable → null → read-only
 *   ◄── handover-request ─────────── "Open here instead"
 *   flush(true), release ── released ──► acquire; if silent 2 s → steal
 */
export function attachDraftSession(draftId: string, writer: DraftWriter, hooks: Hooks): SessionHandle {
  const name = `draft:${draftId}`;
  const bc = channel();
  let writable = false;
  let release: (() => void) | null = null;
  let disposed = false;

  const setWritable = (w: boolean) => {
    writable = w;
    hooks.onWritableChange(w);
  };

  const hold = (lock: Lock | null) => {
    if (!lock || disposed) return Promise.resolve();
    setWritable(true);
    return new Promise<void>((resolve) => {
      release = () => {
        release = null;
        resolve();
      };
    });
  };

  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) {
    locks
      .request(name, { ifAvailable: true }, (lock) => {
        if (!lock) setWritable(false);
        return hold(lock);
      })
      .catch(() => {
        // our lock was stolen by another tab: our next writes are stale and R5 handles them
        if (!disposed) setWritable(false);
      });
  } else {
    setWritable(true); // no Web Locks: base≠head rejection (R5) still protects the log
  }

  const timer = setInterval(() => {
    if (writable) void writer.flush(false);
  }, BATCH_MS);

  const onHide = () => {
    if (writable && document.visibilityState === 'hidden') void writer.flush(true);
  };
  const onPageHide = () => {
    if (writable) void writer.flush(true);
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  const onMessage = async (e: MessageEvent<ChannelMessage>) => {
    const m = e.data;
    if (m.type === 'handover-request' && m.draftId === draftId && writable) {
      await writer.flush(true);
      setWritable(false);
      release?.();
      bc?.postMessage({ type: 'released', draftId } satisfies ChannelMessage);
    }
  };
  bc?.addEventListener('message', onMessage);

  return {
    get writable() {
      return writable;
    },
    async takeOver() {
      if (!locks || writable) return;
      bc?.postMessage({ type: 'handover-request', draftId } satisfies ChannelMessage);
      const released = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), STEAL_AFTER_MS);
        bc?.addEventListener('message', function on(e: MessageEvent<ChannelMessage>) {
          if (e.data.type === 'released' && e.data.draftId === draftId) {
            clearTimeout(t);
            bc.removeEventListener('message', on);
            resolve(true);
          }
        });
      });
      const ok = await released;
      await new Promise<void>((resolve) => {
        void locks
          .request(name, ok ? {} : { steal: true }, (lock) => {
            resolve();
            return hold(lock);
          })
          .catch(() => {
            if (!disposed) setWritable(false);
          });
      });
    },
    async dispose() {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onPageHide);
      bc?.removeEventListener('message', onMessage);
      if (writable) await writer.flush(true);
      release?.();
      bc?.close();
    },
  };
}
