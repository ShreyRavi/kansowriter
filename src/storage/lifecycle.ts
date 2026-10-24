import { BATCH_MS, type DraftWriter } from './writer';

export const STEAL_AFTER_MS = 2000;
const CHANNEL = 'kansowriter';

export type ChannelMessage =
  | { type: 'handover-request'; draftId: string }
  | { type: 'released'; draftId: string }
  | { type: 'committed'; draftId: string }
  | { type: 'settings' };

/** sessions still releasing their lock, so re-opening the same draft waits instead of going read-only */
const disposing = new Map<string, Promise<void>>();

export function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
}

export interface SessionHandle {
  /** the writer, while this tab holds the single-writer lock; null when read-only */
  readonly writer: DraftWriter | null;
  /** ask the holder to release, stealing after 2 s if it doesn't answer (R23) */
  takeOver(): Promise<void>;
  /** R9: flush, clear history keeping the current text, and rebuild the writer under the held lock */
  clearHistory(now?: number): Promise<boolean>;
  dispose(): Promise<void>;
}

export interface SessionHooks {
  /** this tab can write; `writer` was built from storage AFTER the lock was granted */
  onWritable(writer: DraftWriter): void;
  /** this tab is read-only: another tab holds the draft, or the lock was taken away */
  onReadOnly(reason: 'other-tab' | 'handed-over' | 'stolen' | 'error', error?: unknown): void;
}

/**
 * Single writer per draft (Web Locks), flush timers and page-lifecycle flushes.
 *
 *   holder tab                               second tab
 *   lock 'draft:<id>' ──held──►               request ifAvailable → null → read-only
 *   ◄── handover-request ──────────────────── takeOver()
 *   read-only, flush(true), release ── released ──► acquire → load → new writer
 *                                             (silent 2 s → steal; old holder abandon()s)
 *
 * The writer is always built by `openWriter()` inside the lock callback, so it starts from
 * whatever the previous holder committed.
 */
