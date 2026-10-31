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
  /** atomic: a temporary file beside it, then a rename */
  write(path: string, bytes: Uint8Array): Promise<FileStat>;
}

/**
 * A draft's link to a Markdown file, kept desktop-side (the `fileLinks` setting, never in the
 * draft, a backup or a letter): where the file is, how it was written, and what it held when it
 * last matched the draft (`hash` of the text, and the file's mtime and size then).
 */
export interface FileLink extends FileFormat {
  path: string;
  hash: string;
  mtime: number;
  size: number;
}

/** typing pause before the file is written (every edit is in IndexedDB at once regardless) */
export const WRITE_DEBOUNCE_MS = 700;

type State = 'synced' | 'conflict' | 'missing' | 'unwritable';

/**
 * Keeps one open draft and its linked file in step. IndexedDB stays the draft's home (history,
 * replay, letters); the file gets the current text, debounced and on flush (quit).
 *
 *   edit ──► changed() ─(700 ms)─► write: stat ─ same as last sync? ─► atomic write, remember
 *                                         └─ changed on disk ─► check()
 *   focus / open ──► check(): file as last synced ──► nothing (or write unsynced edits)
 *                           file changed, draft not ──► take the file's text as an edit
 *                           both changed ──► conflict notice: Use the file's version | Keep mine
 *                           gone / unreadable ──► missing notice, writing stops until relinked
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
  ) {}

  get current(): FileLink {
    return this.link;
  }

  get status(): State {
    return this.state;
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

  /** Write now if edits are waiting; resolves once the file holds them (or can't). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.run(() => this.write());
  }

  check(): Promise<void> {
    return this.run(() => this.look());
  }

  useFile(): void {
    void this.run(async () => {
      const c = this.conflict;
      if (this.state !== 'conflict' || !c || !this.port.replaceText(c.text)) return;
      this.pending = false;
      await this.remember({ ...this.link, ...c.format, hash: c.hash, mtime: c.stat.mtime, size: c.stat.size });
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

  /** Stop watching; edits still waiting are written first (the returned promise). */
  dispose(): Promise<void> {
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
      if (this.state === 'synced' && local !== this.link.hash) {
        this.pending = true;
        this.schedule();
      }
      return;
    }
    let file: ReturnType<typeof decodeMarkdown>;
    try {
      file = decodeMarkdown(await this.ops.read(this.link.path));
    } catch {
      return this.lose('missing');
    }
    const fileHash = hashText(file.text);
    const seen = { ...this.link, ...file.format, hash: fileHash, mtime: st.mtime, size: st.size };
    if (fileHash === this.link.hash || fileHash === local) {
      // touched but the same text, or it already says what the draft says
      await this.remember(seen);
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
      await this.remember(seen);
      this.set('synced');
      return;
    }
    // both changed: never clobber either; ask
    this.conflict = { text: file.text, format: file.format, stat: st, hash: fileHash };
    this.set('conflict', { kind: 'file-conflict' });
  }

  private async write(): Promise<void> {
    if (this.state !== 'synced' || !this.pending) return;
    let st: FileStat | null;
    try {
      st = await this.ops.stat(this.link.path);
    } catch {
      st = null;
    }
    if (!st) return this.lose('missing');
    if (st.mtime !== this.link.mtime || st.size !== this.link.size) {
      // it changed on disk since the last sync: look before writing over it
      if (!this.disposed) return this.look();
      return; // closing: the draft keeps the words; the next open compares again
    }
    const text = this.port.text();
    this.pending = false;
    try {
      const res = await this.ops.write(this.link.path, encodeMarkdown(text, this.link));
      await this.remember({ ...this.link, hash: hashText(text), mtime: res.mtime, size: res.size });
    } catch {
      this.pending = true;
      const gone = await this.ops.stat(this.link.path).then(
        (s) => !s,
        () => true,
      );
      this.lose(gone ? 'missing' : 'unwritable');
    }
  }
}
