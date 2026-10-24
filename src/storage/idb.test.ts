import 'fake-indexeddb/auto';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { IndexedDbAdapter } from './idb';
import { DamagedDraftError, DraftWriter, openDraftWriter, type Change } from './writer';
import { deriveMeta, newDraft } from '../core/draft';
import { countWords, wordsToday, dayKey } from '../core/words';
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
  const w = new DraftWriter(
    db,
    rec,
    '',
    {
      onStale: (t) => (events.stale = t),
      onCommit: () => events.commits++,
    },
    () => 0,
  );
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
    const rec = (await db.loadDraft('d1'))!.record;
    expect((await db.clearHistory('d1', 'alpha beta', T0 + 6000, rec.head, rec.epoch)).ok).toBe(true);
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
    expect(res).toEqual({ added: 1, copies: 0, skipped: 0, damaged: 0 });
    expect((await fresh.loadDraft('d1'))!.text).toBe('kept words');
    expect(await fresh.loadOps('d1')).toEqual(await db.loadOps('d1'));
    expect(await fresh.importAll(await decodeBackup(bytes))).toEqual({ added: 0, copies: 0, skipped: 1, damaged: 0 });
  });

  it('a draft that diverged on another device imports as a copy, never "already here" (red team)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'base', T0);
    await w.flush(true, T0 + 1000);
    const deviceA = await db.exportAll();
    // device B restores, then keeps writing
    const b = new IndexedDbAdapter(`test-${n++}`);
    await b.importAll(deviceA);
    const lb = (await b.loadDraft('d1'))!;
    const wb = new DraftWriter(b, lb.record, lb.text, { onStale: () => {}, onCommit: () => {} }, () => 0);
    typeWord(wb, ' more', T0 + 5000);
    await wb.flush(true, T0 + 9000);
    const res = await db.importAll(await b.exportAll());
    expect(res).toEqual({ added: 1, copies: 1, skipped: 0, damaged: 0 });
    const texts = await Promise.all((await db.listDrafts()).map(async (d) => (await db.loadDraft(d.id))!.text));
    expect(texts.sort()).toEqual(['base', 'base more']);
  });

  it('restoring an older backup on the same device, or the same file twice, adds nothing (idempotent)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'old', T0);
    await w.flush(true, T0 + 1000);
    const older = await db.exportAll();
    typeWord(w, ' newer', T0 + 5000);
    await w.flush(true, T0 + 9000);
    expect(await db.importAll(older)).toEqual({ added: 0, copies: 0, skipped: 1, damaged: 0 });
    // a real divergence comes in once as a marked copy; importing the file again adds nothing
    const forked = structuredClone(older);
    forked.drafts[0]!.ops = [[0, 0, 'other']];
    expect((await db.importAll(forked)).copies).toBe(1);
    expect(await db.importAll(forked)).toEqual({ added: 0, copies: 0, skipped: 1, damaged: 0 });
    expect((await db.listDrafts()).map((d) => d.meta.title)).toContain('old (from backup)');
  });

  it('imports a long history quickly (rope replay, no ops × length blowup)', async () => {
    const ops: [number, number, ...(number | string)[]][] = [[0, 0, 'x'.repeat(200_000)]];
    for (let i = 1; i < 20_000; i++) ops.push([0, 0, 200_000 + i - 1, 'y']);
    const rec = { ...newDraft('big', T0), head: ops.length };
    const started = Date.now();
    const res = await db.importAll({
      format: 'kansobackup',
      v: 1,
      exportedAt: T0,
      drafts: [{ record: rec, ops, snapshots: [] }],
      days: [],
    });
    expect(res.added).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect((await db.loadDraft('big'))!.text.length).toBe(200_000 + 19_999);
  });

  it('a draft whose ops do not replay is left out instead of failing the whole import', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'fine', T0);
    await w.flush(true, T0 + 1000);
    const data = await db.exportAll();
    data.drafts.push({ record: { ...data.drafts[0]!.record, id: 'bad' }, ops: [[0, 0, 5, 'x']], snapshots: [] });
    const target = new IndexedDbAdapter(`test-${n++}`);
    expect(await target.importAll(data)).toEqual({ added: 1, copies: 0, skipped: 0, damaged: 1 });
  });

  it('backups with carriage returns are rejected (the editor would desync from the log)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'ok', T0);
    await w.flush(true, T0 + 1000);
    const data = await db.exportAll();
    data.drafts[0]!.ops.push([0, 0, 2, '\r\n']);
    await expect(decodeBackup(await encodeBackup(data))).rejects.toThrow();
  });

  it('keeps only the base and newest snapshot as the draft grows (storage stays linear)', async () => {
    const { w } = await makeWriter();
    for (let i = 0; i < 1001; i++) {
      const len = w.currentText.length;
      w.push({ runs: len ? [len, 'z'] : ['z'], at: T0 + i, kind: 'other' });
    }
    await w.flush(true, T0 + 20_000);
    expect((await db.loadSnapshots('d1')).map((s) => s.opIndex)).toEqual([1000]);
    expect((await db.loadDraft('d1'))!.text).toBe('z'.repeat(1001));
  });

  it('failed saves retry in bounded batches and recover once storage works again', async () => {
    const { w, events } = await makeWriter();
    const real = db.append.bind(db);
    const sizes: number[] = [];
    let fail = true;
    db.append = async (b) => {
      sizes.push(b.ops.length);
      if (fail) throw new Error('QuotaExceededError');
      return real(b);
    };
    for (let i = 0; i < 450; i++) {
      const len = w.currentText.length;
      w.push({ runs: len ? [len, 'q'] : ['q'], at: T0 + i, kind: 'other' });
    }
    await w.flush(true, T0 + 1000);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
    fail = false;
    await w.flush(true, T0 + 100_000);
    expect(w.dirty).toBe(false);
    expect(events.stale).toBeNull();
    expect((await db.loadDraft('d1'))!.text).toBe('q'.repeat(450));
  });

  it('an old writer cannot write after clear-history even when heads coincide (epoch, red team)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'one', T0);
    await w.flush(true, T0 + 400);
    const loaded = (await db.loadDraft('d1'))!;
    const staleEvents = { text: null as string | null };
    const old = new DraftWriter(db, loaded.record, loaded.text, { onStale: (t) => (staleEvents.text = t), onCommit: () => {} }, () => 0);
    // another tab clears history (head 1 → 0) and types one op (head 0 → 1): same head, new epoch
    const cleared = await db.clearHistory('d1', 'one', T0 + 500, 1, loaded.record.epoch);
    expect(cleared.ok).toBe(true);
    const fresh = new DraftWriter(
      db,
      (cleared as { record: typeof loaded.record }).record,
      'one',
      { onStale: () => {}, onCommit: () => {} },
      () => 0,
    );
    fresh.push({ runs: [3, '!'], at: T0 + 600, kind: 'other' });
    await fresh.flush(true, T0 + 600);
    old.push({ runs: [3, '?'], at: T0 + 700, kind: 'other' });
    await old.flush(true, T0 + 700);
    expect(staleEvents.text).toBe('one?');
    expect((await db.loadDraft('d1'))!.text).toBe('one!');
  });

  it('clear-history is rejected when the caller is behind (#9)', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'ab', T0);
    await w.flush(true, T0 + 400);
    const rec = (await db.loadDraft('d1'))!.record;
    expect((await db.clearHistory('d1', 'ab', T0, rec.head - 1, rec.epoch)).ok).toBe(false);
    expect(await db.loadOps('d1')).toHaveLength(1);
  });

  it('writes a snapshot at op 500 and loads through it (#11)', async () => {
    const { w } = await makeWriter();
    for (let i = 0; i < 502; i++) {
      const len = w.currentText.length;
      w.push({ runs: len ? [len, 'x'] : ['x'], at: T0 + i, kind: 'other' });
    }
    await w.flush(true, T0 + 10_000);
    expect((await db.loadSnapshots('d1')).map((s) => s.opIndex)).toEqual([500]);
    expect((await db.loadDraft('d1'))!.text).toBe('x'.repeat(502));
    expect(replay(null, await db.loadOps('d1'))).toBe('x'.repeat(502));
  });

  it('a batch across local midnight updates two day rows (R20)', async () => {
    const mid = Date.UTC(2026, 9, 24, 0, 0);
    const { w } = await makeWriter();
    typeWord(w, 'late', mid - 3000);
    typeWord(w, ' early', mid + 1000);
    await w.flush(true, mid + 5000);
    expect(wordsToday(await db.getDay('2026-10-23'))).toBe(1);
    expect(wordsToday(await db.getDay('2026-10-24'))).toBe(1);
  });

  it('reports the full text when the draft was deleted elsewhere (missing)', async () => {
    const { w, events } = await makeWriter();
    typeWord(w, 'ab', T0);
    w.push({ runs: [2, ' c'], at: T0 + 300, kind: 'other' });
    typeWord(w, 'd', T0 + 400);
    await db.deleteDraft('d1');
    await w.flush(true, T0 + 500);
    expect(events.stale).toBe('ab cd');
    expect(w.isStale).toBe(true);
    w.push({ runs: [5, 'zzz'], at: T0 + 600, kind: 'other' });
    expect(w.currentText).toBe('ab cd');
  });

  it('a corrupt op after the snapshot opens the draft as damaged instead of throwing', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'good', T0);
    await w.flush(true, T0 + 500);
    await db.db.ops.add({ draftId: 'd1', seq: 1, op: [0, 0, 99, 'x'] });
    await db.db.drafts.update('d1', { head: 2 });
    const loaded = (await db.loadDraft('d1'))!;
    expect(loaded.damaged).toBe(true);
    expect(loaded.text).toBe('good');
  });

  it('DamagedDraftError carries the head and epoch the readable text came from; a repair after a change is refused', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'good', T0);
    await w.flush(true, T0 + 500);
    await db.db.ops.add({ draftId: 'd1', seq: 1, op: [0, 0, 99, 'x'] });
    await db.db.drafts.update('d1', { head: 2 });
    const rec = (await db.getRecord('d1'))!;
    const err = await openDraftWriter(db, 'd1', { onStale: () => {}, onCommit: () => {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DamagedDraftError);
    const d = err as DamagedDraftError;
    expect([d.text, d.head, d.epoch]).toEqual(['good', 2, rec.epoch]);
    // another tab repaired it meanwhile: same head after a fresh op, but a renewed epoch
    const other = await db.clearHistory('d1', 'theirs', T0 + 1000, d.head, d.epoch);
    expect(other.ok).toBe(true);
    await db.db.drafts.update('d1', { head: 2 });
    expect((await db.clearHistory('d1', d.text, T0 + 2000, d.head, d.epoch)).ok).toBe(false);
  });

  it('clear-history stores a meta override; without one it keeps the record meta', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'alpha beta', T0);
    await w.flush(true, T0 + 2000);
    const rec = (await db.getRecord('d1'))!;
    const kept = await db.clearHistory('d1', 'alpha beta', T0 + 3000, rec.head, rec.epoch);
    expect(kept.ok && kept.record.meta).toEqual(rec.meta);
    const meta = deriveMeta('# New\n\nthree words here');
    const res = await db.clearHistory('d1', '# New\n\nthree words here', T0 + 4000, 0, (await db.getRecord('d1'))!.epoch, meta);
    expect(res.ok && res.record.meta).toEqual(meta);
    expect((await db.getRecord('d1'))!.meta).toEqual(meta);
  });

  it('a damaged repair stores the word count of the readable text, not the inflated old one', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'good', T0);
    await w.flush(true, T0 + 500);
    await db.db.ops.add({ draftId: 'd1', seq: 1, op: [0, 0, 99, 'x'] });
    // the record was counted from text that no longer replays (e.g. words appended after the damage)
    await db.db.drafts.update('d1', { head: 2, meta: { title: 'good', excerpt: '', words: 40 } });
    const d = (await openDraftWriter(db, 'd1', { onStale: () => {}, onCommit: () => {} }).catch((e: unknown) => e)) as DamagedDraftError;
    expect(d).toBeInstanceOf(DamagedDraftError);
    // what EditorShell's repairDamaged passes
    expect((await db.clearHistory('d1', d.text, T0 + 1000, d.head, d.epoch, deriveMeta(d.text))).ok).toBe(true);
    expect((await db.getRecord('d1'))!.meta.words).toBe(countWords(d.text));
    expect(countWords(d.text)).toBe(1);
  });

  it('import into a non-empty database keeps existing days and rebuilds snapshots', async () => {
    const { w } = await makeWriter();
    for (let i = 0; i < 501; i++) {
      const len = w.currentText.length;
      w.push({ runs: len ? [len, 'y'] : ['y'], at: T0 + i, kind: 'other' });
    }
    await w.flush(true, T0 + 9000);
    const data = await db.exportAll();
    data.drafts[0]!.snapshots.push({ opIndex: 500, text: 'forged' }); // must not be trusted
    const target = new IndexedDbAdapter(`test-${n++}`);
    await target.db.days.put({ key: dayKey(T0, 0), B: 42, peak: 42, resetOffset: 0 });
    await target.importAll(await decodeBackup(await encodeBackup(data)));
    expect(wordsToday(await target.getDay(dayKey(T0, 0)))).toBe(42);
    expect((await target.loadDraft('d1'))!.text).toBe('y'.repeat(501));
  });

  it('import stores only known fields, never extra keys from the file', async () => {
    const rec = { ...newDraft('x1', T0), extra: 'r', meta: { title: 't', excerpt: '', words: 1, extra: 'm' } };
    rec.sessions = [{ opIndex: 0, at: T0, tzOffset: 0, extra: 's' } as never];
    const res = await db.importAll({
      format: 'kansobackup',
      v: 1,
      exportedAt: T0,
      drafts: [{ record: rec, ops: [[0, 0, 'hi']], snapshots: [] }],
      days: [{ key: '2026-10-23', B: 1, peak: 1, resetOffset: 0, extra: 'd' } as never],
    });
    expect(res.added).toBe(1);
    const stored = (await db.db.drafts.get('x1'))!;
    expect(Object.keys(stored).sort()).toEqual(['createdAt', 'epoch', 'head', 'id', 'meta', 'sessions', 'updatedAt', 'v']);
    expect(Object.keys(stored.meta).sort()).toEqual(['excerpt', 'title', 'words']);
    expect(stored.sessions).toEqual([{ opIndex: 0, at: T0, tzOffset: 0 }]);
    expect(await db.db.days.get('2026-10-23')).toEqual({ key: '2026-10-23', B: 1, peak: 1, resetOffset: 0 });
  });

  it('openDraftWriter reuses a preloaded draft while head and epoch match, else reloads', async () => {
    const { w } = await makeWriter();
    typeWord(w, 'one', T0);
    await w.flush(true, T0 + 500);
    const events = { onStale: () => {}, onCommit: () => {} };
    const preloaded = (await db.loadDraft('d1'))!;
    const load = vi.spyOn(db, 'loadDraft');
    const a = await openDraftWriter(db, 'd1', events, () => 0, preloaded);
    expect(load).not.toHaveBeenCalled();
    expect(a.currentText).toBe('one');
    typeWord(w, ' two', T0 + 5000);
    await w.flush(true, T0 + 9000); // head moved past the preloaded copy
    const b = await openDraftWriter(db, 'd1', events, () => 0, preloaded);
    expect(load).toHaveBeenCalledTimes(1);
    expect(b.currentText).toBe('one two');
    expect(b.head).toBe(2);
  });

  it('openDraftWriter reloads a preloaded draft whose head matches but whose epoch was renewed', async () => {
    await db.createDraft(newDraft('d1', T0));
    const preloaded = (await db.loadDraft('d1'))!; // head 0, text ''
    const cleared = await db.clearHistory('d1', 'rewritten', T0 + 100, 0, preloaded.record.epoch); // head 0 again, new epoch
    expect(cleared.ok).toBe(true);
    const load = vi.spyOn(db, 'loadDraft');
    const w = await openDraftWriter(db, 'd1', { onStale: () => {}, onCommit: () => {} }, () => 0, preloaded);
    expect(load).toHaveBeenCalledTimes(1);
    expect(w.head).toBe(0);
    expect(w.currentText).toBe('rewritten');
    expect(w.draft.epoch).not.toBe(preloaded.record.epoch);
  });

  it('rejects files that are not backups', async () => {
    await expect(decodeBackup(new TextEncoder().encode('nope'))).rejects.toThrow('isn’t a Kansowriter backup');
  });
});

describe('settings', () => {
  it('patchSetting merges, so a stale tab cannot write back fields it did not change (red team)', async () => {
    await db.patchSetting('settings', { theme: 'night', lastExportedAt: 1 });
    await Promise.all([db.patchSetting('settings', { lastExportedAt: 99 }), db.patchSetting('settings', { focus: 'off' })]);
    expect(await db.getSetting('settings')).toEqual({ theme: 'night', lastExportedAt: 99, focus: 'off' });
  });
});
