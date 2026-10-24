// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachDraftSession, STEAL_AFTER_MS, type SessionHandle } from './lifecycle';
import { BATCH_MS, DraftWriter } from './writer';
import { IndexedDbAdapter } from './idb';
import { newDraft } from '../core/draft';

/** Minimal in-memory Web Locks: exclusive locks, ifAvailable, steal (holder's request rejects). */
class FakeLocks {
  private held = new Map<string, { reject: (e: unknown) => void }>();
  private queue = new Map<string, (() => void)[]>();
  async request(name: string, opts: LockOptions, cb: (lock: Lock | null) => Promise<unknown>): Promise<unknown> {
    const busy = this.held.has(name);
    if (busy && opts.ifAvailable) return cb(null);
    if (busy && opts.steal) {
      const prev = this.held.get(name)!;
      this.held.delete(name);
      prev.reject(new DOMException('stolen', 'AbortError'));
    } else if (busy) {
      await new Promise<void>((r) => (this.queue.get(name) ?? this.queue.set(name, []).get(name)!).push(r));
    }
    return new Promise((resolve, reject) => {
      const entry = { reject };
      this.held.set(name, entry);
      Promise.resolve(cb({ name, mode: 'exclusive' } as Lock)).then((v) => {
        if (this.held.get(name) === entry) {
          this.held.delete(name);
          this.queue.get(name)?.shift()?.();
        }
        resolve(v);
      }, reject);
    });
  }
}

let n = 0;
let db: IndexedDbAdapter;
const sessions: SessionHandle[] = [];

beforeEach(async () => {
  Object.defineProperty(navigator, 'locks', { value: new FakeLocks(), configurable: true });
  db = new IndexedDbAdapter(`life-${n++}`);
  await db.createDraft({ ...newDraft('d1', 0) });
});
afterEach(async () => {
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  for (const s of sessions.splice(0)) await s.dispose().catch(() => {});
});

function open(tag: string, log: string[], clear?: (w: DraftWriter, now: number) => Promise<boolean>) {
  const openWriter = async () => {
    const loaded = (await db.loadDraft('d1'))!;
    return new DraftWriter(db, loaded.record, loaded.text, {
      onStale: (t) => log.push(`${tag}:stale:${t}`),
      onCommit: () => {},
    });
  };
  const s = attachDraftSession(
    'd1',
    openWriter,
    {
      onWritable: () => log.push(`${tag}:writable`),
      onReadOnly: (r) => log.push(`${tag}:readonly:${r}`),
      onHandedOver: () => log.push(`${tag}:handed-over-done`),
    },
    clear,
  );
  sessions.push(s);
  return s;
}

const clearInDb = async (w: DraftWriter, now: number) => (await db.clearHistory('d1', w.savedText, now, w.head, w.draft.epoch)).ok;
const count = (log: string[], prefix: string) => log.filter((l) => l.startsWith(prefix)).length;

/** Put the holder's writer into the stale state: one append is refused, unsaved text handed back. */
async function makeStale(s: SessionHandle) {
  const w = s.writer!;
  const spy = vi.spyOn(db, 'append').mockResolvedValueOnce({ ok: false, reason: 'stale' });
  w.push({ runs: ['gone'], at: Date.now(), kind: 'other' });
  await w.flush(true);
  spy.mockRestore();
  expect(w.isStale).toBe(true);
  return w;
}

/** Simulate a frozen holder: it never receives handover requests. */
function freezeHolders() {
  const orig = BroadcastChannel.prototype.postMessage;
  vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation(function (this: BroadcastChannel, m: unknown) {
    if ((m as { type?: string })?.type === 'handover-request') return;
    return orig.call(this, m);
  });
}

