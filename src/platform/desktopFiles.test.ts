// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeKanso } from '../core/backup';
import { dayKey } from '../core/words';
import { newDraft } from '../core/draft';
import { IndexedDbAdapter } from '../storage/idb';
import type { EditorPort, HostPort } from '../ui/desktopBridge';
import { createDesktopFiles, DESKTOP_KEY, LINKS_KEY, MD_NOTE, MD_NOTE_DELAY_MS, type Invoke } from './desktopFiles';
import type { FileLink, FileOps, FileStat } from './fileSync';

// jsdom's Blob has no stream(), which the .kanso codec (CompressionStream) needs: use Node's
globalThis.Blob = (await import('node:buffer')).Blob as unknown as typeof Blob;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let n = 0;
let storage: IndexedDbAdapter;
let disk: Map<string, { bytes: Uint8Array; mtime: number }>;
let clock: number;
let opened: string[];
let savePath: string | null;
let defaultFails: boolean;
let defaultCalls: (boolean | undefined)[];
let forgotten: string[];
let failWrites: boolean;
let notices: string[];
let host: HostPort & { open: ReturnType<typeof vi.fn<(id: string) => void>> };

const ops: FileOps = {
  stat: async (p) => {
    const f = disk.get(p);
    return f ? ({ mtime: f.mtime, size: f.bytes.length } satisfies FileStat) : null;
  },
  read: async (p) => {
    const f = disk.get(p);
    if (!f) throw new Error('not-found');
    return f.bytes;
  },
  write: async (p, bytes, expect) => {
    if (failWrites) throw 'io: disk full';
    const f = disk.get(p);
    if (expect && (!f || f.mtime !== expect.mtime || f.bytes.length !== expect.size)) throw 'changed';
    disk.set(p, { bytes, mtime: ++clock });
    return { mtime: clock, size: bytes.length };
  },
};

const invoke = (async (cmd: string, args?: Record<string, unknown>) => {
  if (cmd === 'take_opened') return opened.splice(0);
  if (cmd === 'forget_file') return void forgotten.push(String(args?.path));
  if (cmd === 'pick_save_path') return savePath ? `${savePath}/${String(args?.name)}.${String(args?.kind)}` : null;
  if (cmd === 'set_default_md') {
    defaultCalls.push(args?.mine as boolean | undefined);
    if (defaultFails) throw new Error('-54');
    return ['net.daringfireball.markdown'];
  }
  throw new Error(`unexpected ${cmd}`);
}) as Invoke;

const make = () => createDesktopFiles(ops, invoke, (text) => void notices.push(text));

beforeEach(() => {
  storage = new IndexedDbAdapter(`desktop-files-${n++}`);
  disk = new Map();
  clock = 1000;
  opened = [];
  savePath = '/Users/a/Documents';
  defaultFails = false;
  defaultCalls = [];
  forgotten = [];
  failWrites = false;
  notices = [];
  host = { storage, open: vi.fn<(id: string) => void>(), refreshDrafts: vi.fn(async () => []), broadcast: vi.fn() };
  document.body.innerHTML = '';
});
afterEach(() => vi.useRealTimers());

/** under fake timers: let IndexedDB (real macrotasks) and the timers move along together */
async function pass(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    await vi.advanceTimersByTimeAsync(100);
  }
}
const links = async () => (await storage.getSetting<Record<string, FileLink | null>>(LINKS_KEY)) ?? {};

function port(draftId: string, text: string): EditorPort & { text(): string; set(t: string): void } {
  let t = text;
  return {
    draftId,
    text: () => t,
    set: (x: string) => void (t = x),
    writable: () => true,
    replaceText: (x) => ((t = x), true),
    editedSince: () => true,
    fileNotice: () => {},
    exportKanso: async () => 'Saved Draft.kanso',
  };
}

