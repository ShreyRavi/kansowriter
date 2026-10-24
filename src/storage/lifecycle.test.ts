// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachDraftSession, STEAL_AFTER_MS, type SessionHandle } from './lifecycle';
import { DraftWriter } from './writer';
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
      Promise.resolve(cb({ name, mode: 'exclusive' } as Lock)).then(
        (v) => {
          if (this.held.get(name) === entry) {
            this.held.delete(name);
            this.queue.get(name)?.shift()?.();
          }
          resolve(v);
        },
        reject,
      );
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

function open(tag: string, log: string[]) {
  const openWriter = async () => {
    const loaded = (await db.loadDraft('d1'))!;
    return new DraftWriter(db, loaded.record, loaded.text, {
      onStale: (t) => log.push(`${tag}:stale:${t}`),
      onCommit: () => {},
    });
  };
  const s = attachDraftSession('d1', openWriter, {
    onWritable: () => log.push(`${tag}:writable`),
    onReadOnly: (r) => log.push(`${tag}:readonly:${r}`),
  });
  sessions.push(s);
  return s;
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
    const a = attachDraftSession('d1', openSlow, { onWritable: () => log.push('a:writable'), onReadOnly: (r) => log.push(`a:readonly:${r}`) });
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
    const s = attachDraftSession('d1', openW, { onWritable: () => log.push('writable'), onReadOnly: () => {} }, async (w, now) =>
      (await db.clearHistory('d1', w.savedText, now, w.head, w.draft.epoch)).ok,
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
    w.flush = (closePending?: boolean, now?: number) =>
      new Promise<void>((r) => waiting.push(r)).then(() => realFlush(closePending, now));
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
    const s = attachDraftSession('d1', openW, { onWritable: () => log.push('writable'), onReadOnly: (r) => log.push(`readonly:${r}`) }, async (w, now) =>
      (await db.clearHistory('d1', w.savedText, now, w.head, w.draft.epoch)).ok,
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