const until = async (f: () => boolean) => {
  for (let i = 0; i < 600 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(f()).toBe(true);
};

describe('attachDraftSession (single writer, R23)', () => {
  it('first tab writes; second tab is read-only', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    expect(b.writer).toBeNull();
  });

  it('cooperative handover: holder flushes its open word, then the new tab loads it', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['hello'], at: Date.now(), kind: 'type' }); // still pending
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(log).toContain('a:readonly:handed-over');
    expect(b.writer!.currentText).toBe('hello');
  });

  it('steals after 2 s from a silent holder, and the old holder hands back unsaved text', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const aWriter = a.writer!;
    aWriter.push({ runs: ['unsaved'], at: Date.now(), kind: 'type' });
    freezeHolders();
    aWriter.flush = () => new Promise(() => {}); // the frozen tab's writes never complete either
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    const started = Date.now();
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(Date.now() - started).toBeGreaterThanOrEqual(STEAL_AFTER_MS - 50); // gstack-timing-ok: asserts the steal waits, not an upper bound
    await until(() => log.some((l) => l.startsWith('a:stale:')));
    expect(log).toContain('a:stale:unsaved');
  });

  it('a holder that saved before the steal loses nothing: the new tab loads its words', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['kept'], at: Date.now() - 2000, kind: 'type' }); // idle, closes on next tick
    freezeHolders();
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(b.writer!.currentText).toBe('kept');
    expect(log.some((l) => l.startsWith('a:stale:'))).toBe(false);
  });

  it('a second takeOver call while one is in flight reuses it', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    const p1 = b.takeOver();
    const p2 = b.takeOver();
    expect(p2).toBe(p1);
    await p1;
    await until(() => b.writer !== null);
    expect(log.filter((l) => l === 'b:writable')).toHaveLength(1);
  });

  it('dispose during the takeover wait does not steal', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    freezeHolders();
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    const p = b.takeOver();
    await b.dispose();
    await p;
    expect(a.writer).not.toBeNull();
    expect(log).not.toContain('a:readonly:stolen');
  });

  it('a steal that lands during a slow handover flush still hands back the open word', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const aw = a.writer!;
    aw.push({ runs: ['slow'], at: Date.now(), kind: 'type' });
    aw.flush = () => new Promise(() => {}); // IndexedDB stalled during the handover
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    await until(() => log.includes('a:stale:slow'));
  });

  it('a failed final write during handover hands the text back instead of dropping it', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['lost?'], at: Date.now(), kind: 'type' });
    vi.spyOn(db, 'append').mockRejectedValue(new Error('QuotaExceededError'));
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => log.includes('a:stale:lost?'));
  });

  it('onHandedOver fires only after the final flush committed and released was posted', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['hello'], at: Date.now(), kind: 'type' }); // still pending
    const orig = BroadcastChannel.prototype.postMessage;
    vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation(function (this: BroadcastChannel, m: unknown) {
      if ((m as { type?: string })?.type === 'released') log.push('post:released');
      return orig.call(this, m);
    });
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => log.includes('a:handed-over-done'));
    const i = (s: string) => log.indexOf(s);
    for (const e of ['a:readonly:handed-over', 'post:released', 'a:handed-over-done']) expect(i(e)).toBeGreaterThanOrEqual(0);
    expect(i('a:readonly:handed-over')).toBeLessThan(i('post:released'));
    expect(i('post:released')).toBeLessThan(i('a:handed-over-done'));
    expect((await db.loadDraft('d1'))!.text).toBe('hello');
    expect(count(log, 'a:stale')).toBe(0);
  });

  it('onHandedOver is not called when the final flush fails: onStale hands the text back instead', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['kept'], at: Date.now(), kind: 'type' });
    vi.spyOn(db, 'append').mockRejectedValue(new Error('QuotaExceededError'));
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => log.includes('a:stale:kept'));
    await until(() => b.writer !== null);
    expect(log).not.toContain('a:handed-over-done');
  });

  it('a failed write on dispose hands the text back and still releases the lock', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['bye'], at: Date.now(), kind: 'type' });
    vi.spyOn(db, 'append').mockRejectedValue(new Error('closed'));
    await a.dispose();
    await new Promise((r) => setTimeout(r, 20)); // lock release is asynchronous, as in browsers
    expect(log).toContain('a:stale:bye');
    vi.restoreAllMocks();
    const b = open('b', log);
    await until(() => b.writer !== null);
  });

  it('a steal while the holder is still loading never leaves two writers', async () => {
    const log: string[] = [];
    let releaseLoad!: () => void;
    const slow = new Promise<void>((r) => (releaseLoad = r));
    const openSlow = async () => {
      await slow;
      const loaded = (await db.loadDraft('d1'))!;
      return new DraftWriter(db, loaded.record, loaded.text, { onStale: () => {}, onCommit: () => {} });
    };
    const a = attachDraftSession('d1', openSlow, {
      onWritable: () => log.push('a:writable'),
      onReadOnly: (r) => log.push(`a:readonly:${r}`),
    });
    sessions.push(a);
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver(); // A ignores handover while loading → steal after 2 s
    await until(() => b.writer !== null);
    releaseLoad();
    await new Promise((r) => setTimeout(r, 50));
    expect(a.writer).toBeNull();
    expect(log).not.toContain('a:writable');
  });

  it('clearHistory rebuilds the writer under the held lock (R9)', async () => {
    const log: string[] = [];
    const openW = async () => {
      const loaded = (await db.loadDraft('d1'))!;
      return new DraftWriter(db, loaded.record, loaded.text, { onStale: (t) => log.push(`stale:${t}`), onCommit: () => {} });
    };
    const s = attachDraftSession(
      'd1',
      openW,
      { onWritable: () => log.push('writable'), onReadOnly: () => {} },
      async (w, now) => (await db.clearHistory('d1', w.savedText, now, w.head, w.draft.epoch)).ok,
    );
    sessions.push(s);
    await until(() => s.writer !== null);
    s.writer!.push({ runs: ['keep me'], at: Date.now(), kind: 'other' });
    expect(await s.clearHistory()).toBe(true);
    expect(await db.loadOps('d1')).toHaveLength(0);
    s.writer!.push({ runs: [7, '!'], at: Date.now(), kind: 'other' });
    await s.writer!.flush(true);
    expect((await db.loadDraft('d1'))!.text).toBe('keep me!');
    expect(log.some((l) => l.startsWith('stale:'))).toBe(false);
  });

  it('text typed while clearHistory runs is carried onto the rebuilt writer', async () => {
    const log: string[] = [];
    let gate!: () => void;
    const s = attachDraftSession(
      'd1',
      async () => {
        const loaded = (await db.loadDraft('d1'))!;
        return new DraftWriter(db, loaded.record, loaded.text, { onStale: (t) => log.push(`stale:${t}`), onCommit: () => {} });
      },
      { onWritable: () => {}, onReadOnly: () => {} },
      async (w, now) => {
        const res = await db.clearHistory('d1', w.savedText, now, w.head, w.draft.epoch);
        await new Promise<void>((r) => (gate = r)); // pause inside the clear window
        return res.ok;
      },
    );
    sessions.push(s);
    await until(() => s.writer !== null);
    const w = s.writer!;
    w.push({ runs: ['base'], at: Date.now(), kind: 'other' });
    const p = s.clearHistory();
    await until(() => typeof gate === 'function');
    w.push({ runs: [4, ' more'], at: Date.now(), kind: 'type' }); // typed during the clear
    gate();
    expect(await p).toBe(true);
    await s.writer!.flush(true);
    expect((await db.loadDraft('d1'))!.text).toBe('base more');
    expect(log).toEqual([]);
  });

  it('clearHistory refuses when the lock is handed over during its flush', async () => {
    const log: string[] = [];
    let cleared = false;
    const s = attachDraftSession(
      'd1',
      async () => {
        const loaded = (await db.loadDraft('d1'))!;
        return new DraftWriter(db, loaded.record, loaded.text, { onStale: () => {}, onCommit: () => {} });
      },
      { onWritable: () => log.push('a:writable'), onReadOnly: (r) => log.push(`a:readonly:${r}`) },
      async () => ((cleared = true), true),
    );
    sessions.push(s);
    await until(() => s.writer !== null);
    const w = s.writer!;
    const realFlush = w.flush.bind(w);
    const waiting: (() => void)[] = [];
    w.flush = (closePending?: boolean, now?: number) => new Promise<void>((r) => waiting.push(r)).then(() => realFlush(closePending, now));
    const p = s.clearHistory();
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    void b.takeOver(); // handover request arrives while clearHistory is flushing
    await until(() => log.includes('a:readonly:handed-over'));
    waiting.forEach((r) => r()); // clearHistory's flush and the handover's own flush
    expect(await p).toBe(false);
    expect(cleared).toBe(false);
  });

  it('an openWriter failure surfaces as read-only error', async () => {
    const log: string[] = [];
    const s = attachDraftSession('d1', async () => Promise.reject(new Error('idb down')), {
      onWritable: () => log.push('writable'),
      onReadOnly: (r) => log.push(`readonly:${r}`),
    });
    sessions.push(s);
    await until(() => log.includes('readonly:error'));
  });

  it('hiding the page flushes the open word (R4)', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['Hel'], at: Date.now(), kind: 'type' });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await until(() => a.writer!.savedText === 'Hel');
    expect((await db.loadDraft('d1'))!.text).toBe('Hel');
  });

  it('re-opening the same draft while the previous session is still disposing becomes writable, not read-only', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['words'], at: Date.now(), kind: 'type' });
    const disposing = a.dispose();
    const b = open('b', log);
    await disposing;
    await until(() => b.writer !== null);
    expect(log).not.toContain('b:readonly:other-tab');
    expect(b.writer!.currentText).toBe('words');
  });

  it('two read-only tabs taking over at once: the loser stays read-only instead of queueing (red team)', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const b = open('b', log);
    const c = open('c', log);
    await until(() => log.includes('b:readonly:other-tab') && log.includes('c:readonly:other-tab'));
    await Promise.all([b.takeOver(), c.takeOver()]);
    await until(() => (b.writer !== null) !== (c.writer !== null));
    // the loser's takeOver settled (no hung inflight) and it is read-only, not waiting for the lock
    expect(log.filter((l) => l.endsWith(':readonly:other-tab')).length).toBeGreaterThanOrEqual(3);
    await new Promise((r) => setTimeout(r, 50));
    expect([b.writer, c.writer].filter(Boolean)).toHaveLength(1);
  });

  it('clearHistory whose rebuild fails retires the old writer and reports read-only error (red team)', async () => {
    const log: string[] = [];
    let fail = false;
    const openW = async () => {
      if (fail) throw new Error('idb hiccup');
      const loaded = (await db.loadDraft('d1'))!;
      return new DraftWriter(db, loaded.record, loaded.text, { onStale: (t) => log.push(`stale:${t}`), onCommit: () => {} });
    };
    const s = attachDraftSession(
      'd1',
      openW,
      { onWritable: () => log.push('writable'), onReadOnly: (r) => log.push(`readonly:${r}`) },
      async (w, now) => (await db.clearHistory('d1', w.savedText, now, w.head, w.draft.epoch)).ok,
    );
    sessions.push(s);
    await until(() => s.writer !== null);
    s.writer!.push({ runs: ['text'], at: Date.now(), kind: 'other' });
    fail = true;
    expect(await s.clearHistory()).toBe(true);
    expect(s.writer).toBeNull();
    expect(log).toContain('readonly:error');
    expect((await db.loadDraft('d1'))!.text).toBe('text');
  });
});

