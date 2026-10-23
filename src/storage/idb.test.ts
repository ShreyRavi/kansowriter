import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach } from 'vitest';
import { IndexedDbAdapter } from './idb';
import { DraftWriter, type Change } from './writer';
import { newDraft } from '../core/draft';
import { wordsToday, dayKey } from '../core/words';
import { replay } from '../core/draft';
import { decodeBackup, encodeBackup } from '../core/backup';

let n = 0;
let db: IndexedDbAdapter;
beforeEach(() => {
  db = new IndexedDbAdapter(`test-${n++}`);
});

const T0 = Date.UTC(2026, 9, 23, 12, 0);
const type = (at: number, pos: number, ch: string, len: number): Change => ({ runs: [pos, ch, len - pos], at, kind: 'type' });

async function makeWriter(id = 'd1') {
  const rec = newDraft(id, T0);
  await db.createDraft(rec);
  const events = { stale: null as string | null, commits: 0 };
  const w = new DraftWriter(db, rec, '', {
    onStale: (t) => (events.stale = t),
    onCommit: () => events.commits++,
  }, () => 0);
  return { w, events };
}

function typeWord(w: DraftWriter, word: string, start: number, gap = 100) {
  let at = start;
  for (const ch of word) {
    const len = w.currentText.length;
    w.push(type(at, len, ch, len));
    at += gap;
  }
  return at;
}

describe('DraftWriter + IndexedDbAdapter', () => {
  it('merges a typed word into one op and replays to the same text', async () => {
    const { w } = await makeWriter();
    const end = typeWord(w, 'Hello', T0);
    typeWord(w, ' world', end + 200);
    await w.flush(true, end + 5000);
    const ops = await db.loadOps('d1');
    expect(ops.length).toBe(2); // "Hello" and " world"
    expect(ops[0]).toEqual([0, 400, 'Hello']);
    expect(replay(null, ops)).toBe('Hello world');
    expect((await db.loadDraft('d1'))!.text).toBe('Hello world');
  });

  it('500 ms batches write only closed ops; the open word waits (R4)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'Hel', T0);
    await w.flush(false, T0 + 400); // word still open (<1 s idle)
    expect(await db.loadOps('d1')).toHaveLength(0);
    await w.flush(false, T0 + 1300); // idle ≥ 1 s → closed and written
    expect(await db.loadOps('d1')).toHaveLength(1);
  });

  it('hide flush closes and writes the open word (R4)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'Hel', T0);
    await w.flush(true, T0 + 300);
    expect(replay(null, await db.loadOps('d1'))).toBe('Hel');
  });

  it('IME compose replace merges into the pending word (R22)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'teh', T0);
    w.push({ runs: [-3, 'the'], at: T0 + 400, kind: 'compose' }); // autocorrect replaces the word
    await w.flush(true, T0 + 500);
    const ops = await db.loadOps('d1');
    expect(ops).toHaveLength(1);
    expect(replay(null, ops)).toBe('the');
  });

  it('second writer with a stale base is rejected and reports unsaved text (R5)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'one', T0);
    await w.flush(true, T0 + 400);
    const loaded = (await db.loadDraft('d1'))!;
    const events = { stale: null as string | null };
    const staleRecord = { ...loaded.record, head: 0 };
    const w2 = new DraftWriter(db, staleRecord, '', { onStale: (t) => (events.stale = t), onCommit: () => {} }, () => 0);
    w2.push({ runs: ['two'], at: T0 + 1000, kind: 'other' });
    await w2.flush(true, T0 + 1000);
    expect(events.stale).toBe('two');
    expect(w2.isStale).toBe(true);
    expect(replay(null, await db.loadOps('d1'))).toBe('one');
  });

  it('words-today ledger updates in the append and survives clear-history and delete (R20, R9)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'alpha', T0);
    typeWord(w, ' beta', T0 + 2000);
    await w.flush(true, T0 + 5000);
    const key = dayKey(T0, 0);
    expect(wordsToday(await db.getDay(key))).toBe(2);
    await db.clearHistory('d1', 'alpha beta', T0 + 6000);
    expect((await db.loadDraft('d1'))!.text).toBe('alpha beta');
    expect(await db.loadOps('d1')).toHaveLength(0);
    expect(wordsToday(await db.getDay(key))).toBe(2);
    await db.deleteDraft('d1');
    expect(await db.loadDraft('d1')).toBeNull();
    expect(wordsToday(await db.getDay(key))).toBe(2);
  });

  it('a new session starts on the first op and after a 30-minute gap (R16)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'a', T0);
    typeWord(w, ' b', T0 + 31 * 60_000);
    await w.flush(true, T0 + 32 * 60_000);
    const rec = (await db.loadDraft('d1'))!.record;
    expect(rec.sessions.map((s) => s.opIndex)).toEqual([0, 1]);
  });

  it('backup round trip restores drafts, history and days (R21)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'kept words', T0);
    await w.flush(true, T0 + 5000);
    const bytes = await encodeBackup(await db.exportAll());
    const fresh = new IndexedDbAdapter(`test-${n++}`);
    const res = await fresh.importAll(await decodeBackup(bytes));
    expect(res).toEqual({ added: 1, skipped: 0 });
    expect((await fresh.loadDraft('d1'))!.text).toBe('kept words');
    expect(await fresh.loadOps('d1')).toEqual(await db.loadOps('d1'));
    expect(await fresh.importAll(await decodeBackup(bytes))).toEqual({ added: 0, skipped: 1 });
  });

  it('rejects files that are not backups', async () => {
    await expect(decodeBackup(new TextEncoder().encode('nope'))).rejects.toThrow('isn’t a Kansowriter backup');
  });
});