export function attachDraftSession(
  draftId: string,
  openWriter: () => Promise<DraftWriter>,
  hooks: SessionHooks,
  clear: (w: DraftWriter, now: number) => Promise<boolean> = async () => false,
): SessionHandle {
  const name = `draft:${draftId}`;
  const bc = channel();
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  let writer: DraftWriter | null = null;
  let release: (() => void) | null = null;
  let disposed = false;
  let generation = 0;
  let inflight: Promise<void> | null = null;
  /** writer whose cooperative handover flush is still running (a steal can land mid-flush) */
  let handingOver: DraftWriter | null = null;
  let handover: Promise<void> | null = null;
  /** settles when the lock is actually free again (the request's callback has returned) */
  let held: Promise<unknown> = Promise.resolve();
  let disposeDone: Promise<void> | null = null;
  /** writer whose history clearHistory is rewriting: timers and hide handlers must not flush it */
  let clearing: DraftWriter | null = null;
  const safe = (f: () => void) => {
    try {
      f();
    } catch {
      // a UI hook error must never strand the lock or unsaved text
    }
  };
  const writable = (w: DraftWriter) => safe(() => hooks.onWritable(w));
  const readOnly = (r: Parameters<SessionHooks['onReadOnly']>[0], e?: unknown) => safe(() => hooks.onReadOnly(r, e));

  /** Lock callback: build the writer from storage, then hold until released. */
  const hold = async (lock: Lock | null, gen: number): Promise<void> => {
    if (!lock) {
      if (!disposed && gen === generation) readOnly('other-tab');
      return;
    }
    if (disposed || gen !== generation) return;
    let w: DraftWriter;
    try {
      w = await openWriter();
    } catch (error) {
      if (!disposed && gen === generation) readOnly('error', error);
      return;
    }
    if (disposed || gen !== generation) return; // stolen or disposed while loading
    w.markOpened();
    writer = w;
    writable(w);
    await new Promise<void>((resolve) => {
      release = () => {
        release = null;
        resolve();
      };
    });
  };

  const onLost = (gen: number) => {
    // our lock was stolen: never write again, hand back unsaved text (R23, R5)
    if (gen !== generation || disposed) return;
    generation++; // a hold() still awaiting openWriter() must not become writable
    const w = writer ?? handingOver;
    const wasWritable = writer !== null;
    writer = null;
    handingOver = null;
    handover = null; // a handover overtaken by a steal is moot; dispose must not wait on it
    if (w) {
      w.abandon();
      if (wasWritable) readOnly('stolen');
    }
  };

  const request = (options: LockOptions) => {
    const gen = ++generation;
    held = locks!.request(name, options, (lock) => hold(lock, gen)).catch(() => onLost(gen));
    return held;
  };

  if (locks) {
    const prior = disposing.get(name);
    if (prior)
      void prior
        .catch(() => {})
        .then(() => {
          if (!disposed) void request({ ifAvailable: true });
        });
    else void request({ ifAvailable: true });
  } else {
    // no Web Locks: head + epoch checks (R5) still protect the log
    openWriter().then(
      (w) => {
        if (disposed) return;
        w.markOpened();
        writer = w;
        writable(w);
      },
      (error) => {
        if (!disposed) readOnly('error', error);
      },
    );
  }

  const timer = setInterval(() => {
    if (writer && writer !== clearing) void writer.flush(false);
  }, BATCH_MS);

  // an append landing after clear() renewed the epoch would turn the writer stale; edits typed
  // meanwhile stay queued and are carried onto the rebuilt writer instead
  const onHide = () => {
    if (writer && writer !== clearing && document.visibilityState === 'hidden') void writer.flush(true);
  };
  const onPageHide = () => {
    if (writer && writer !== clearing) void writer.flush(true);
  };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', onPageHide);

  const onMessage = (e: MessageEvent<ChannelMessage>) => {
    const m = e.data;
    if (m.type !== 'handover-request' || m.draftId !== draftId || !writer) return;
    const w = writer;
    writer = null;
    handingOver = w;
    readOnly('handed-over'); // stop accepting typing before the final flush
    handover = (async () => {
      await w.flush(true);
      if (handingOver !== w) return; // stolen mid-flush; onLost already handed back the text
      handingOver = null;
      if (w.dirty) w.abandon(); // the final write failed: hand the text back instead of losing it
      release?.();
      // announce only once the lock manager has it back, or the requester's ifAvailable misses it
      await held;
      if (!disposed) {
        try {
          bc?.postMessage({ type: 'released', draftId } satisfies ChannelMessage);
        } catch {
          // channel closed
        }
      }
    })().finally(() => {
      handover = null;
    });
  };
  bc?.addEventListener('message', onMessage);

  const waitForRelease = () =>
    new Promise<boolean>((resolve) => {
      const on = (e: MessageEvent<ChannelMessage>) => {
        if (e.data.type === 'released' && e.data.draftId === draftId) done(true);
      };
      const t = setTimeout(() => done(false), STEAL_AFTER_MS);
      function done(ok: boolean) {
        clearTimeout(t);
        bc?.removeEventListener('message', on);
        resolve(ok);
      }
      bc?.addEventListener('message', on);
      bc?.postMessage({ type: 'handover-request', draftId } satisfies ChannelMessage);
    });

  const disposeInner = async () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', onPageHide);
    bc?.removeEventListener('message', onMessage);
    const w = writer;
    writer = null;
    if (handover) await handover; // let a running handover finish before releasing
    try {
      if (w) {
        await w.flush(true);
        if (w.dirty) w.abandon();
      }
    } finally {
      release?.();
      // keep the disposing entry until the lock is really free, or a re-open sees 'other-tab'
      await held.catch(() => {});
      bc?.close();
    }
  };

  return {
    get writer() {
      return writer;
    },
    takeOver() {
      if (!locks || writer || disposed) return Promise.resolve();
      if (inflight) return inflight;
      inflight = (async () => {
        const released = await waitForRelease();
        if (disposed) return;
        await new Promise<void>((resolve) => {
          const gen = ++generation;
          held = locks
            // after 'released' another waiting tab may win: never queue behind it (it'd silently
            // become the writer much later); losing the race just stays read-only
            .request(name, released ? { ifAvailable: true } : { steal: true }, async (lock) => {
              resolve();
              await hold(lock, gen);
            })
            .catch(() => {
              resolve();
              onLost(gen);
            });
        });
      })().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    dispose() {
      if (disposeDone) return disposeDone;
      disposed = true;
      // chain on any earlier session still releasing, so the map's entry covers all of them
      const prior = disposing.get(name);
      const done: Promise<void> = Promise.all([prior?.catch(() => {}), disposeInner()])
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          if (disposing.get(name) === done) disposing.delete(name);
        });
      disposing.set(name, done);
      disposeDone = done;
      return done;
    },
    async clearHistory(now = Date.now()) {
      const w = writer;
      if (!w || disposed) return false;
      await w.flush(true);
      // lost the lock (handover/steal) or disposed while flushing: never rewrite history without it
      if (writer !== w || disposed || w.dirty || w.isStale) return false;
      clearing = w;
      try {
        if (!(await clear(w, now))) return false;
      } finally {
        clearing = null;
      }
      if (w.isStale && writer === w && !disposed) {
        // something else flushed w during the clear (e.g. export) and hit the renewed epoch: w has
        // already handed its full text back through onStale. Rebuilding now would show a writable
        // editor beside that stale notice, so retire w and stay read-only; the text is never lost.
        writer = null;
        readOnly('error');
        return true;
      }
      let next: DraftWriter;
      try {
        next = await openWriter();
      } catch (error) {
        // history IS cleared, but the old writer holds a dead epoch: retire it, hand back edits
        if (writer === w && !disposed) {
          writer = null;
          w.abandon();
          readOnly('error', error);
        }
        return true;
      }
      if (writer !== w || disposed) return true; // lock changed hands meanwhile; the new holder loads fresh
      // carry over anything typed while clearing, onto the rebuilt writer
      for (const c of w.takeUnsaved()) next.push(c);
      next.markOpened();
      writer = next;
      writable(next);
      return true;
    },
  };
}