describe('opening Markdown files (Finder, Dock, open -a, File > Open…)', () => {
  it('a file handed over at launch waits for the page, then becomes a linked draft holding its text', async () => {
    disk.set('/Users/a/notes.md', { bytes: enc('# Notes\r\n\r\nFirst line\r\n'), mtime: 5 });
    opened.push('/Users/a/notes.md');
    const files = make();
    const taken = files.opened(); // Rust's nudge can come before the Router is up
    files.attachHost(host);
    await taken;
    expect(host.open).toHaveBeenCalledOnce();
    const id = host.open.mock.calls[0]![0] as string;
    const loaded = await storage.loadDraft(id);
    expect(loaded?.text).toBe('# Notes\n\nFirst line');
    expect(loaded?.record.meta.title).toBe('Notes');
    // the text is the first recorded op (replay shows it), and opening isn't writing: no words today
    expect(await storage.loadOps(id)).toEqual([[0, 0, '# Notes\n\nFirst line']]);
    const now = Date.now();
    expect((await storage.getDay(dayKey(now, new Date(now).getTimezoneOffset())))?.B ?? 0).toBe(0);
    expect((await links())[id]).toMatchObject({ path: '/Users/a/notes.md', eol: '\r\n', finalNewline: true, mtime: 5 });
    expect(files.linkedPath(id)).toBe('/Users/a/notes.md');
  });

  it('opening a file already linked opens its draft instead of making another', async () => {
    disk.set('/Users/a/notes.md', { bytes: enc('Hi\n'), mtime: 5 });
    const files = make();
    files.attachHost(host);
    opened.push('/Users/a/notes.md');
    await files.opened();
    opened.push('/Users/a/notes.md');
    await files.opened();
    expect(await storage.listDrafts()).toHaveLength(1);
    expect(host.open).toHaveBeenCalledTimes(2);
    expect(host.open.mock.calls[0]![0]).toBe(host.open.mock.calls[1]![0]);
  });

  it('an empty file is named after the file; an unreadable or binary one says so calmly', async () => {
    disk.set('/Users/a/Ideas.md', { bytes: enc(''), mtime: 5 });
    disk.set('/Users/a/photo.md', { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mtime: 5 });
    const files = make();
    files.attachHost(host);
    opened.push('/Users/a/Ideas.md', '/Users/a/photo.md', '/Users/a/gone.md');
    await files.opened();
    const [d] = await storage.listDrafts();
    expect(d?.meta.title).toBe('Ideas');
    expect(notices).toEqual(['“photo.md” isn’t a text file.', 'Couldn’t open “gone.md”.']);
  });
});

describe('.kanso files', () => {
  it('opens a draft with its history; the same file again opens the existing draft; a changed one comes in as a copy', async () => {
    const other = new IndexedDbAdapter(`desktop-files-src-${n++}`);
    const rec = { ...(await import('../core/draft')).newDraft('k', 1) };
    await other.createDraft(rec);
    await other.append({
      draftId: 'k',
      baseHead: 0,
      baseEpoch: rec.epoch,
      ops: [[0, 0, 'Letter']],
      newSession: { opIndex: 0, at: 1, tzOffset: 0 },
      meta: { title: 'Letter', excerpt: '', words: 1 },
      updatedAt: 1,
      dayDeltas: [],
      snapshots: [],
    });
    disk.set('/Users/a/Letter.kanso', { bytes: await encodeKanso((await other.exportDraft('k'))!), mtime: 5 });
    const files = make();
    files.attachHost(host);
    opened.push('/Users/a/Letter.kanso');
    await files.opened();
    expect(host.open).toHaveBeenLastCalledWith('k');
    expect(await storage.loadOps('k')).toEqual([[0, 0, 'Letter']]);
    opened.push('/Users/a/Letter.kanso');
    await files.opened();
    expect(await storage.listDrafts()).toHaveLength(1);
    // the local draft moves on differently: the file's history no longer fits it
    await storage.clearHistory('k', 'Rewritten', 2, 1, (await storage.getRecord('k'))!.epoch);
    opened.push('/Users/a/Letter.kanso');
    await files.opened();
    expect(await storage.listDrafts()).toHaveLength(2);
    expect(notices.at(-1)).toMatch(/^Opened as a copy/);
  });

  it('a file that isn’t a .kanso is refused with the codec’s message', async () => {
    disk.set('/Users/a/bad.kanso', { bytes: enc('nope'), mtime: 5 });
    const files = make();
    files.attachHost(host);
    opened.push('/Users/a/bad.kanso');
    await files.opened();
    expect(notices).toEqual(['That file isn’t a Kansowriter draft.']);
    expect(await storage.listDrafts()).toHaveLength(0);
  });
});

