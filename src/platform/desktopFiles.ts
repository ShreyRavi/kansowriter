import { BackupError, decodeKanso } from '../core/backup';
import { deriveMeta, newDraft } from '../core/draft';
import type { DesktopBridge, EditorLink, EditorPort, HostPort } from '../ui/desktopBridge';
import { safeFileName } from '../ui/platform';
import { LinkedFile, type FileLink, type FileOps } from './fileSync';
import { baseName, decodeMarkdown, encodeMarkdown, fileName, hashText, NEW_FILE_FORMAT, NotTextError } from './markdownFile';
import { noticeShowing, showDesktopNotice, type NoticeAction } from './notice';

/** setting key: draft id → its linked file (desktop only; never in drafts, backups or letters) */
export const LINKS_KEY = 'fileLinks';
/** setting key: desktop-only state ({ mdNoted }) */
export const DESKTOP_KEY = 'desktop';
/** the first-launch note waits this long after start, so it never greets someone mid-thought */
export const MD_NOTE_DELAY_MS = 1500;
/** Kansowriter is the .md default once installed (src-tauri/src/default_app.rs); said once */
export const MD_NOTE = 'Markdown files now open in Kansowriter. To change that, use Get Info › Open with in Finder.';

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
export type Notify = (text: string, actions?: NoticeAction[], ms?: number | null) => void;

export interface DesktopFiles extends DesktopBridge {
  /** files were handed to the app (Rust calls window.__kansoOpened): take and open them */
  opened(): Promise<void>;
  /** a File menu item the page runs */
  menu(id: string): Promise<void>;
  /** write every linked file that has edits waiting (quit): true when every file holds its draft's text */
  flush(): Promise<boolean>;
  /** the window came back into focus: look for changes on disk */
  focused(): void;
}

type LinkMap = Record<string, FileLink | null>;

const isLink = (x: unknown): x is FileLink => {
  const l = x as Partial<FileLink> | null;
  return (
    typeof l === 'object' &&
    l !== null &&
    typeof l.path === 'string' &&
    l.path.startsWith('/') &&
    typeof l.hash === 'string' &&
    typeof l.mtime === 'number' &&
    typeof l.size === 'number' &&
    (l.eol === '\n' || l.eol === '\r\n') &&
    typeof l.finalNewline === 'boolean' &&
    typeof l.bom === 'boolean'
  );
};

/**
 * The macOS app's file side of the shared UI (src/ui/desktopBridge.ts): opening .md and .kanso
 * files, keeping linked Markdown files in step (fileSync.ts), the File menu's saves, and the
 * one-time note that Markdown files now open here.
 */
