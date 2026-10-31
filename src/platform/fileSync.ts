import type { EditorLink, EditorPort, FileNotice } from '../ui/desktopBridge';
import { decodeMarkdown, encodeMarkdown, hashText, type FileFormat } from './markdownFile';

export interface FileStat {
  /** ms since the epoch */
  mtime: number;
  size: number;
}

/** The narrow file commands of the macOS app (src-tauri/src/files.rs: granted paths only). */
export interface FileOps {
  /** null when the file is gone */
  stat(path: string): Promise<FileStat | null>;
  read(path: string): Promise<Uint8Array>;
  /**
   * Atomic (a temporary file beside it, then a rename). With `expect`, refused with an error
   * containing "changed" when the file isn't that any more right before the rename; a read-only
   * file is refused with "read-only".
   */
  write(path: string, bytes: Uint8Array, expect?: FileStat): Promise<FileStat>;
}

/**
 * A draft's link to a Markdown file, kept desktop-side (the `fileLinks` setting, never in the
 * draft, a backup or a letter): where the file is, how it was written, and what it held when it
 * last matched the draft: `hash` of the text, the file's mtime and size then, and `syncedAt`, the
 * moment that text was taken (an edit after it is newer than the file).
 */
export interface FileLink extends FileFormat {
  path: string;
  hash: string;
  mtime: number;
  size: number;
  /** ms; 0 for a link saved before it was recorded (its edits count as newer) */
  syncedAt?: number;
}

/** typing pause before the file is written (every edit is in IndexedDB at once regardless) */
export const WRITE_DEBOUNCE_MS = 700;

type State = 'synced' | 'conflict' | 'missing' | 'unwritable';

const isChanged = (e: unknown) => String(e).includes('changed');

/**
 * Keeps one open draft and its linked file in step. IndexedDB stays the draft's home (history,
 * replay, letters); the file gets the current text, debounced and on flush (quit).
 *
 *   edit ──► changed() ─(700 ms)─► write(expect = last sync) ─► atomic write, remember
 *                                         └─ "changed" (checked right before the rename) ─► check()
 *   focus / open ──► check(): file as last synced, draft too ──► nothing
 *                           file as last synced, draft edited since ──► write the edits
 *                           file as last synced, draft differs, no newer edits ──► conflict
 *                           file changed, draft not ──► take the file's text as an edit
 *                           both changed ──► conflict notice: Use the file's version | Keep mine
 *                           gone / unreadable ──► missing notice, writing stops until relinked
 *
 * flush() resolves false while edits are waiting that the file can't get: a failed write, a lost
 * or read-only file, and an open conflict (deliberately: the file then doesn't hold the newest
 * words, so a quit says "Still saving" once; the words themselves are in IndexedDB).
 */
export class LinkedFile implements EditorLink {
  private state: State = 'synced';
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** edits not yet written to the file */
  private pending = false;
  private chain: Promise<unknown> = Promise.resolve();
  private conflict: { text: string; format: FileFormat; stat: FileStat; hash: string } | null = null;
  private disposed = false;

  constructor(
    private link: FileLink,
    private readonly port: EditorPort,
    private readonly ops: FileOps,
    private readonly save: (link: FileLink) => Promise<void>,
    private readonly delay = WRITE_DEBOUNCE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): FileLink {
    return this.link;
  }

  get status(): State {
    return this.state;
  }

  /** the file holds everything the draft shows (nothing waiting, nothing in the way) */
  get saved(): boolean {
    return !this.pending && this.state !== 'conflict';
  }

  changed(): void {
    if (this.disposed) return;
    this.pending = true;
    if (this.state !== 'synced') return;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  /** Write now if edits are waiting; true once the file holds them, false when it can't (yet). */
  flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.run(async () => {
      await this.write();
      return this.saved;
    });
  }

  check(): Promise<void> {
    return this.run(() => this.look());
  }

  useFile(): void {
    void this.run(async () => {
      const c = this.conflict;
      if (this.state !== 'conflict' || !c || !this.port.replaceText(c.text)) return;
      this.pending = false;
      await this.remember({ ...this.link, ...c.format, hash: c.hash, mtime: c.stat.mtime, size: c.stat.size, syncedAt: this.now() });
      this.conflict = null;
      this.set('synced');
    });
  }

  keepMine(): void {
    void this.run(async () => {
      const c = this.conflict;
      if (this.state !== 'conflict' || !c) return;
      // overwrite the version seen in the conflict (a newer change on disk would be a new conflict)
      this.link = { ...this.link, mtime: c.stat.mtime, size: c.stat.size };
      this.conflict = null;
      this.pending = true;
      this.set('synced');
      await this.write();
    });
  }