describe('Save to File…, the editor link and quitting', () => {
  it('links the draft to a new file (one file, one draft), writes it with a final newline, and edits follow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const files = make();
    files.attachHost(host);
    const p = port('d1', '# Plan\n\nSteps');
    const link = files.attachEditor(p);
    const label = await files.saveToFile('d1');
    expect(label).toBe('Saved to Plan.md');
    expect(dec(disk.get('/Users/a/Documents/Plan.md')!.bytes)).toBe('# Plan\n\nSteps\n');
    expect(files.linkedPath('d1')).toBe('/Users/a/Documents/Plan.md');
    p.set('# Plan\n\nSteps, more');
    link.changed();
    // quitting right after typing: the flusher writes it at once
    await files.flush();
    expect(dec(disk.get('/Users/a/Documents/Plan.md')!.bytes)).toBe('# Plan\n\nSteps, more\n');
    // another draft saved to the same path takes the link over
    files.attachEditor(port('d2', '# Plan'));
    await files.saveToFile('d2');
    expect(files.linkedPath('d1')).toBeNull();
    expect(files.linkedPath('d2')).toBe('/Users/a/Documents/Plan.md');
    expect((await links()).d1).toBeNull();
  });

  it('a cancelled save panel changes nothing', async () => {
    savePath = null;
    const files = make();
    files.attachHost(host);
    files.attachEditor(port('d1', 'x'));
    expect(await files.saveToFile('d1')).toBeNull();
    expect(files.linkedPath('d1')).toBeNull();
  });

  it('closing a linked draft still writes its last words, and a quit right after waits for them', async () => {
    const files = make();
    files.attachHost(host);
    const p = port('d1', 'One');
    const link = files.attachEditor(p);
    await files.saveToFile('d1');
    p.set('One two');
    link.changed();
    link.dispose();
    await files.flush();
    expect(dec(disk.get('/Users/a/Documents/One.md')!.bytes)).toBe('One two\n');
  });

  it('the File menu runs the saves for the open draft', async () => {
    const files = make();
    files.attachHost(host);
    files.attachEditor(port('d1', 'Menu'));
    await files.menu('save-file');
    await files.menu('save-kanso');
    expect(notices).toEqual(['Saved to Menu.md.', 'Saved Draft.kanso.']);
  });
});

describe('links, grants and the quit', () => {
  it('an editor attached before the links have loaded still gets its link (and sees a change made outside)', async () => {
    // a linked draft from an earlier session
    await storage.createDraft(newDraft('d1', 1));
    disk.set('/Users/a/early.md', { bytes: enc('Before\n'), mtime: 7 });
    const { hashText } = await import('./markdownFile');
    await storage.patchSetting(LINKS_KEY, {
      d1: {
        path: '/Users/a/early.md',
        eol: '\n',
        finalNewline: true,
        bom: false,
        hash: hashText('Before'),
        mtime: 7,
        size: 7,
        syncedAt: 1,
      },
    });
    disk.set('/Users/a/early.md', { bytes: enc('Changed outside\n'), mtime: 8 });
    const files = make();
    const p = port('d1', 'Before');
    // the host is attached (links still loading), then the editor attaches at once
    files.attachHost(host);
    files.attachEditor(p);
    await vi.waitFor(() => expect(p.text()).toBe('Changed outside'));
    expect(files.linkedPath('d1')).toBe('/Users/a/early.md');
  });

  it('a quit is told when a linked file couldn’t get the newest words', async () => {
    const files = make();
    files.attachHost(host);
    const p = port('d1', 'Words');
    const link = files.attachEditor(p);
    await files.saveToFile('d1');
    await expect(files.flush()).resolves.toBe(true);
    failWrites = true;
    p.set('Words, more');
    link.changed();
    await expect(files.flush()).resolves.toBe(false);
    // a closing draft's failed last write counts too
    link.dispose();
    await expect(files.flush()).resolves.toBe(false);
  });

  it('a path no draft is linked to any more loses its grant: relinked elsewhere, or the draft deleted', async () => {
    const files = make();
    files.attachHost(host);
    files.attachEditor(port('d1', 'First'));
    await files.saveToFile('d1');
    expect(forgotten).toEqual([]);
    // the same draft saved to a new file: the old one is let go
    savePath = '/Users/a/Elsewhere';
    await files.saveToFile('d1');
    expect(forgotten).toEqual(['/Users/a/Documents/First.md']);
    await files.draftDeleted('d1');
    expect(forgotten).toEqual(['/Users/a/Documents/First.md', '/Users/a/Elsewhere/First.md']);
    expect(files.linkedPath('d1')).toBeNull();
    expect((await links()).d1).toBeNull();
  });

  it('links of drafts deleted in an earlier session are dropped at start, with their grants', async () => {
    await storage.patchSetting(LINKS_KEY, {
      gone: { path: '/Users/a/old.md', eol: '\n', finalNewline: true, bom: false, hash: 'x', mtime: 1, size: 1 },
    });
    const files = make();
    files.attachHost(host);
    await vi.waitFor(() => expect(forgotten).toEqual(['/Users/a/old.md']));
    expect(files.linkedPath('gone')).toBeNull();
  });
});

