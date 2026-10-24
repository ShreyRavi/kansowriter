import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { apply, makeOp, type Op } from './kop';
import { countWords, wordDelta } from './words';
import { newDraft } from './draft';
import { DamagedDraftError, DraftWriter, openDraftWriter } from '../storage/writer';
import { IndexedDbAdapter } from '../storage/idb';
import type { StorageAdapter } from './storage';

describe('regressions (Checkpoint A review)', () => {
  it('#1 wordDelta equals the whole-document delta (property)', () => {
    const unit = fc.constantFrom('a', ' ', '\n');
    fc.assert(
      fc.property(fc.string({ unit, maxLength: 10 }), fc.nat(), fc.nat({ max: 4 }), fc.string({ unit, maxLength: 4 }), (d, p, del, ins) => {
        const at = p % (d.length + 1);
        const dl = Math.min(del, d.length - at);
        if (!dl && !ins) return;
        const op = makeOp(0, 0, [at, -dl, ins, d.length - at - dl]);
        const a = apply(d, op);
        expect(wordDelta(d, a, op)).toBe(countWords(a) - countWords(d));
      }),
      { numRuns: 2000 },
    );
  });

  it('#1 insert at 0 before a leading newline', () => {
    const op: Op = [0, 0, 'a b', 2];
    expect(wordDelta('\nx', apply('\nx', op), op)).toBe(2);
  });

  it('#2 a throwing append does not wedge the writer; words are retried', async () => {
    let fail = true;
    const appended: Op[] = [];
    const storage = {
      append: async (b: { ops: Op[]; baseHead: number }) => {
        if (fail) throw new Error('QuotaExceededError');
        appended.push(...b.ops);
        return { ok: true as const, head: b.baseHead + b.ops.length };
      },
    } as unknown as StorageAdapter;
    const w = new DraftWriter(storage, newDraft('d', 0), '', { onStale: () => {}, onCommit: () => {} }, () => 0);
    w.push({ runs: ['hello'], at: 0, kind: 'other' });
    await w.flush(true, 10).catch(() => {});
    fail = false;
    w.push({ runs: [5, ' world'], at: 20, kind: 'other' });
    await w.flush(true, 30_000);
    expect(apply(apply('', appended[0]!), appended[1]!)).toBe('hello world');
  });

  it('#7 stale recovery text is the full current document, not concatenated inserts', async () => {
    let staleText: string | null = null;
    const storage = { append: async () => ({ ok: false as const, reason: 'stale' as const }) } as unknown as StorageAdapter;
    const w = new DraftWriter(storage, newDraft('d', 0), 'abc', { onStale: (t) => (staleText = t), onCommit: () => {} }, () => 0);
    w.push({ runs: [3, 'X'], at: 0, kind: 'other' });
    w.push({ runs: [3, -1], at: 1, kind: 'other' }); // typed X then deleted it
    w.push({ runs: [3, 'd'], at: 2, kind: 'other' });
    await w.flush(true, 10);
    expect(staleText).toBe('abcd');
  });

  it('backoff: a non-urgent flush before retryAt does not call append; onError reports and recovers', async () => {
    let calls = 0;
    let fail = true;
    const errors: (unknown | null)[] = [];
    const storage = {
      append: async (b: { ops: Op[]; baseHead: number }) => {
        calls++;
        if (fail) throw new Error('boom');
        return { ok: true as const, head: b.baseHead + b.ops.length };
      },
    } as unknown as StorageAdapter;
    const w = new DraftWriter(storage, newDraft('d', 0), '', { onStale: () => {}, onCommit: () => {}, onError: (e) => errors.push(e) }, () => 0);
    w.push({ runs: ['x'], at: 0, kind: 'other' });
    await w.flush(false, 100); // fails, retryAt = 1100
    expect(calls).toBe(1);
    await w.flush(false, 600); // before retryAt: skipped
    expect(calls).toBe(1);
    fail = false;
    await w.flush(false, 1200); // after retryAt: retried and succeeds
    expect(calls).toBe(2);
    expect(errors.map((e) => (e === null ? null : 'err'))).toEqual(['err', null]);
    expect(w.dirty).toBe(false);
  });

  it('a close failure goes stale with the last valid text instead of poisoning the writer', async () => {
    let staleText: string | null = null;
    const storage = { append: async () => ({ ok: true as const, head: 0 }) } as unknown as StorageAdapter;
    const w = new DraftWriter(storage, newDraft('d', 0), 'ab', { onStale: (t) => (staleText = t), onCommit: () => {} }, () => 0);
    w.push({ runs: [99, 'x'], at: 0, kind: 'type' }); // bogus runs from a buggy recorder
    w.closePending();
    expect(w.isStale).toBe(true);
    expect(staleText).toBe('ab');
  });

  it('damaged drafts are never opened for writing', async () => {
    const db = new IndexedDbAdapter('damaged-1');
    await db.createDraft(newDraft('d1', 0));
    await db.db.ops.add({ draftId: 'd1', seq: 0, op: [0, 0, 5, 'x'] });
    await db.db.drafts.update('d1', { head: 1 });
    await expect(openDraftWriter(db, 'd1', { onStale: () => {}, onCommit: () => {} })).rejects.toBeInstanceOf(DamagedDraftError);
  });

  it('a push that diverges from the document goes stale at once with the valid text', async () => {
    let staleText: string | null = null;
    const storage = { append: async () => ({ ok: true as const, head: 0 }) } as unknown as StorageAdapter;
    const w = new DraftWriter(storage, newDraft('d', 0), 'abc', { onStale: (t) => (staleText = t), onCommit: () => {} }, () => 0);
    expect(() => w.push({ runs: [10, 'x'], at: 0, kind: 'other' })).not.toThrow();
    expect(w.isStale).toBe(true);
    expect(staleText).toBe('abc');
  });
});
