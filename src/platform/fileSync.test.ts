import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorPort, FileNotice } from '../ui/desktopBridge';
import { LinkedFile, WRITE_DEBOUNCE_MS, type FileLink, type FileOps, type FileStat } from './fileSync';
import { baseName, decodeMarkdown, encodeMarkdown, hashText, NotTextError } from './markdownFile';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Markdown files round-trip byte for byte', () => {
  it.each([
    ['LF with a final newline', '# Title\n\nText\n'],
    ['LF without one', '# Title\n\nText'],
    ['CRLF', '# Title\r\n\r\nText\r\n'],
    ['empty', ''],
    ['a lone newline', '\n'],
    ['a BOM', '﻿# Title\n'],
  ])('%s', (_name, raw) => {
    const bytes = enc(raw);
    const { text, format } = decodeMarkdown(bytes);
    expect(text).not.toContain('\r');
    expect(text).not.toContain('﻿');
    expect([...encodeMarkdown(text, format)]).toEqual([...bytes]);
  });

  it('an edit keeps the file’s line endings and final newline', () => {
    const { format } = decodeMarkdown(enc('a\r\nb\r\n'));
    expect(dec(encodeMarkdown('a\nb\nc', format))).toBe('a\r\nb\r\nc\r\n');
  });

  it('mixed line endings come back as the majority ending', () => {
    expect(decodeMarkdown(enc('a\r\nb\r\nc\nd\r\n')).format.eol).toBe('\r\n');
    expect(decodeMarkdown(enc('a\nb\nc\r\nd\n')).format.eol).toBe('\n');
    expect(decodeMarkdown(enc('a\rb\rc\r\n')).format.eol).toBe('\n');
    const { text, format } = decodeMarkdown(enc('a\r\nb\nc\r\n'));
    expect(text).toBe('a\nb\nc');
    expect(dec(encodeMarkdown(text, format))).toBe('a\r\nb\r\nc\r\n');
  });

  it('refuses files that are not UTF-8 text', () => {
    expect(() => decodeMarkdown(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(NotTextError);
    expect(() => decodeMarkdown(enc('a\0b'))).toThrow(NotTextError);
  });

  it('fingerprints differ for different texts and match for equal ones', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
    expect(hashText('')).not.toBe(hashText(' '));
    expect(baseName('/Users/a/My notes.md')).toBe('My notes');
  });
});

/** A disk with one file, and a clock for its mtimes. */
function fakeDisk(initial: string | null) {
  let clock = 1000;
  const disk = { text: initial as string | null, mtime: clock, writes: 0, failWrites: false, failReads: false, readOnly: false };
  const stat = (): FileStat | null => (disk.text === null ? null : { mtime: disk.mtime, size: enc(disk.text).length });
  const ops: FileOps = {
    stat: vi.fn(async () => stat()),
    read: vi.fn(async () => {
      if (disk.text === null || disk.failReads) throw new Error('not-found');
      return enc(disk.text);
    }),
    write: vi.fn(async (_p: string, bytes: Uint8Array, expect?: FileStat) => {
      if (disk.failWrites) throw new Error('io: disk full');
      if (disk.readOnly) throw 'read-only';
      // as files.rs does right before the rename
      const now = stat();
      if (expect && (!now || now.mtime !== expect.mtime || now.size !== expect.size)) throw 'changed';
      disk.text = dec(bytes);
      disk.mtime = ++clock;
      disk.writes++;
      return stat()!;
    }),
  };
  /** someone else edits the file */
  const edit = (text: string | null) => {
    disk.text = text;
    disk.mtime = ++clock;
  };
  return { disk, ops, edit, stat };
}

function fakeEditor(text: string, writable = true) {
  const state = { text, writable, editedAfterSync: false, notices: [] as (FileNotice | null)[], replaced: [] as string[] };
  const port: EditorPort = {
    draftId: 'd1',
    text: () => state.text,
    writable: () => state.writable,
    replaceText: (t) => {
      if (!state.writable) return false;
      state.text = t;
      state.replaced.push(t);
      return true;
    },
    editedSince: () => state.editedAfterSync,
    fileNotice: (n) => void state.notices.push(n),
    exportKanso: async () => null,
  };
  return { state, port };
}