describe('the first-launch Markdown note', () => {
  it('says once, after a pause and without asking anything, that .md files open here and how to change it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const notes: { text: string; actions?: { label: string; run(): void }[]; ms?: number | null }[] = [];
    createDesktopFiles(ops, invoke, (text, actions, ms) => void notes.push({ text, actions, ms })).attachHost(host);
    await pass(MD_NOTE_DELAY_MS - 300);
    expect(notes).toEqual([]);
    await pass(500);
    expect(notes.map((n) => n.text)).toEqual([
      'Markdown files now open in Kansowriter. To change that, use Get Info › Open with in Finder.',
    ]);
    expect(notes[0]!.text).toBe(MD_NOTE);
    // stays until dismissed; dismissing changes nothing else
    expect(notes[0]!.ms).toBeNull();
    expect(notes[0]!.actions!.map((a) => a.label)).toEqual(['Dismiss']);
    notes[0]!.actions![0]!.run();
    await pass(200);
    expect(notes).toHaveLength(1);
    // it never touches LaunchServices
    expect(defaultCalls).toEqual([]);
    expect(await storage.getSetting(DESKTOP_KEY)).toEqual({ mdNoted: true });
    // the next launch says nothing
    const again: string[] = [];
    createDesktopFiles(ops, invoke, (t) => void again.push(t)).attachHost(host);
    await pass(MD_NOTE_DELAY_MS * 3);
    expect(again).toEqual([]);
  });

  it('waits while another notice is showing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const busy = document.createElement('div');
    busy.className = 'notice';
    document.body.append(busy);
    const notes: string[] = [];
    createDesktopFiles(ops, invoke, (t) => void notes.push(t)).attachHost(host);
    await pass(MD_NOTE_DELAY_MS * 3);
    expect(notes).toEqual([]);
    busy.remove();
    await pass(MD_NOTE_DELAY_MS + 200);
    expect(notes).toEqual([MD_NOTE]);
  });

  it('a second attach in the same session (the Router remounting) says nothing more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const notes: string[] = [];
    const files = createDesktopFiles(ops, invoke, (t) => void notes.push(t));
    files.attachHost(host);
    files.attachHost(host);
    await pass(MD_NOTE_DELAY_MS * 2);
    expect(notes).toEqual([MD_NOTE]);
  });
});

describe('Make Kansowriter the default for .md (palette)', () => {
  it('sets it back through the app and says so calmly', async () => {
    expect(await make().makeDefault()).toBe('Markdown files now open in Kansowriter');
    expect(defaultCalls).toEqual([undefined]);
  });

  it('a refusal from macOS is reported, not thrown', async () => {
    defaultFails = true;
    expect(await make().makeDefault()).toBe('Couldn’t change the default app for Markdown');
  });
});
