import { describe, expect, it } from 'vitest';
import { BackupError, backupFileName, decodeBackup, encodeBackup, MAX_DECOMPRESSED_BYTES } from './backup';
import { newDraft } from './draft';
import type { BackupData } from './storage';

const enc = (o: unknown) => encodeBackup(o as BackupData);
const rec = { ...newDraft('a', 1) };
const good = (over: Record<string, unknown> = {}) => ({
  format: 'kansobackup',
  v: 1,
  exportedAt: 1,
  drafts: [{ record: rec, ops: [], snapshots: [] }],
  days: [],
  ...over,
});

describe('decodeBackup validation (#6)', () => {
  it('accepts a valid backup, including a cleared-history base snapshot', async () => {
    const data = good({ drafts: [{ record: rec, ops: [[0, 0, 3, '!']], snapshots: [{ opIndex: 0, text: 'abc' }] }] });
    await expect(decodeBackup(await enc(data))).resolves.toBeTruthy();
  });

  it('accepts a draft whose ops do not cover the document (the importer leaves just that draft out)', async () => {
    const data = good({
      drafts: [
        { record: rec, ops: [[0, 0, 'ok']], snapshots: [] },
        { record: { ...rec, id: 'b' }, ops: [[0, 0, 5, 'x']], snapshots: [] },
      ],
    });
    await expect(decodeBackup(await enc(data))).resolves.toBeTruthy();
  });

  it.each([
    ['wrong format', good({ format: 'x' })],
    ['wrong version', good({ v: 2 })],
    ['op that is not an array', good({ drafts: [{ record: rec, ops: [{}], snapshots: [] }] })],
    ['op with a negative dt', good({ drafts: [{ record: rec, ops: [[-1, 0, 'a']], snapshots: [] }] })],
    ['op with a fractional d', good({ drafts: [{ record: rec, ops: [[0, 0.5, 'a']], snapshots: [] }] })],
    ['op with a zero run', good({ drafts: [{ record: rec, ops: [[0, 0, 0, 'a']], snapshots: [] }] })],
    ['op with an empty insert', good({ drafts: [{ record: rec, ops: [[0, 0, '']], snapshots: [] }] })],
    ['op with a non-run', good({ drafts: [{ record: rec, ops: [[0, 0, null]], snapshots: [] }] })],
    ['null snapshot', good({ drafts: [{ record: rec, ops: [], snapshots: [null] }] })],
    ['non-string snapshot text', good({ drafts: [{ record: rec, ops: [], snapshots: [{ opIndex: 0, text: 5 }] }] })],
    ['snapshot past the log', good({ drafts: [{ record: rec, ops: [], snapshots: [{ opIndex: 3, text: '' }] }] })],
    ['bad sessions', good({ drafts: [{ record: { ...rec, sessions: 'x' }, ops: [], snapshots: [] }] })],
    ['missing updatedAt', good({ drafts: [{ record: { ...rec, updatedAt: undefined }, ops: [], snapshots: [] }] })],
    [
      'duplicate draft ids',
      good({
        drafts: [
          { record: rec, ops: [], snapshots: [] },
          { record: rec, ops: [], snapshots: [] },
        ],
      }),
    ],
    ['bad day', good({ days: [{ key: 'today', B: 1, peak: 1, resetOffset: 0 }] })],
    [
      'duplicate day keys',
      good({
        days: [
          { key: '2026-10-23', B: 1, peak: 1, resetOffset: 0 },
          { key: '2026-10-23', B: 1, peak: 1, resetOffset: 0 },
        ],
      }),
    ],
    ['null draft', good({ drafts: [null] })],
    [
      'non-increasing sessions',
      good({
        drafts: [
          {
            record: {
              ...rec,
              sessions: [
                { opIndex: 0, at: 1, tzOffset: 0 },
                { opIndex: 0, at: 2, tzOffset: 0 },
              ],
            },
            ops: [
              [0, 0, 'a'],
              [0, 0, 1, 'b'],
            ],
            snapshots: [],
          },
        ],
      }),
    ],
    [
      'session past the last op',
      good({ drafts: [{ record: { ...rec, sessions: [{ opIndex: 1, at: 1, tzOffset: 0 }] }, ops: [[0, 0, 'a']], snapshots: [] }] }),
    ],
  ])('rejects %s with BackupError', async (_name, data) => {
    await expect(decodeBackup(await enc(data))).rejects.toBeInstanceOf(BackupError);
  });

  it('rejects non-deflate bytes', async () => {
    await expect(decodeBackup(new TextEncoder().encode('nope'))).rejects.toThrow('isn’t a Kansowriter backup');
  });

  it('caps decompressed size (decompression bomb)', async () => {
    const zeros = new Uint8Array(MAX_DECOMPRESSED_BYTES + 1024);
    const bomb = new Uint8Array(
      await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer(),
    );
    expect(bomb.byteLength).toBeLessThan(2 * 1024 * 1024);
    await expect(decodeBackup(bomb)).rejects.toThrow('too large');
  });
});

describe('backupFileName (#12)', () => {
  it('uses the local date', () => {
    // 02:00 UTC is 21:00 the previous day at UTC-5 (offset +300)
    expect(backupFileName(Date.UTC(2026, 9, 24, 2, 0), 300)).toBe('kansowriter-2026-10-23.kansobackup');
  });
});