export function createDesktopFiles(ops: FileOps, invoke: Invoke, notify: Notify = showDesktopNotice): DesktopFiles {
  let host: HostPort | null = null;
  let lastHost: HostPort | null = null;
  /** resolves once a host is attached AND its links are loaded: nothing may look a link up earlier */
  let markReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (markReady = resolve));
  const links = new Map<string, FileLink>();
  const live = new Map<string, { file: LinkedFile; port: EditorPort }>();
  const editors: EditorPort[] = [];
  const listeners = new Set<() => void>();
  const finals = new Set<Promise<boolean>>();
  let opening: Promise<void> = Promise.resolve();
  let noted = false;

  const whenHost = async () => {
    await ready;
    return (host ?? lastHost)!;
  };
  const emit = () =>
    listeners.forEach((l) => {
      try {
        l();
      } catch {
        // a listener's error never stops syncing
      }
    });

  const persist = async (draftId: string, link: FileLink | null) => {
    const before = links.get(draftId)?.path;
    if (link) links.set(draftId, link);
    else links.delete(draftId);
    if (before !== link?.path) {
      emit();
      // a path no draft is linked to any more loses its grant (src-tauri/src/files.rs)
      if (before && ![...links.values()].some((l) => l.path === before)) void invoke('forget_file', { path: before }).catch(() => {});
    }
    await (await whenHost()).storage.patchSetting(LINKS_KEY, { [draftId]: link });
  };

  const startLink = (draftId: string, link: FileLink, port: EditorPort) => {
    live.get(draftId)?.file.detach();
    const file = new LinkedFile(link, port, ops, (l) => persist(draftId, l));
    live.set(draftId, { file, port });
    return file;
  };

  const editorFor = (draftId: string) => [...editors].reverse().find((p) => p.draftId === draftId);

  /** the stored links; returns the draft ids it found */
  const loadLinks = async (h: HostPort) => {
    const stored = await h.storage.getSetting<LinkMap>(LINKS_KEY).catch(() => undefined);
    const found: string[] = [];
    if (stored && typeof stored === 'object')
      for (const [id, l] of Object.entries(stored))
        if (isLink(l) && !links.has(id)) {
          links.set(id, l);
          found.push(id);
        }
    emit();
    return found;
  };

  /** stored links whose drafts are gone (deleted in an older session) let go of their files */
  const dropStale = async (h: HostPort, ids: string[]) => {
    for (const id of ids)
      if (links.has(id) && (await h.storage.getRecord(id).catch(() => true)) === undefined) await persist(id, null).catch(() => {});
  };

  /** A draft linked to this path that still exists (a stale link is dropped). */
  const draftFor = async (h: HostPort, path: string) => {
    for (const [id, l] of links) {
      if (l.path !== path) continue;
      if (await h.storage.getRecord(id).catch(() => undefined)) return id;
      await persist(id, null);
    }
    return null;
  };

  const openMarkdown = async (h: HostPort, path: string) => {
    const name = fileName(path);
    const linked = await draftFor(h, path);
    if (linked) {
      h.open(linked);
      void live.get(linked)?.file.check();
      return;
    }
    let text: string;
    let format;
    let stat;
    try {
      stat = await ops.stat(path);
      if (!stat) throw new Error('gone');
      ({ text, format } = decodeMarkdown(await ops.read(path)));
    } catch (e) {
      notify(e instanceof NotTextError ? `“${name}” isn’t a text file.` : `Couldn’t open “${name}”.`);
      return;
    }
    const now = Date.now();
    const tz = new Date(now).getTimezoneOffset();
    const rec = newDraft(crypto.randomUUID(), now);
    const meta = deriveMeta(text);
    // a file with no text yet is named after the file until something is written
    await h.storage.createDraft(text.trim() ? rec : { ...rec, meta: { ...rec.meta, title: baseName(path) || 'Untitled' } });
    if (text) {
      // the file's text is the draft's first recorded op; opening it isn't writing, so no words today
      await h.storage.append({
        draftId: rec.id,
        baseHead: 0,
        baseEpoch: rec.epoch,
        ops: [[0, 0, text]],
        newSession: { opIndex: 0, at: now, tzOffset: tz },
        meta,
        updatedAt: now,
        dayDeltas: [],
        snapshots: [],
      });
    }
    await persist(rec.id, { path, ...format, hash: hashText(text), mtime: stat.mtime, size: stat.size, syncedAt: Date.now() });
    await h.refreshDrafts();
    h.broadcast({ type: 'library' });
    h.open(rec.id);
  };

  const openKanso = async (h: HostPort, path: string) => {
    const name = fileName(path);
    let draft;
    try {
      draft = (await decodeKanso(await ops.read(path))).draft;
    } catch (e) {
      notify(e instanceof BackupError ? `${e.message}.` : `Couldn’t open “${name}”.`);
      return;
    }
    const r = await h.storage.importDraft(draft).catch(() => null);
    if (!r) return notify('Couldn’t open that draft: this Mac’s storage is full or unavailable.');
    if (r.status === 'damaged') return notify('That draft’s history couldn’t be read.');
    await h.refreshDrafts();
    h.broadcast({ type: 'library' });
    h.open(r.id);
    if (r.status === 'copy') notify('Opened as a copy: this draft has changed here since that file was saved.');
  };

  const openPath = async (path: string) => {
    const h = await whenHost();
    try {
      if (/\.kanso$/i.test(path)) await openKanso(h, path);
      else await openMarkdown(h, path);
    } catch {
      notify(`Couldn’t open “${fileName(path)}”.`);
    }
  };

  const makeDefault = async () => {
    try {
      await invoke<string[]>('set_default_md');
      return 'Markdown files now open in Kansowriter';
    } catch {
      return 'Couldn’t change the default app for Markdown';
    }
  };

  /** first launch: say once that .md files now open here, and how to change that */
  const noteOnce = async (h: HostPort) => {
    if (noted) return;
    noted = true;
    const d = await h.storage.getSetting<{ mdNoted?: boolean }>(DESKTOP_KEY).catch(() => undefined);
    if (d?.mdNoted) return;
    const show = () => {
      // never over another notice (a saving problem matters more): wait for the strip to be free
      if (noticeShowing()) return void setTimeout(show, MD_NOTE_DELAY_MS);
      void h.storage.patchSetting(DESKTOP_KEY, { mdNoted: true }).catch(() => {});
      notify(MD_NOTE, [{ label: 'Dismiss', run: () => {} }], null);
    };
    setTimeout(show, MD_NOTE_DELAY_MS);
  };

  const files: DesktopFiles = {
    attachHost(h) {
      host = h;
      lastHost = h;
      void loadLinks(h).then((ids) => {
        markReady();
        void dropStale(h, ids);
        void files.opened();
        void noteOnce(h);
      });
      return () => {
        if (host === h) host = null;
      };
    },

    attachEditor(port): EditorLink {
      editors.push(port);
      let disposed = false;
      const mine = () => {
        const l = live.get(port.draftId);
        return l?.port === port ? l.file : null;
      };
      void whenHost().then(() => {
        if (disposed) return;
        const link = links.get(port.draftId);
        if (link && !mine()) void startLink(port.draftId, link, port).check();
      });
      return {
        changed: () => mine()?.changed(),
        check: () => void mine()?.check(),
        useFile: () => mine()?.useFile(),
        keepMine: () => mine()?.keepMine(),
        dispose: () => {
          disposed = true;
          const i = editors.indexOf(port);
          if (i >= 0) editors.splice(i, 1);
          const f = mine();
          if (!f) return;
          live.delete(port.draftId);
          // the last edits still reach the file, and a quit right after waits for them
          const done = f.dispose().catch(() => false);
          finals.add(done);
          void done.then(() => finals.delete(done));
        },
      };
    },

    linkedPath: (draftId) => links.get(draftId)?.path ?? null,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async saveToFile(draftId) {
      const port = editorFor(draftId);
      if (!port) return 'Open this draft first';
      const at = Date.now();
      const text = port.text();
      const path = await invoke<string | null>('pick_save_path', { kind: 'md', name: safeFileName(deriveMeta(text, 0).title) });
      if (!path) return null;
      let stat;
      try {
        stat = await ops.write(path, encodeMarkdown(text, NEW_FILE_FORMAT));
      } catch {
        return `Couldn’t save to “${fileName(path)}”`;
      }
      // one file, one draft: a draft that was linked to this path lets go of it
      for (const [other, l] of [...links]) {
        if (other === draftId || l.path !== path) continue;
        live.get(other)?.file.detach();
        live.delete(other);
        await persist(other, null);
      }
      const link: FileLink = { path, ...NEW_FILE_FORMAT, hash: hashText(text), mtime: stat.mtime, size: stat.size, syncedAt: at };
      const current = live.get(draftId)?.file;
      if (current) {
        // the old file keeps what it had; this draft now writes only to the new one
        live.delete(draftId);
        current.detach();
      }
      await persist(draftId, link);
      startLink(draftId, link, port);
      port.fileNotice(null);
      // anything typed while the panel was open
      if (port.text() !== text) live.get(draftId)?.file.changed();
      return `Saved to ${fileName(path)}`;
    },

    async saveKanso(name, bytes) {
      const path = await invoke<string | null>('pick_save_path', { kind: 'kanso', name });
      if (!path) return null;
      try {
        await ops.write(path, bytes);
      } catch {
        return `Couldn’t save “${fileName(path)}”`;
      }
      return `Saved ${fileName(path)}`;
    },

    makeDefault,

    async opened() {
      const run = async () => {
        await whenHost();
        const paths = await invoke<string[]>('take_opened').catch(() => [] as string[]);
        for (const p of paths) await openPath(p);
      };
      opening = opening.then(run, run);
      return opening;
    },

    async menu(id) {
      const port = editors[editors.length - 1];
      if (!port) return;
      if (id === 'save-file') {
        const label = await files.saveToFile(port.draftId);
        if (label) notify(`${label}.`);
      } else if (id === 'save-kanso') {
        const label = await port.exportKanso();
        if (label) notify(`${label}.`);
      }
    },

    async flush() {
      // false while any linked file lacks edits it should have: the quit then says "Still saving"
      const saved = await Promise.all([...[...live.values()].map((l) => l.file.flush().catch(() => false)), ...finals]);
      return saved.every(Boolean);
    },

    async draftDeleted(draftId) {
      await whenHost();
      live.get(draftId)?.file.detach();
      live.delete(draftId);
      if (links.has(draftId)) await persist(draftId, null);
    },

    focused() {
      for (const { file } of live.values()) void file.check();
    },
  };
  return files;
}