/** Web Locks whose request promise settles a while after the callback returns, as in browsers. */
class SlowReleaseLocks extends FakeLocks {
  override request(name: string, opts: LockOptions, cb: (lock: Lock | null) => Promise<unknown>): Promise<unknown> {
    return super.request(name, opts, async (lock) => {
      const v = await cb(lock);
      await new Promise((r) => setTimeout(r, 30));
      return v;
    });
  }
}

describe('attachDraftSession state matrix', () => {
  it('re-open after dispose becomes writable even when the lock frees late', async () => {
    Object.defineProperty(navigator, 'locks', { value: new SlowReleaseLocks(), configurable: true });
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    await a.dispose();
    const b = open('b', log);
    await until(() => b.writer !== null);
    expect(log).not.toContain('b:readonly:other-tab');
  });

  it('clearHistory: hide/pagehide during the clear never flushes the old writer (no stale beside a writable)', async () => {
    const log: string[] = [];
    let gate!: () => void;
    const s = open('a', log, async (w, now) => {
      const ok = await clearInDb(w, now);
      await new Promise<void>((r) => (gate = r));
      return ok;
    });
    await until(() => s.writer !== null);
    const w = s.writer!;
    w.push({ runs: ['base'], at: Date.now(), kind: 'other' });
    const p = s.clearHistory();
    await until(() => typeof gate === 'function');
    w.push({ runs: [4, ' more'], at: Date.now(), kind: 'other' });
    window.dispatchEvent(new Event('pagehide'));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 20));
    gate();
    expect(await p).toBe(true);
    expect(count(log, 'a:stale:')).toBe(0);
    expect(count(log, 'a:writable')).toBe(2);
    await s.writer!.flush(true);
    expect((await db.loadDraft('d1'))!.text).toBe('base more');
  });

  it('clearHistory: a writer flushed elsewhere during the clear goes stale once and is retired, not rebuilt', async () => {
    const log: string[] = [];
    let gate!: () => void;
    const s = open('a', log, async (w, now) => {
      const ok = await clearInDb(w, now);
      await new Promise<void>((r) => (gate = r));
      return ok;
    });
    await until(() => s.writer !== null);
    const w = s.writer!;
    w.push({ runs: ['base'], at: Date.now(), kind: 'other' });
    const p = s.clearHistory();
    await until(() => typeof gate === 'function');
    w.push({ runs: [4, ' more'], at: Date.now(), kind: 'other' });
    await w.flush(true); // e.g. export flushing the writer: hits the renewed epoch
    gate();
    expect(await p).toBe(true);
    expect(log).toContain('a:stale:base more'); // nothing lost: the full text was handed back
    expect(count(log, 'a:writable')).toBe(1);
    expect(log).toContain('a:readonly:error');
    expect(s.writer).toBeNull();
  });

  /**
   * a session whose rebuild (the second openWriter) waits on `gate`; `failRebuild` makes it throw once
   * opened, `clear` replaces the storage clear (e.g. one gated itself, or one that refuses)
   */
  function openGatedRebuild(
    tag: string,
    log: string[],
    opts: { failRebuild?: boolean; clear?: (w: DraftWriter, now: number) => Promise<boolean> } = {},
  ) {
    let opens = 0;
    const gate: { open?: () => void } = {};
    const s = attachDraftSession(
      'd1',
      async () => {
        if (++opens === 2) {
          await new Promise<void>((r) => (gate.open = r));
          if (opts.failRebuild) throw new Error('idb hiccup');
        }
        const loaded = (await db.loadDraft('d1'))!;
        return new DraftWriter(db, loaded.record, loaded.text, { onStale: (t) => log.push(`${tag}:stale:${t}`), onCommit: () => {} });
      },
      {
        onWritable: () => log.push(`${tag}:writable`),
        onReadOnly: (r) => log.push(`${tag}:readonly:${r}`),
        onHandedOver: () => log.push(`${tag}:handed-over-done`),
      },
      opts.clear ?? clearInDb,
    );
    sessions.push(s);
    return { s, gate };
  }

  it('clearHistory: timer and pagehide during the rebuild never flush the old writer; edits carry over', async () => {
    const log: string[] = [];
    const { s, gate } = openGatedRebuild('a', log);
    await until(() => s.writer !== null);
    const w = s.writer!;
    w.push({ runs: ['base'], at: Date.now(), kind: 'other' });
    const p = s.clearHistory();
    await until(() => typeof gate.open === 'function'); // clear() done, epoch renewed, rebuild pending
    w.push({ runs: [4, ' more'], at: Date.now(), kind: 'other' });
    await new Promise((r) => setTimeout(r, BATCH_MS + 100)); // the batch timer fires meanwhile
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 20));
    expect(w.isStale).toBe(false);
    gate.open!();
    expect(await p).toBe(true);
    expect(count(log, 'a:stale:')).toBe(0);
    expect(count(log, 'a:writable')).toBe(2);
    expect(s.writer!.currentText).toBe('base more');
    await s.writer!.flush(true);
    expect((await db.loadDraft('d1'))!.text).toBe('base more');
  });

  it('clearHistory: a handover-request during the rebuild is answered after it, with the rebuilt writer', async () => {
    const log: string[] = [];
    const { s, gate } = openGatedRebuild('a', log);
    await until(() => s.writer !== null);
    s.writer!.push({ runs: ['base'], at: Date.now(), kind: 'other' });
    const p = s.clearHistory();
    await until(() => typeof gate.open === 'function');
    s.writer!.push({ runs: [4, ' more'], at: Date.now(), kind: 'type' }); // still pending
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    const t = b.takeOver();
    await new Promise((r) => setTimeout(r, 50));
    expect(log).not.toContain('a:readonly:handed-over'); // deferred while rebuilding
    gate.open!();
    expect(await p).toBe(true);
    await t;
    await until(() => b.writer !== null);
    expect(log.indexOf('a:readonly:handed-over')).toBeGreaterThan(log.lastIndexOf('a:writable'));
    expect(count(log, 'a:stale:')).toBe(0);
    expect(b.writer!.currentText).toBe('base more');
    expect(await db.loadOps('d1')).toHaveLength(1); // history cleared, then just the carried word
  });

  it('clearHistory: a handover deferred by a failed rebuild releases the lock at once, no steal wait', async () => {
    const log: string[] = [];
    const { s, gate } = openGatedRebuild('a', log, { failRebuild: true });
    await until(() => s.writer !== null);
    s.writer!.push({ runs: ['base'], at: Date.now(), kind: 'other' });
    const p = s.clearHistory();
    await until(() => typeof gate.open === 'function');
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    const started = Date.now();
    const t = b.takeOver();
    await new Promise((r) => setTimeout(r, 50));
    expect(log).not.toContain('a:readonly:handed-over'); // deferred while rebuilding
    gate.open!();
    expect(await p).toBe(true);
    expect(log).toContain('a:readonly:error');
    await t;
    await until(() => b.writer !== null);
    expect(Date.now() - started).toBeLessThan(STEAL_AFTER_MS); // gstack-timing-ok: released cooperatively, not stolen
    expect(b.writer!.currentText).toBe('base');
    expect(count(log, 'a:writable')).toBe(1);
    expect(count(log, 'a:stale:')).toBe(0);
  });

  /** a clear that runs in storage, then waits on `gate.open` before answering `answer` */
  const gatedClear = (gate: { open?: () => void }, answer?: boolean) => async (w: DraftWriter, now: number) => {
    const ok = answer ?? (await clearInDb(w, now));
    await new Promise<void>((r) => (gate.open = r));
    return ok;
  };

  it('clearHistory: a handover deferred by a writer that went stale during the clear releases the lock at once', async () => {
    const log: string[] = [];
    const clearGate: { open?: () => void } = {};
    const { s } = openGatedRebuild('a', log, { clear: gatedClear(clearGate) });
    await until(() => s.writer !== null);
    const w = s.writer!;
    w.push({ runs: ['base'], at: Date.now(), kind: 'other' });
    const p = s.clearHistory();
    await until(() => typeof clearGate.open === 'function');
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    const started = Date.now();
    const t = b.takeOver();
    await new Promise((r) => setTimeout(r, 50));
    w.push({ runs: [4, ' more'], at: Date.now(), kind: 'other' });
    await w.flush(true); // e.g. export flushing the writer: hits the renewed epoch
    expect(log).toContain('a:stale:base more');
    clearGate.open!();
    expect(await p).toBe(true);
    expect(log).toContain('a:readonly:error');
    await t;
    await until(() => b.writer !== null);
    expect(Date.now() - started).toBeLessThan(STEAL_AFTER_MS); // gstack-timing-ok: released cooperatively, not stolen
    expect(b.writer!.currentText).toBe('base'); // what storage holds; ' more' was handed back to a
    expect(count(log, 'a:writable')).toBe(1);
    expect(count(log, 'a:stale:')).toBe(1);
  });

  it('clearHistory: a handover deferred by a refused clear hands over the kept writer', async () => {
    const log: string[] = [];
    const clearGate: { open?: () => void } = {};
    const { s } = openGatedRebuild('a', log, { clear: gatedClear(clearGate, false) });
    await until(() => s.writer !== null);
    s.writer!.push({ runs: ['base'], at: Date.now(), kind: 'other' });
    const p = s.clearHistory();
    await until(() => typeof clearGate.open === 'function');
    s.writer!.push({ runs: [4, ' more'], at: Date.now(), kind: 'type' }); // still pending
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    const t = b.takeOver();
    await new Promise((r) => setTimeout(r, 50));
    expect(log).not.toContain('a:readonly:handed-over');
    clearGate.open!();
    expect(await p).toBe(false);
    await t;
    await until(() => b.writer !== null);
    expect(log).toContain('a:readonly:handed-over');
    expect(log).toContain('a:handed-over-done');
    expect(b.writer!.currentText).toBe('base more');
    expect(count(log, 'a:writable')).toBe(1);
    expect(count(log, 'a:stale:')).toBe(0);
  });

  it('queued-closed × handover: flush(true) commits the queue and the new tab loads it', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['queued'], at: Date.now(), kind: 'other' });
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(b.writer!.currentText).toBe('queued');
    expect(count(log, 'a:stale:')).toBe(0);
  });

  it('stale × handover: no second onStale; the new tab loads what storage holds', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    await makeStale(a);
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(b.writer!.currentText).toBe('');
    expect(count(log, 'a:stale:')).toBe(1);
  });

  it('queued-closed × steal: abandon hands back the queued ops and goes read-only stolen', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const aw = a.writer!;
    aw.flush = () => new Promise(() => {}); // frozen: the queue never reaches storage
    aw.push({ runs: ['queued'], at: Date.now(), kind: 'other' });
    freezeHolders();
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(log).toContain('a:stale:queued');
    expect(log).toContain('a:readonly:stolen');
  });

  it('failing-retry × steal: hands back the current text and never appends again', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const aw = a.writer!;
    vi.spyOn(db, 'append').mockRejectedValue(new Error('QuotaExceededError'));
    aw.push({ runs: ['retrying'], at: Date.now(), kind: 'other' });
    await aw.flush(true);
    expect(aw.dirty).toBe(true);
    freezeHolders();
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(log).toContain('a:stale:retrying');
    vi.restoreAllMocks();
    const append = vi.spyOn(db, 'append');
    await aw.flush(true);
    expect(append).not.toHaveBeenCalled();
  });

  it('flush-committed-not-released × steal-mid-handover: onHandedOver, no onStale, the new holder has the word', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const aw = a.writer!;
    aw.push({ runs: ['final'], at: Date.now(), kind: 'type' }); // still pending: the handover flush commits it
    const flush = aw.flush.bind(aw);
    const append = vi.spyOn(db, 'append');
    // the final append commits, then the tab stalls before it releases the lock
    aw.flush = (...args) => flush(...args).then(() => new Promise<void>(() => {}));
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver(); // no 'released' arrives: steals after STEAL_AFTER_MS
    await until(() => b.writer !== null);
    expect(append).toHaveBeenCalledTimes(1);
    expect(log).toContain('a:readonly:handed-over');
    await until(() => log.includes('a:handed-over-done'));
    expect(count(log, 'a:stale')).toBe(0);
    expect(log).not.toContain('a:readonly:stolen');
    expect(b.writer!.currentText).toBe('final');
  });

  it('append-failing × steal-mid-handover: onStale with the full text, no onHandedOver, no append after the steal', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const aw = a.writer!;
    aw.push({ runs: ['saved '], at: Date.now() - 2000, kind: 'other' });
    await aw.flush(true);
    aw.push({ runs: [6, 'lost?'], at: Date.now(), kind: 'type' });
    let fail: () => void = () => {};
    // the handover's final append hangs, then rejects only after the steal
    const append = vi
      .spyOn(db, 'append')
      .mockImplementation(() => new Promise((_, reject) => (fail = () => reject(new Error('QuotaExceededError')))));
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(log).toContain('a:stale:saved lost?');
    expect(append).toHaveBeenCalledTimes(1);
    fail();
    await new Promise((r) => setTimeout(r, 20));
    await aw.flush(true);
    expect(append).toHaveBeenCalledTimes(1);
    expect(log).not.toContain('a:handed-over-done');
    expect(count(log, 'a:stale')).toBe(1);
    expect(b.writer!.currentText).toBe('saved ');
  });

  it('stale × steal: no second onStale', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    await makeStale(a);
    freezeHolders();
    const b = open('b', log);
    await until(() => log.includes('b:readonly:other-tab'));
    await b.takeOver();
    await until(() => b.writer !== null);
    expect(count(log, 'a:stale:')).toBe(1);
  });

  it('clean × dispose: no append, and re-opening is writable', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    const append = vi.spyOn(db, 'append');
    await a.dispose();
    expect(append).not.toHaveBeenCalled();
    const b = open('b', log);
    await until(() => b.writer !== null);
  });

  it('queued-closed × dispose: the flush commits the queue and re-opening loads it', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    a.writer!.push({ runs: ['queued'], at: Date.now(), kind: 'other' });
    await a.dispose();
    const b = open('b', log);
    await until(() => b.writer !== null);
    expect(b.writer!.currentText).toBe('queued');
  });

  it('stale × dispose: no append, no second onStale, and the lock is released', async () => {
    const log: string[] = [];
    const a = open('a', log);
    await until(() => a.writer !== null);
    await makeStale(a);
    const append = vi.spyOn(db, 'append');
    await a.dispose();
    expect(append).not.toHaveBeenCalled();
    expect(count(log, 'a:stale:')).toBe(1);
    const b = open('b', log);
    await until(() => b.writer !== null);
  });

  it('clean × clearHistory: clears, rebuilds, onWritable twice, no onStale', async () => {
    const log: string[] = [];
    const s = open('a', log, clearInDb);
    await until(() => s.writer !== null);
    s.writer!.push({ runs: ['saved'], at: Date.now(), kind: 'other' });
    await s.writer!.flush(true);
    expect(await db.loadOps('d1')).toHaveLength(1);
    expect(await s.clearHistory()).toBe(true);
    expect(await db.loadOps('d1')).toHaveLength(0);
    expect((await db.loadDraft('d1'))!.text).toBe('saved');
    expect(count(log, 'a:writable')).toBe(2);
    expect(count(log, 'a:stale:')).toBe(0);
  });

  it('failing-retry × clearHistory: refuses, history untouched, writer kept dirty', async () => {
    const log: string[] = [];
    let cleared = false;
    const s = open('a', log, async () => ((cleared = true), true));
    await until(() => s.writer !== null);
    const w = s.writer!;
    vi.spyOn(db, 'append').mockRejectedValue(new Error('QuotaExceededError'));
    w.push({ runs: ['retrying'], at: Date.now(), kind: 'other' });
    await w.flush(true);
    expect(await s.clearHistory()).toBe(false);
    expect(cleared).toBe(false);
    expect(s.writer).toBe(w);
    expect(w.dirty).toBe(true);
    expect(count(log, 'a:writable')).toBe(1);
  });

  it('stale × clearHistory: refuses, history untouched, no rebuild', async () => {
    const log: string[] = [];
    let cleared = false;
    const s = open('a', log, async () => ((cleared = true), true));
    await until(() => s.writer !== null);
    await makeStale(s);
    expect(await s.clearHistory()).toBe(false);
    expect(cleared).toBe(false);
    expect(count(log, 'a:writable')).toBe(1);
  });
});