function linked(fileText: string, draftText = fileText) {
  const d = fakeDisk(`${fileText}\n`);
  const e = fakeEditor(draftText);
  const st = d.stat()!;
  const link: FileLink = { path: '/x/notes.md', eol: '\n', finalNewline: true, bom: false, hash: hashText(fileText), ...st, syncedAt: 1 };
  const saved: FileLink[] = [];
  const file = new LinkedFile(link, e.port, d.ops, async (l) => void saved.push(l));
  return { ...d, ...e, file, saved };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('LinkedFile: the draft and its file stay in step', () => {
  it('edits reach the file after a typing pause, debounced into one write, atomically via the write command', async () => {
    const t = linked('Hello');
    t.state.text = 'Hello w';
    t.file.changed();
    t.state.text = 'Hello world';
    t.file.changed();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS - 50);
    expect(t.disk.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.disk.writes).toBe(1);
    expect(t.disk.text).toBe('Hello world\n');
    expect(t.saved.at(-1)?.hash).toBe(hashText('Hello world'));
    expect(t.saved.at(-1)?.mtime).toBe(t.disk.mtime);
  });

  it('flush (quit) writes at once and resolves only once the file holds the words', async () => {
    const t = linked('Hello');
    t.state.text = 'Hello there';
    t.file.changed();
    await expect(t.file.flush()).resolves.toBe(true);
    expect(t.disk.text).toBe('Hello there\n');
    // nothing waiting: a second flush writes nothing
    await expect(t.file.flush()).resolves.toBe(true);
    expect(t.disk.writes).toBe(1);
  });

  it('dispose writes the last edits (a draft switch), then stops', async () => {
    const t = linked('A');
    t.state.text = 'AB';
    t.file.changed();
    await t.file.dispose();
    expect(t.disk.text).toBe('AB\n');
    t.state.text = 'ABC';
    t.file.changed();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS * 2);
    expect(t.disk.text).toBe('AB\n');
  });

  it('changed on disk, nothing unsynced here: the file’s text comes in as a recorded edit', async () => {
    const t = linked('Hello');
    t.edit('Hello from Vim\n');
    await t.file.check();
    expect(t.state.replaced).toEqual(['Hello from Vim']);
    expect(t.state.notices).toEqual([]);
    expect(t.saved.at(-1)).toMatchObject({ hash: hashText('Hello from Vim'), mtime: t.disk.mtime });
    // and it is not written back
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS * 2);
    expect(t.disk.writes).toBe(0);
  });

  it('both changed: a conflict notice, nothing clobbered; "Use the file’s version" takes the file', async () => {
    const t = linked('Hello');
    t.state.text = 'Hello mine';
    t.file.changed();
    t.edit('Hello theirs\n');
    await t.file.check();
    expect(t.state.notices).toEqual([{ kind: 'file-conflict' }]);
    expect(t.state.replaced).toEqual([]);
    // the pending write never lands on their version while the question is open
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS * 2);
    expect(t.disk.text).toBe('Hello theirs\n');
    t.file.useFile();
    await t.file.flush();
    expect(t.state.text).toBe('Hello theirs');
    expect(t.state.notices.at(-1)).toBeNull();
    expect(t.disk.writes).toBe(0);
  });

  it('both changed: "Keep mine" overwrites the file with the draft', async () => {
    const t = linked('Hello');
    t.state.text = 'Hello mine';
    t.file.changed();
    t.edit('Hello theirs\n');
    await t.file.check();
    t.file.keepMine();
    await t.file.flush();
    expect(t.disk.text).toBe('Hello mine\n');
    expect(t.state.text).toBe('Hello mine');
    expect(t.state.notices.at(-1)).toBeNull();
  });

  it('a write that finds the file changed on disk (refused at the rename) looks instead of writing over it', async () => {
    const t = linked('Hello');
    t.state.text = 'Hello mine';
    t.file.changed();
    t.edit('Hello theirs\n');
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS + 10);
    expect(t.disk.text).toBe('Hello theirs\n');
    expect(t.state.notices).toEqual([{ kind: 'file-conflict' }]);
  });

  it('deleted or moved: a notice, the draft is kept, writing stops; it resumes if the file comes back unchanged', async () => {
    const t = linked('Hello');
    const before = t.disk.mtime;
    t.edit(null);
    await t.file.check();
    expect(t.state.notices).toEqual([{ kind: 'file-missing' }]);
    t.state.text = 'Hello more';
    t.file.changed();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS * 2);
    expect(t.disk.writes).toBe(0);
    expect(t.state.text).toBe('Hello more');
    // put back as it was (a remounted disk): syncing resumes and the unsynced edit is written
    t.disk.text = 'Hello\n';
    t.disk.mtime = before;
    await t.file.check();
    expect(t.state.notices.at(-1)).toBeNull();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS + 10);
    expect(t.disk.text).toBe('Hello more\n');
  });

  it('unreadable (or no longer granted) counts as missing', async () => {
    const t = linked('Hello');
    t.edit('changed\n');
    t.disk.failReads = true;
    await t.file.check();
    expect(t.state.notices).toEqual([{ kind: 'file-missing' }]);
  });

  it('a failed write says so and keeps the edit for later', async () => {
    const t = linked('Hello');
    t.disk.failWrites = true;
    t.state.text = 'Hello!';
    t.file.changed();
    // the quit hears about it: the file lacks the newest words
    await expect(t.file.flush()).resolves.toBe(false);
    expect(t.state.notices).toEqual([{ kind: 'file-unwritable' }]);
    expect(t.disk.text).toBe('Hello\n');
  });

  it('a read-only file is never replaced: unwritable notice, flush false', async () => {
    const t = linked('Hello');
    t.disk.readOnly = true;
    t.state.text = 'Hello!';
    t.file.changed();
    await expect(t.file.flush()).resolves.toBe(false);
    expect(t.state.notices).toEqual([{ kind: 'file-unwritable' }]);
    expect(t.disk.text).toBe('Hello\n');
  });

  it('flush is false while a conflict holds edits, or a lost file does; true for a lost file with nothing waiting', async () => {
    const t = linked('Hello');
    t.state.text = 'Hello mine';
    t.file.changed();
    t.edit('Hello theirs\n');
    await t.file.check();
    await expect(t.file.flush()).resolves.toBe(false);
    const u = linked('Quiet');
    u.edit(null);
    await u.file.check();
    await expect(u.file.flush()).resolves.toBe(true);
    u.state.text = 'Quiet, more';
    u.file.changed();
    await expect(u.file.flush()).resolves.toBe(false);
  });

  it('a change on disk landing between the last look and the write is caught at the rename: a conflict, not a clobber', async () => {
    const t = linked('Hello');
    t.state.text = 'Hello mine';
    t.file.changed();
    // the stat the old code did first would have passed; the edit lands just before the write
    const write = t.ops.write as ReturnType<typeof vi.fn<FileOps['write']>>;
    const real = write.getMockImplementation()!;
    write.mockImplementationOnce(async (p: string, b: Uint8Array, e?: FileStat) => {
      t.edit('Hello theirs\n');
      return real(p, b, e);
    });
    await t.file.flush();
    expect(t.disk.text).toBe('Hello theirs\n');
    expect(t.state.notices).toEqual([{ kind: 'file-conflict' }]);
  });

  it('on reopening, a draft that differs from an untouched file without newer edits is a conflict, not an overwrite', async () => {
    const t = linked('Hello', 'Hello, restored from a backup');
    t.state.editedAfterSync = false;
    await t.file.check();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS * 2);
    expect(t.disk.writes).toBe(0);
    expect(t.state.notices).toEqual([{ kind: 'file-conflict' }]);
    t.file.useFile();
    await t.file.flush();
    expect(t.state.text).toBe('Hello');
  });

  it('a sync records when its text was taken, so later edits count as newer', async () => {
    const t = linked('Hello');
    t.state.text = 'Hello there';
    t.file.changed();
    await t.file.flush();
    expect(t.saved.at(-1)?.syncedAt).toBe(Date.now());
  });

  it('touched without changing the text: nothing comes in, nothing is asked', async () => {
    const t = linked('Hello');
    t.edit('Hello\n');
    await t.file.check();
    expect(t.state.replaced).toEqual([]);
    expect(t.state.notices).toEqual([]);
    expect(t.saved.at(-1)?.mtime).toBe(t.disk.mtime);
  });

  it('edits made after the last sync (a failed write before quitting) are written on the next open', async () => {
    const t = linked('Hello', 'Hello, later');
    t.state.editedAfterSync = true;
    await t.file.check();
    await vi.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS + 10);
    expect(t.disk.text).toBe('Hello, later\n');
  });

  it('a read-only editor never takes the file’s text', async () => {
    const t = linked('Hello');
    t.state.writable = false;
    t.edit('Other\n');
    await t.file.check();
    expect(t.state.replaced).toEqual([]);
    expect(t.state.notices).toEqual([]);
  });
});
