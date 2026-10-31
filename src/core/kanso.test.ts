import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BackupError,
  decodeBackup,
  decodeImport,
  decodeKanso,
  encodeBackup,
  encodeKanso,
  MAX_DECOMPRESSED_BYTES,
  MAX_KANSO_BYTES,
  NOT_A_KANSO,
} from './backup';
import { newDraft } from './draft';
import type { BackupData, BackupDraft } from './storage';
import { IndexedDbAdapter } from '../storage/idb';
import { DraftWriter, type Change } from '../storage/writer';

const rec = newDraft('k1', 1);
const draft = (over: Partial<BackupDraft> = {}): BackupDraft => ({
  record: { ...rec, head: 2, sessions: [{ opIndex: 0, at: 10, tzOffset: 0 }] },
  ops: [
    [0, 0, 'Hello'],
    [5, 1, 5, ' world'],
  ],
  snapshots: [],
  ...over,
});
const deflate = async (o: unknown) =>
  new Uint8Array(
    await new Response(new Blob([JSON.stringify(o)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
  );

describe('.kanso codec: one draft with its history', () => {
  it('round-trips a draft, ops, sessions and base snapshot exactly', async () => {
    const d = draft({ snapshots: [{ opIndex: 0, text: 'base ' }], ops: [[0, 0, 5, 'more']] });
    const file = await decodeKanso(await encodeKanso(d, 42));
    expect(file).toEqual({ format: 'kanso', v: 1, exportedAt: 42, draft: d });
  });

  it.each([
    ['a backup', { format: 'kansobackup', v: 1, exportedAt: 1, draft: draft() }],
    ['a newer version', { format: 'kanso', v: 2, exportedAt: 1, draft: draft() }],
    ['no draft', { format: 'kanso', v: 1, exportedAt: 1 }],
    ['no exportedAt', { format: 'kanso', v: 1, draft: draft() }],
    ['a draft without an id', { format: 'kanso', v: 1, exportedAt: 1, draft: draft({ record: { ...rec, id: '' } }) }],
    ['an op with a zero run', { format: 'kanso', v: 1, exportedAt: 1, draft: draft({ ops: [[0, 0, 0, 'a']] }) }],
    ['a \\r in the text', { format: 'kanso', v: 1, exportedAt: 1, draft: draft({ ops: [[0, 0, 'a\r\nb']] }) }],
    [
      'a session past the log',
      { format: 'kanso', v: 1, exportedAt: 1, draft: draft({ record: { ...rec, sessions: [{ opIndex: 9, at: 1, tzOffset: 0 }] } }) },
    ],
    ['a snapshot past the log', { format: 'kanso', v: 1, exportedAt: 1, draft: draft({ snapshots: [{ opIndex: 7, text: '' }] }) }],
  ])('rejects %s with the same hardening as backups', async (_name, data) => {
    await expect(decodeKanso(await deflate(data))).rejects.toBeInstanceOf(BackupError);
  });

  it('rejects bytes that are not a .kanso', async () => {
    await expect(decodeKanso(new TextEncoder().encode('# just markdown'))).rejects.toThrow(NOT_A_KANSO);
  });

  it('caps the file size and the decompressed size (bomb)', async () => {
    await expect(decodeKanso(new Uint8Array(MAX_KANSO_BYTES + 1))).rejects.toThrow('too large');
    const zeros = new Uint8Array(MAX_DECOMPRESSED_BYTES + 1024);
    const bomb = new Uint8Array(
      await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
    );
    await expect(decodeKanso(bomb)).rejects.toThrow('That draft is too large to open');
  });

  it('a backup and a .kanso never pass for each other; Import tells them apart by the marker inside', async () => {
    const backup: BackupData = { format: 'kansobackup', v: 1, exportedAt: 1, drafts: [draft()], days: [] };
    const kanso = await encodeKanso(draft());
    await expect(decodeBackup(kanso)).rejects.toBeInstanceOf(BackupError);
    await expect(decodeKanso(await encodeBackup(backup))).rejects.toThrow(NOT_A_KANSO);
    expect((await decodeImport(kanso)).kind).toBe('draft');
    expect((await decodeImport(await encodeBackup(backup))).kind).toBe('backup');
    await expect(decodeImport(await deflate({ format: 'kanso', v: 1, exportedAt: 1, draft: { record: {} } }))).rejects.toThrow(NOT_A_KANSO);
  });
});

describe('.kanso import: open the existing draft, or a copy, never a merge', () => {
  let n = 0;
  let db: IndexedDbAdapter;
  beforeEach(() => {
    db = new IndexedDbAdapter(`kanso-${n++}`);
  });

  const T0 = Date.UTC(2026, 9, 31, 12);
  const type = (w: DraftWriter, text: string, at: number) => {
    for (const ch of text) {
      const len = w.currentText.length;
      w.push({ runs: [len, ch], at: at++, kind: 'type' } as Change);
    }
  };
  async function written(id: string, text: string) {
    const r = newDraft(id, T0);
    await db.createDraft(r);
    const w = new DraftWriter(db, r, '', { onStale: () => {}, onCommit: () => {} }, () => 0);
    w.markOpened();
    type(w, text, T0);
    await w.flush(true);
    return w;
  }

  it('exports a draft and imports it elsewhere with its full history (replay intact)', async () => {
    await written('a', 'Dear reader');
    const exported = (await db.exportDraft('a'))!;
    const file = await decodeKanso(await encodeKanso(exported));
    const other = new IndexedDbAdapter(`kanso-other-${n++}`);
    expect(await other.importDraft(file.draft)).toEqual({ id: 'a', status: 'added' });
    const src = await other.loadLetterSource('a');
    expect(src?.text).toBe('Dear reader');
    expect(src?.ops).toEqual(exported.ops);
    expect(src?.record.sessions).toEqual(exported.record.sessions);
    expect(src?.record.meta.title).toBe('Dear reader');
  });

  it('the same history (or an older prefix of it) opens the draft already here', async () => {
    const w = await written('a', 'One');
    const older = (await db.exportDraft('a'))!;
    type(w, ' two', T0 + 5000);
    await w.flush(true);
    expect(await db.importDraft((await db.exportDraft('a'))!)).toEqual({ id: 'a', status: 'existing' });
    expect(await db.importDraft(older)).toEqual({ id: 'a', status: 'existing' });
    expect(await db.listDrafts()).toHaveLength(1);
  });

  it('a longer or different history comes in as a copy, and the local draft is untouched', async () => {
    const w = await written('a', 'One');
    const base = (await db.exportDraft('a'))!;
    const longer: BackupDraft = { ...base, ops: [...base.ops, [0, 0, 3, '!']], record: { ...base.record, head: base.ops.length + 1 } };
    const r = await db.importDraft(longer);
    expect(r.status).toBe('copy');
    const id = (r as { id: string }).id;
    expect(id).not.toBe('a');
    expect((await db.loadDraft(id))?.text).toBe('One!');
    expect((await db.loadDraft(id))?.record.meta.title).toBe('One! (from file)');
    expect((await db.loadDraft('a'))?.text).toBe(w.currentText);
    expect(await db.loadOps('a')).toEqual(base.ops);
  });

  it('a history that does not replay is refused, nothing written', async () => {
    expect(await db.importDraft(draft({ ops: [[0, 0, 4, 'x']] }))).toEqual({ status: 'damaged' });
    expect(await db.listDrafts()).toHaveLength(0);
  });
});