  /** Stop watching; edits still waiting are written first (the returned promise says if they were). */
  dispose(): Promise<boolean> {
    const done = this.flush();
    this.disposed = true;
    return done;
  }

  /** Stop at once without writing (the draft was linked to another file). */
  detach(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
    this.disposed = true;
  }

  private run<T>(f: () => Promise<T>): Promise<T> {
    const next = this.chain.then(f, f);
    this.chain = next.catch(() => {});
    return next;
  }

  private set(state: State, notice?: FileNotice): void {
    if (this.state === state) return;
    this.state = state;
    if (state !== 'synced' && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      this.port.fileNotice(state === 'synced' ? null : (notice ?? null));
    } catch {
      // a UI hook error never stops syncing
    }
  }

  private lose(kind: 'missing' | 'unwritable'): void {
    this.set(kind, { kind: kind === 'missing' ? 'file-missing' : 'file-unwritable' });
  }

  private async remember(link: FileLink): Promise<void> {
    this.link = link;
    try {
      await this.save(link);
    } catch {
      // the next sync stores it again; the file itself is already right
    }
  }

  private async readFile(): Promise<ReturnType<typeof decodeMarkdown> | null> {
    try {
      return decodeMarkdown(await this.ops.read(this.link.path));
    } catch {
      return null;
    }
  }

  private ask(file: ReturnType<typeof decodeMarkdown>, st: FileStat): void {
    this.conflict = { text: file.text, format: file.format, stat: st, hash: hashText(file.text) };
    this.set('conflict', { kind: 'file-conflict' });
  }

  private async look(): Promise<void> {
    if (this.disposed || !this.port.writable()) return;
    let st: FileStat | null;
    try {
      st = await this.ops.stat(this.link.path);
    } catch {
      st = null; // no longer granted or unreadable: the same as gone, for the person
    }
    if (!st) return this.lose('missing');
    const local = hashText(this.port.text());
    if (st.mtime === this.link.mtime && st.size === this.link.size) {
      // untouched since the last sync (a lost file may be back, e.g. a remounted disk)
      if (this.state === 'missing' || this.state === 'unwritable') this.set('synced');
      if (this.state !== 'synced' || local === this.link.hash) return;
      if (this.pending || this.port.editedSince(this.link.syncedAt ?? 0)) {
        // edits made after the last sync (e.g. a write that failed before a quit): write them
        this.pending = true;
        this.schedule();
        return;
      }
      // the draft differs but has nothing newer than the file (restored, imported): ask
      const file = await this.readFile();
      if (!file) return this.lose('missing');
      return this.ask(file, st);
    }
    const file = await this.readFile();
    if (!file) return this.lose('missing');
    const fileHash = hashText(file.text);
    const seen = { ...this.link, ...file.format, hash: fileHash, mtime: st.mtime, size: st.size };
    if (fileHash === this.link.hash || fileHash === local) {
      // touched but the same text, or it already says what the draft says
      await this.remember(fileHash === local ? { ...seen, syncedAt: this.now() } : seen);
      this.conflict = null;
      this.set('synced');
      this.pending = local !== fileHash;
      if (this.pending) this.schedule();
      return;
    }
    if (local === this.link.hash) {
      // changed outside, nothing unsynced here: the file's text comes in as a normal recorded edit
      if (!this.port.replaceText(file.text)) return;
      this.pending = false;
      await this.remember({ ...seen, syncedAt: this.now() });
      this.set('synced');
      return;
    }
    // both changed: never clobber either; ask
    this.ask(file, st);
  }

  private async write(): Promise<void> {
    if (this.state !== 'synced' || !this.pending) return;
    // taken before the text: an edit typed after this moment is newer than what the file gets
    const at = this.now();
    const text = this.port.text();
    this.pending = false;
    try {
      // refused if the file moved on since the last sync (checked right before the rename)
      const res = await this.ops.write(this.link.path, encodeMarkdown(text, this.link), { mtime: this.link.mtime, size: this.link.size });
      await this.remember({ ...this.link, hash: hashText(text), mtime: res.mtime, size: res.size, syncedAt: at });
    } catch (e) {
      this.pending = true;
      // it changed on disk: look before writing over it (closing: the next open compares again)
      if (isChanged(e)) return this.disposed ? undefined : this.look();
      const gone = await this.ops.stat(this.link.path).then(
        (s) => !s,
        () => true,
      );
      this.lose(gone ? 'missing' : 'unwritable');
    }
  }
}
