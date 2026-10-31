import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { createEditor, followText, loadText, replaceRecorded, setFocusMode, setReadOnly, setTypewriter } from '../editor/setup';
import { attachDraftSession, channel, FOLLOW_COALESCE_MS, type ChannelMessage, type SessionHandle } from '../storage/lifecycle';
import { DamagedDraftError, openDraftWriter, type DraftWriter } from '../storage/writer';
import { deriveMeta, renameChange, type DraftRecord } from '../core/draft';
import { dayKey } from '../core/words';
import type { LoadedDraft } from '../core/storage';
import { useStore } from './store';
import { TYPEFACES, resolveTheme } from './settings';
import type { PaletteActions } from './paletteActions';
import { LibrarySidebar } from './LibrarySidebar';
import { download, isMac, requestPersistence, safeFileName } from './platform';
import { downloadKanso, exportAll, exportKanso, importBackup } from './backupActions';
import { displayPath, getDesktop, type EditorLink, type FileNotice } from './desktopBridge';
import { applyUpdate, useUpdateReady } from './updates';
import { CloseIcon, EnvelopeIcon, FocusIcon, MenuIcon, MoonIcon, MoreIcon, SearchIcon, SunIcon } from './icons';
import { setUnsavedProvider } from './unsaved';
import { useScrollLock } from './scrollLock';
import { useDialog } from './useDialog';
import { activeFormats, NO_FORMATS, sameFormats, setParagraphCommand, type ActiveFormats } from '../editor/format';
import { SHORTCUTS, type FormatId } from '../editor/keys';
import { FormatToolbar } from './FormatToolbar';

/**
 * Where the formatting toolbar lives: the header on desktop; on phones (and narrow windows, small
 * touch tablets, landscape phones) a row docked above the on-screen keyboard while the text has focus.
 */
const DOCK_QUERY = '(max-width: 799px), (pointer: coarse) and (max-width: 1023px), (pointer: coarse) and (max-height: 500px)';

function useMedia(query: string): boolean {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const m = matchMedia(query);
    const onChange = () => setOn(m.matches);
    onChange();
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, [query]);
  return on;
}

/** typing pause before the update notice may first appear while the chrome is faded */
const UPDATE_IDLE_MS = 3000;

// the palette is its own chunk: it isn't needed to start writing (fetched at idle, see below)
const loadPalette = () => import('./CommandPalette');
// one retry for a dropped request; a second failure (e.g. the chunk is gone after a deploy)
// rejects into PaletteBoundary below, which closes the palette and keeps the editor open
const CommandPalette = lazy(() =>
  loadPalette()
    .catch(() => loadPalette())
    .then((m) => ({ default: m.CommandPalette })),
);
// Send as letter is its own chunk too: fetched when the envelope is hovered or Send starts (the
// same retry, then the same boundary and Reload notice; SendLoading holds its place meanwhile)
const loadSend = () => import('./SendPanel');
const SendPanel = lazy(() =>
  loadSend()
    .catch(() => loadSend())
    .then((m) => ({ default: m.SendPanel })),
);
const preloadSend = () => void loadSend().catch(() => {});

/**
 * Catches the palette or the send panel failing (its chunk won't load, or it throws) so the error
 * never reaches the root ErrorBoundary: that would unmount the editor, its unsaved-words guard and
 * the session.
 */
class PaletteBoundary extends Component<{ children: ReactNode; onError(): void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The send panel's frame while its chunk loads: the same quiet fixed-height placeholder the panel
 * shows while it reads the draft, already a dialog, so Esc and Close work before the chunk arrives.
 * It hands focus back through closeSend, never on unmount: handing it to the editor on the way to
 * the panel would make WebKit scroll the draft to its caret.
 */
function SendLoading({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, onClose, undefined, false);
  return (
    <div className="send-wrap" role="dialog" aria-modal="true" aria-labelledby="send-title" ref={ref}>
      <div className="send-top ui">
        <h2 id="send-title">Send as letter</h2>
        <button
          type="button"
          className="icon-btn"
          aria-label="Close"
          data-tip={`Close Esc · ${isMac() ? '⌘' : 'Ctrl '}⇧L`}
          data-tip-align="end"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <div className="send-preview" />
      <div className="send-panel ui">
        <div className="send-loading" aria-busy="true" />
      </div>
    </div>
  );
}

/** Resolves true when it left; false when unsaved words kept the editor open (the notice then holds `go`). */
export type LeaveGuard = (go: () => void) => Promise<boolean>;

type NoticeState =
  | { kind: 'stale' }
  | { kind: 'readonly' }
  | { kind: 'saving-error' }
  | { kind: 'unsaved-leave' }
  /** head + epoch: the record `text` was read from; the repair refuses if the draft changed since */
  | { kind: 'damaged'; text: string; head: number; epoch: string }
  | { kind: 'open-error' }
  | null;

/** The draft's linked file (macOS), kept current as links change; null on the web. */
function useLinkedPath(draftId: string): string | null {
  const desktop = getDesktop();
  const [path, setPath] = useState(() => desktop?.linkedPath(draftId) ?? null);
  useEffect(() => {
    if (!desktop) return;
    const read = () => setPath(desktop.linkedPath(draftId));
    read();
    return desktop.subscribe(read);
  }, [desktop, draftId]);
  return path;
}

interface Props {
  draftId: string;
  onOpen(id: string): void;
  onNew(title?: string): void;
  onDeleted(): void;
  /** register the unsaved-words guard so browser Back/Forward goes through it too */
  onGuard?(guard: LeaveGuard | null): void;
}

export function EditorShell({ draftId, onOpen, onNew, onDeleted, onGuard }: Props) {
  const store = useStore();
  const { storage, settings, update, today, refreshToday, refreshDrafts, upsertDraft, broadcast } = store;
  const updateReady = useUpdateReady();
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const writerRef = useRef<DraftWriter | null>(null);
  const sessionRef = useRef<SessionHandle | null>(null);
  const [title, setTitle] = useState('');
  const [notice, setNotice] = useState<NoticeState>(null);
  /** macOS: the linked file's problem, below every saving notice (the draft itself is always saved) */
  const [fileNote, setFileNote] = useState<FileNotice | null>(null);
  const linkRef = useRef<EditorLink | null>(null);
  const linkedPath = useLinkedPath(draftId);
  const desktop = getDesktop();
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [palette, setPalette] = useState(false);
  /** the open send panel: `unsaved` when the page holds words storage doesn't (the letter can't carry them) */
  const [send, setSend] = useState<{ unsaved: boolean } | null>(null);
  /** Send was opened from the text (shortcut, palette): Close returns to the text, not the opener */
  const sendRefocusRef = useRef(false);
  /** where focus was when Send opened (the loading frame doesn't hand it back; closeSend does) */
  const sendOpenerRef = useRef<HTMLElement | null>(null);
  // the draft behind an overlay never scrolls (typewriter and the editor's own scroll are untouched otherwise)
  useScrollLock(palette || sidebar || !!send);
  const [mountKey, setMountKey] = useState(0);
  /** the update notice, latched: it first appears only while the writer isn't mid-sentence, then stays */
  const [showUpdate, setShowUpdate] = useState(false);
  /** the palette or the send panel couldn't open (its chunk is likely gone after a deploy): offer a reload */
  const [chunkFailed, setChunkFailed] = useState<'commands' | 'Send as letter' | null>(null);
  const lastActivity = useRef(0);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** this tab stopped saving and the editor holds words storage doesn't: every guard checks it */
  const staleRef = useRef(false);
  /** another tab holds the draft: this view only follows what it commits */
  const readOnlyRef = useRef(false);
  /** this tab handed the draft over and its final flush is still running: never follow meanwhile */
  const handingOverRef = useRef(false);
  /** the full text a stale tab handed back: Copy keeps exactly this, never a reloaded view */
  const staleTextRef = useRef<string | null>(null);
  /** schedule a follow (catch-up) of what the writing tab committed; set by the follower effect */
  const followRef = useRef<() => void>(() => {});
  const leaveRef = useRef<LeaveGuard>(async (go) => (go(), true));
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  /** the formatting toolbar: what the caret sits in, and whether the text can be changed here at all */
  const [formats, setFormats] = useState<ActiveFormats>(NO_FORMATS);
  const [canFormat, setCanFormat] = useState(false);
  const formatFrame = useRef(0);
  const formatState = useRef<EditorState | null>(null);
  /** coalesced to one look per frame: typing never waits on it */
  const onEditorUpdate = useCallback((state: EditorState) => {
    formatState.current = state;
    if (formatFrame.current) return;
    formatFrame.current = requestAnimationFrame(() => {
      formatFrame.current = 0;
      const s = formatState.current;
      if (!s) return;
      setCanFormat(!s.readOnly);
      const f = activeFormats(s);
      setFormats((prev) => (sameFormats(prev, f) ? prev : f));
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(formatFrame.current), []);
  const docked = useMedia(DOCK_QUERY);
  const [textFocused, setTextFocused] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);

  // ---------- editor + single-writer session ----------
  useEffect(() => {
    let disposed = false;
    staleRef.current = false;
    readOnlyRef.current = false;
    handingOverRef.current = false;
    staleTextRef.current = null;
    const host = hostRef.current!;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCommit: DraftRecord | null = null;

    void (async () => {
      const loaded = await storage.loadDraft(draftId).catch(() => undefined);
      if (disposed) return;
      if (loaded === undefined) return setNotice({ kind: 'open-error' });
      if (!loaded) return onDeleted();
      setTitle(loaded.record.meta.title);
      const view = createEditor(host, {
        doc: loaded.text,
        readOnly: true,
        focus: settingsRef.current.focus,
        typewriter: settingsRef.current.typewriter,
        onChange: (c) => {
          writerRef.current?.push(c);
          linkRef.current?.changed();
        },
        onActivity: () => activity(),
        onUpdate: onEditorUpdate,
      });
      viewRef.current = view;
      onEditorUpdate(view.state);
      // macOS: a draft linked to a Markdown file keeps it in step (the view object is captured, so
      // the last write after a switch still reads the text this editor showed)
      linkRef.current =
        getDesktop()?.attachEditor({
          draftId,
          text: () => view.state.doc.toString(),
          writable: () => !!writerRef.current && !staleRef.current && viewRef.current === view,
          replaceText: (text) => {
            if (!writerRef.current || staleRef.current || viewRef.current !== view) return false;
            replaceRecorded(view, text);
            return view.state.doc.toString() === text;
          },
          editedSince: (at) => {
            const w = writerRef.current;
            return !!w && (w.dirty || w.draft.updatedAt > at);
          },
          fileNotice: (n) => {
            setFileNote(n);
            if (n) setChromeVisible(true);
          },
          exportKanso: () => exportKansoRef.current(),
        }) ?? null;

      const events = {
        onStale: (text: string) => {
          staleRef.current = true;
          handingOverRef.current = false;
          if (writerRef.current) {
            // still the writer: the view is what was typed (never behind the writer), keep it
            staleTextRef.current = view.state.doc.toString();
          } else {
            // handed over: a follow may have replaced the view with partly saved text; show what is handed back
            staleTextRef.current = text;
            loadText(view, text);
          }
          writerRef.current = null;
          setReadOnly(view, true);
          setChromeVisible(true);
          setNotice({ kind: 'stale' });
        },
        onCommit: (rec: DraftRecord) => {
          setTitle(rec.meta.title);
          // a later save caught up: the "not saved" warning no longer applies
          if (!staleRef.current && !writerRef.current?.dirty) setNotice((n) => (n?.kind === 'unsaved-leave' ? null : n));
          broadcast({ type: 'committed', draftId, record: rec });
          lastCommit = rec;
          if (commitTimer) return;
          commitTimer = setTimeout(() => {
            commitTimer = null;
            void refreshToday();
            // just this draft's row: a full listDrafts every commit re-rendered every store reader
            if (lastCommit) upsertDraft(lastCommit);
          }, 250);
        },
        onError: (e: unknown | null) =>
          setNotice((n) => {
            if (staleRef.current || n?.kind === 'unsaved-leave') return n;
            return e ? { kind: 'saving-error' } : n?.kind === 'saving-error' ? null : n;
          }),
      };

      // the first open reuses the draft just loaded (one replay); a later takeover reads it fresh
      let firstLoad: LoadedDraft | undefined = loaded;
      sessionRef.current = attachDraftSession(
        draftId,
        () => {
          const preloaded = firstLoad;
          firstLoad = undefined;
          return openDraftWriter(storage, draftId, events, undefined, preloaded);
        },
        {
          onWritable: (w) => {
            if (staleRef.current) {
              // a clear's rebuilt writer, after a flush meanwhile went stale: resume only when every
              // handed-back word was carried onto it; otherwise the stale notice keeps guarding them
              if (w.currentText !== staleTextRef.current) return;
              staleRef.current = false;
              staleTextRef.current = null;
              setNotice((n) => (n?.kind === 'stale' ? null : n));
            }
            loadText(view, w.currentText);
            if (view.state.doc.toString() !== w.currentText) {
              // the editor normalized the text (e.g. \r line breaks): recording would desync from the
              // log, so offer the same repair as a damaged history (rebase on the text as shown)
              void sessionRef.current?.dispose();
              setNotice({ kind: 'damaged', text: view.state.doc.toString(), head: w.head, epoch: w.draft.epoch });
              return;
            }
            writerRef.current = w;
            readOnlyRef.current = false;
            handingOverRef.current = false;
            setReadOnly(view, false);
            setNotice((n) => (n?.kind === 'readonly' ? null : n));
            view.focus();
            // the file may have changed on disk while the draft was closed
            linkRef.current?.check();
          },
          onReadOnly: (reason, error) => {
            writerRef.current = null;
            // after a handover the final flush is still running: follow only once onHandedOver says
            // storage holds everything (a failed flush sends onStale instead)
            readOnlyRef.current = reason === 'other-tab' || reason === 'stolen';
            handingOverRef.current = reason === 'handed-over';
            setReadOnly(view, true);
            setChromeVisible(true);
            // a commit may have landed before readOnlyRef was set (its message found nothing to follow)
            if (readOnlyRef.current) followRef.current();
            if (reason === 'error') {
              // never replace a stale notice: it guards unsaved words still in the editor
              setNotice((n) =>
                staleRef.current
                  ? n
                  : error instanceof DamagedDraftError
                    ? { kind: 'damaged', text: error.text, head: error.head, epoch: error.epoch }
                    : { kind: 'open-error' },
              );
            } else setNotice((n) => (staleRef.current ? n : { kind: 'readonly' }));
          },
          onHandedOver: () => {
            if (!handingOverRef.current || staleRef.current) return;
            handingOverRef.current = false;
            readOnlyRef.current = true;
            followRef.current(); // catch up with anything the new holder already committed
          },
        },
        async (w, now) => (await storage.clearHistory(draftId, w.savedText, now, w.head, w.draft.epoch)).ok,
      );
    })().catch(() => {
      if (!disposed) setNotice({ kind: 'open-error' });
    });

    return () => {
      disposed = true;
      if (commitTimer) clearTimeout(commitTimer);
      linkRef.current?.dispose();
      linkRef.current = null;
      setFileNote(null);
      const s = sessionRef.current;
      sessionRef.current = null;
      writerRef.current = null;
      void s?.dispose().then(() => {
        void refreshDrafts();
        void refreshToday();
      });
      viewRef.current?.destroy();
      viewRef.current = null;
      formatState.current = null;
      setCanFormat(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, mountKey]);

  // ---------- another tab writes this draft ----------
  useEffect(() => {
    const bc = channel();
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** a commit arrived while the page was hidden: catch up once it is visible again */
    let behind = false;
    // only a read-only tab follows (this tab's own commits arrive here too, via the store's channel);
    // a stale view holds words storage doesn't, so it is never replaced; nor while a handover flushes
    const following = () => readOnlyRef.current && !writerRef.current && !staleRef.current && !handingOverRef.current;
    const follow = async () => {
      timer = null;
      const loaded = await storage.loadDraft(draftId).catch(() => undefined);
      const view = viewRef.current;
      if (!following() || loaded === undefined || !view) return;
      if (loaded === null) return onDeleted(); // deleted in the tab that held it
      // what this tab shows isn't left behind the writing tab; the reader's caret and scroll stay put
      followText(view, loaded.text);
      setTitle(loaded.record.meta.title);
    };
    const schedule = () => {
      if (!following()) return;
      if (document.visibilityState === 'hidden') {
        behind = true;
        return;
      }
      // the writing tab commits every BATCH_MS while typing: coalesce
      timer ??= setTimeout(() => void follow(), FOLLOW_COALESCE_MS);
    };
    followRef.current = schedule;
    const onVisible = () => {
      if (document.visibilityState !== 'visible' || !behind) return;
      behind = false;
      schedule();
    };
    const onMsg = (e: MessageEvent<ChannelMessage>) => {
      const m = e.data;
      if (m?.type === 'committed' && m.draftId === draftId) schedule();
      // deleted in the tab that held it: move on (never while this tab's own words are at stake)
      else if (m?.type === 'deleted' && m.draftId === draftId && following()) onDeleted();
    };
    bc?.addEventListener('message', onMsg);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearTimeout(timer);
      followRef.current = () => {};
      bc?.removeEventListener('message', onMsg);
      document.removeEventListener('visibilitychange', onVisible);
      bc?.close();
    };
  }, [storage, draftId, onDeleted]);

  // the palette chunk loads at idle, so ⌘K opens at once (and still works after a deploy replaced it)
  useEffect(() => {
    const t = setTimeout(() => void loadPalette().catch(() => {}), 1500);
    return () => clearTimeout(t);
  }, []);

  // ---------- settings → editor ----------
  useEffect(() => {
    if (viewRef.current) setFocusMode(viewRef.current, settings.focus);
  }, [settings.focus]);
  useEffect(() => {
    if (viewRef.current) setTypewriter(viewRef.current, settings.typewriter);
  }, [settings.typewriter]);

  // ---------- chrome fade ----------
  const activity = useCallback(() => {
    lastActivity.current = Date.now();
    const hide = settingsRef.current.hideChrome;
    if (hide === 'never') return;
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    fadeTimer.current = setTimeout(() => setChromeVisible(false), hide * 1000);
  }, []);
  const reveal = useCallback(() => {
    if (fadeTimer.current) clearTimeout(fadeTimer.current);
    setChromeVisible(true);
  }, []);
  useEffect(() => {
    // reveal only on real pointer movement (scrolling under a still pointer also fires mousemove)
    let last: { x: number; y: number } | null = null;
    const onMove = (e: MouseEvent) => {
      if (last && (Math.abs(e.clientX - last.x) > 2 || Math.abs(e.clientY - last.y) > 2)) reveal();
      last = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchstart', reveal, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchstart', reveal);
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
    };
  }, [reveal]);

  // ---------- update notice ----------
  useEffect(() => {
    if (showUpdate || !updateReady || staleRef.current) return;
    // shown with the chrome; while the chrome is faded (writing), only once typing paused and saved
    if (chromeVisible) return setShowUpdate(true);
    let t: ReturnType<typeof setTimeout>;
    const check = () => {
      const idle = Date.now() - lastActivity.current;
      if (idle >= UPDATE_IDLE_MS && !writerRef.current?.dirty && !staleRef.current) setShowUpdate(true);
      else t = setTimeout(check, Math.max(UPDATE_IDLE_MS - idle, 500));
    };
    check();
    return () => clearTimeout(t);
  }, [showUpdate, updateReady, chromeVisible, notice]);

  // ---------- actions ----------
  const currentText = () => viewRef.current?.state.doc.toString() ?? '';
  const exportText = useCallback(
    async (ext: 'md' | 'txt') => {
      // the writing tab's view is the newest text, and so is a stale tab's (storage lacks its words);
      // a read-only tab exports what is saved, never the view it may still be catching up
      const saved = writerRef.current || staleRef.current ? null : await storage.loadDraft(draftId).catch(() => null);
      const text = saved?.text ?? currentText();
      const name = `${safeFileName(deriveMeta(text, 0).title)}.${ext}`;
      download(name, text, ext === 'md' ? 'text/markdown' : 'text/plain');
      return `Saved ${name}`;
    },
    [storage, draftId],
  );

  /** the draft with its whole history as a .kanso: a download on the web, a save panel on macOS */
  const saveKansoFile = useCallback(
    () => exportKanso(storage, draftId, writerRef.current, desktop ? (name, bytes) => desktop.saveKanso(name, bytes) : downloadKanso),
    [storage, draftId, desktop],
  );
  const exportKansoRef = useRef(saveKansoFile);
  exportKansoRef.current = saveKansoFile;

  const toggleTheme = useCallback(() => {
    update({ theme: resolveTheme(settingsRef.current.theme) === 'night' ? 'paper' : 'night' });
  }, [update]);

  /** Send as letter (3A): save the word being typed first, so the letter ends where the page does */
  const openSend = useCallback(async (from: 'button' | 'text') => {
    sendOpenerRef.current = document.activeElement as HTMLElement | null;
    setPalette(false);
    setSidebar(false);
    preloadSend();
    try {
      await writerRef.current?.flush(true);
    } catch {
      // a failed save keeps its notice; the letter carries what storage has (and says so)
    }
    // anything opened while the flush ran gives way to the send panel
    setPalette(false);
    setSidebar(false);
    sendRefocusRef.current = from === 'text';
    setSend({ unsaved: staleRef.current || !!writerRef.current?.dirty });
  }, []);
  const closeSend = useCallback(() => {
    const refocus = sendRefocusRef.current;
    const opener = sendOpenerRef.current;
    sendRefocusRef.current = false;
    sendOpenerRef.current = null;
    setSend(null);
    // Send opened from the text goes back to the text; otherwise to the opener (the panel's
    // useDialog does that too, unless the loading frame stood in for it first)
    requestAnimationFrame(() => {
      if (refocus) viewRef.current?.focus();
      else if (opener && document.contains(opener) && document.activeElement !== opener) opener.focus();
    });
  }, []);

  const actions: PaletteActions = useMemo(
    () => ({
      sendLetter: () => void openSend('text'),
      newDraft: () => {
        setPalette(false);
        void leaveRef.current(() => onNew());
      },
      openDrafts: () => {
        setPalette(false);
        setSidebar(true);
      },
      rename: (t: string) => {
        const view = viewRef.current;
        if (!view || !writerRef.current) return 'Open this draft here first to rename it';
        view.dispatch({ changes: renameChange(view.state.doc.toString(), t), userEvent: 'input' });
        return null;
      },
      exportMarkdown: () => exportText('md'),
      exportText: () => exportText('txt'),
      exportAll: () => exportAll(storage, (at) => update({ lastExportedAt: at }), writerRef.current),
      importBackup: async () => {
        const r = await importBackup(storage);
        if (r?.added) {
          void refreshDrafts();
          void requestPersistence();
          broadcast({ type: 'library' }); // other tabs reread their draft lists
        }
        // a .kanso opens its draft (the one already here, or the one just added)
        const open = r?.openId;
        if (open && open !== draftId) {
          setPalette(false);
          void leaveRef.current(() => onOpen(open));
        }
        return r?.label ?? null;
      },
      exportKanso: saveKansoFile,
      saveToFile: desktop ? () => desktop.saveToFile(draftId) : undefined,
      makeDefault: desktop ? () => desktop.makeDefault() : undefined,
      clearHistory: async () => {
        // a storage error (IndexedDB down) answers in the row instead of leaving "Clearing…"
        const ok = await (sessionRef.current?.clearHistory() ?? Promise.resolve(false)).catch(() => null);
        if (ok === null) return 'Couldn’t clear history. Try again';
        return ok ? 'History cleared' : 'Couldn’t clear history in this tab';
      },
      deleteDraft: async () => {
        const s = sessionRef.current;
        const view = viewRef.current;
        // only the tab holding the draft may delete it (another tab would keep writing into it)
        if (!s || !writerRef.current || !view) return 'Open this draft here first to delete it';
        setReadOnly(view, true);
        sessionRef.current = null;
        writerRef.current = null;
        readOnlyRef.current = false; // never follow (or "find deleted") our own delete
        try {
          await s.dispose();
          await storage.deleteDraft(draftId);
        } catch {
          setMountKey((k) => k + 1); // reopen and keep writing; nothing was lost
          return 'Couldn’t delete. Try again';
        }
        broadcast({ type: 'deleted', draftId }); // a tab showing it read-only moves on
        void desktop?.draftDeleted(draftId).catch(() => {});
        setPalette(false);
        onDeleted();
        return null;
      },
      resetToday: async () => {
        const now = Date.now();
        try {
          await storage.resetDay(dayKey(now, new Date(now).getTimezoneOffset()));
        } catch {
          return 'Couldn’t reset. Try again';
        }
        await refreshToday().catch(() => {});
        broadcast({ type: 'library' }); // other tabs reread words today
        return 'Reset';
      },
    }),
    [
      openSend,
      onNew,
      onOpen,
      exportText,
      saveKansoFile,
      desktop,
      storage,
      update,
      refreshDrafts,
      draftId,
      onDeleted,
      refreshToday,
      broadcast,
    ],
  );

  // ---------- leaving with unsaved text ----------
  /** Try to save before switching drafts; if it can't, stay and offer the copy escape. */
  const pendingLeave = useRef<(() => void) | null>(null);
  const leave: LeaveGuard = useCallback(async (go: () => void) => {
    const w = writerRef.current;
    if (w?.dirty) await w.flush(true);
    if (w?.dirty || staleRef.current) {
      // the editor still shows the words; Copy keeps them, Leave anyway goes (never a trap)
      pendingLeave.current = go;
      setChromeVisible(true);
      setNotice({ kind: 'unsaved-leave' });
      return false;
    }
    go();
    return true;
  }, []);
  leaveRef.current = leave;
  useEffect(() => {
    onGuard?.((go) => leaveRef.current(go));
    return () => onGuard?.(null);
  }, [onGuard]);
  // the root ErrorBoundary reads this before the editor unmounts, so it never claims these words are saved
  useEffect(
    () =>
      setUnsavedProvider(() => {
        if (staleTextRef.current !== null) return staleTextRef.current;
        const dirty = writerRef.current?.dirty || staleRef.current;
        return dirty ? (viewRef.current?.state.doc.toString() ?? null) : null;
      }),
    [],
  );
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (writerRef.current?.dirty || staleRef.current) {
        e.preventDefault();
        e.returnValue = ''; // older Chromium / Safari only prompt with this set
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /**
   * "Keep the readable text": rebase the draft on the text read when the damage was found. The
   * head + epoch from then make storage refuse if the draft changed since, and the draft's lock
   * (when Web Locks exist) keeps a tab that holds it from being rewritten underneath.
   */
  const repairDamaged = async (d: { text: string; head: number; epoch: string }) => {
    // fresh meta: the record's word count was kept for the text before the damage, not this one
    const rebase = async () => (await storage.clearHistory(draftId, d.text, Date.now(), d.head, d.epoch, deriveMeta(d.text))).ok;
    const locks = typeof navigator !== 'undefined' ? (navigator.locks as LockManager | undefined) : undefined;
    let repaired: boolean;
    try {
      // no lock (another tab owns the draft) or a refused check (it changed since): nothing is
      // written; the remount below shows what storage holds (read-only, or damaged with a fresh head)
      repaired = locks
        ? await locks.request(`draft:${draftId}`, { ifAvailable: true }, async (lock) => !!lock && (await rebase()))
        : await rebase();
    } catch {
      return setNotice({ kind: 'open-error' });
    }
    if (repaired) broadcast({ type: 'library' }); // other tabs reread the draft's row (title, words)
    setNotice(null);
    setMountKey((k) => k + 1);
  };

  const copyUnsaved = async () => {
    // a stale tab copies exactly the text it handed back
    const text = staleTextRef.current ?? currentText();
    try {
      await navigator.clipboard.writeText(text);
      setCopyLabel('Copied');
    } catch {
      // clipboard blocked: select the text so ⌘C / Ctrl C (or the phone's Copy) works
      const view = viewRef.current;
      if (view) {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        view.focus();
      }
      setCopyLabel(`Selected. Press ${isMac() ? '⌘C' : 'Ctrl C'} to copy`);
    }
    setTimeout(() => setCopyLabel(null), 4000);
  };
  const copyButton = (
    <button type="button" className="text-btn" onClick={() => void copyUnsaved()}>
      {copyLabel ?? 'Copy unsaved text'}
    </button>
  );

  // ---------- formatting toolbar ----------
  const runFormat = useCallback((id: FormatId, mode?: 'set') => {
    const view = viewRef.current;
    if (!view || view.state.readOnly) return;
    // the style menu sets a paragraph style; buttons toggle like their shortcuts
    if (mode === 'set' && (id === 'title' || id === 'heading' || id === 'subheading' || id === 'normal')) setParagraphCommand(id)(view);
    else SHORTCUTS[id].run(view);
    // the text again (a keyboard press from the toolbar, or a click while the text wasn't focused)
    if (!view.hasFocus) view.focus();
  }, []);
  const focusText = useCallback(() => viewRef.current?.focus(), []);
  // the dock shows while the text (or the dock itself) has focus
  useEffect(() => {
    if (!docked) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      t = null;
      const a = document.activeElement;
      const view = viewRef.current;
      setTextFocused(!!a && ((!!view && view.contentDOM.contains(a)) || !!dockRef.current?.contains(a)));
    };
    // focusout fires before the next element has focus: look once it has settled
    const later = () => (t ??= setTimeout(check, 0));
    document.addEventListener('focusin', check);
    document.addEventListener('focusout', later);
    check();
    return () => {
      if (t) clearTimeout(t);
      document.removeEventListener('focusin', check);
      document.removeEventListener('focusout', later);
    };
  }, [docked, mountKey]);
  const showDock = docked && textFocused && !palette && !sidebar && !send;
  // keep the dock on the visual viewport's bottom edge: above the keyboard when it is open, else above a notice
  useLayoutEffect(() => {
    const el = dockRef.current;
    if (!showDock || !el) return;
    const vv = window.visualViewport;
    const place = () => {
      const keyboard = vv ? Math.max(0, window.innerHeight - (vv.offsetTop + vv.height)) : 0;
      const notice = keyboard < 1 ? (document.querySelector<HTMLElement>('.footer .notice')?.offsetHeight ?? 0) : 0;
      // bottom, not a transform: a transformed dock would become the style menu's containing block
      el.style.bottom = `${Math.round(keyboard + notice)}px`;
      el.classList.toggle('over-keyboard', keyboard >= 1);
    };
    place();
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    window.addEventListener('resize', place);
    return () => {
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
      window.removeEventListener('resize', place);
    };
  }, [showDock, notice, fileNote, showUpdate, chunkFailed]);

  // ---------- shortcuts ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      if (send) {
        // the send panel is modal: only its own shortcut (and Esc, which useDialog takes) apply
        if (mod && e.shiftKey && k === 'l') {
          e.preventDefault();
          closeSend();
        }
        return;
      }
      if (mod && !e.shiftKey && k === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (mod && e.shiftKey && k === 'l') {
        e.preventDefault();
        void openSend('text');
      } else if (mod && e.shiftKey && k === 'n') {
        e.preventDefault();
        toggleTheme();
      } else if (mod && k === 'e') {
        e.preventDefault();
        void exportText(e.shiftKey ? 'txt' : 'md');
      } else if (mod && e.shiftKey && k === 't') {
        e.preventDefault();
        update({ typewriter: !settingsRef.current.typewriter });
      } else if (mod && e.shiftKey && k === 'p') {
        e.preventDefault();
        update({ focus: settingsRef.current.focus === 'paragraph' ? 'off' : 'paragraph' });
      } else if (mod && e.shiftKey && k === 's') {
        e.preventDefault();
        update({ focus: settingsRef.current.focus === 'sentence' ? 'off' : 'sentence' });
      } else if (e.key === 'Escape') {
        if (!palette && !sidebar && !send) reveal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, sidebar, send, reveal, toggleTheme, exportText, update, openSend, closeSend]);

  // ---------- render ----------
  const goal = settings.goal;
  const reached = today >= goal;
  const pct = Math.min(100, (today / Math.max(1, goal)) * 100);
  const face = TYPEFACES[settings.typeface];
  const shellStyle = {
    '--writing-size': `${settings.textSize}px`,
    '--measure': `${settings.lineWidth}px`,
    '--writing-family': face.family,
    '--writing-line': String(face.line),
  } as CSSProperties;
  const night = resolveTheme(settings.theme) === 'night';
  // header tooltips name each button and its shortcut (DESIGN.md: Tooltip)
  const modLabel = isMac() ? '⌘' : 'Ctrl ';
  const modKey = isMac() ? 'Meta' : 'Control';
  const chromeClass = `chrome${chromeVisible || palette || sidebar || send ? '' : ' hidden'}`;
  const closeOverlay = () => {
    setPalette(false);
    setSidebar(false);
    viewRef.current?.focus();
  };

  return (
    <div className="shell" style={shellStyle}>
      {/* macOS: the header is the window's title bar (drag it; double-click zooms; buttons stay buttons) */}
      <header className={`header ui ${chromeClass}`} onFocus={reveal} data-tauri-drag-region={desktop ? 'deep' : undefined}>
        <div className="left">
          <button type="button" className="icon-btn" aria-label="Open drafts" data-tip="Drafts" onClick={() => setSidebar(true)}>
            <MenuIcon />
          </button>
          {linkedPath ? (
            // a draft linked to a Markdown file shows where it lives on hover, nothing more
            <span className="title-wrap" data-tip={displayPath(linkedPath)}>
              <span className="title">{title || 'Untitled'}</span>
            </span>
          ) : (
            <span className="title">{title || 'Untitled'}</span>
          )}
        </div>
        {!docked && <FormatToolbar variant="bar" formats={formats} disabled={!canFormat} run={runFormat} focusText={focusText} />}
        <div className="right">
          <button
            type="button"
            className="icon-btn hide-phone"
            aria-label={settings.focus === 'off' ? 'Turn on focus mode' : 'Turn off focus mode'}
            aria-keyshortcuts={`${modKey}+Shift+P`}
            data-tip={`Focus mode: ${settings.focus === 'off' ? 'off' : 'on'} ${modLabel}⇧P`}
            aria-pressed={settings.focus !== 'off'}
            onClick={() => update({ focus: settings.focus === 'off' ? 'paragraph' : 'off' })}
          >
            <FocusIcon />
          </button>
          <button
            type="button"
            className="icon-btn hide-phone"
            aria-label={night ? 'Switch to paper theme' : 'Switch to night theme'}
            aria-keyshortcuts={`${modKey}+Shift+N`}
            data-tip={`${night ? 'Paper' : 'Night'} theme ${modLabel}⇧N`}
            onClick={toggleTheme}
          >
            {night ? <SunIcon /> : <MoonIcon />}
          </button>
          <button
            type="button"
            className="icon-btn hide-phone"
            aria-label="Send as letter"
            aria-keyshortcuts={`${modKey}+Shift+L`}
            data-tip={`Send as letter ${modLabel}⇧L`}
            onPointerEnter={preloadSend}
            onFocus={preloadSend}
            onClick={() => void openSend('button')}
          >
            <EnvelopeIcon />
          </button>
          <button
            type="button"
            className="icon-btn palette-btn hide-phone"
            aria-label={`Open command palette ${isMac() ? '⌘K' : 'Ctrl K'}`}
            aria-keyshortcuts={`${modKey}+K`}
            data-tip={`Command palette ${modLabel}K`}
            onClick={() => setPalette(true)}
          >
            <SearchIcon />
            <span className="key">{isMac() ? '⌘K' : 'Ctrl K'}</span>
          </button>
          <button type="button" className="icon-btn more" aria-label="Open commands" data-tip="Commands" onClick={() => setPalette(true)}>
            <MoreIcon />
          </button>
        </div>
      </header>

      <main className="page">
        <h1 className="sr-only">{title || 'Untitled'}</h1>
        <div ref={hostRef} style={{ width: '100%', maxWidth: 'var(--measure)' }} />
      </main>

      <footer className="footer ui">
        <div className={`count ${chromeClass}`}>
          <span>{reached ? `${today} words today · goal reached` : `${today} of ${goal} words`}</span>
        </div>
        {settings.showProgress && (
          <div className="progress" aria-hidden="true">
            <div style={{ width: `${pct}%` }} />
          </div>
        )}
        {!notice && fileNote && (
          // macOS, the linked file: below every saving notice, above the update notice
          <div className="notice" role="status">
            {fileNote.kind === 'file-conflict' && (
              <>
                <span>This file changed outside Kansowriter.</span>
                <span className="actions">
                  <button type="button" className="text-btn" onClick={() => linkRef.current?.useFile()}>
                    Use the file’s version
                  </button>
                  <button type="button" className="text-btn" onClick={() => linkRef.current?.keepMine()}>
                    Keep mine
                  </button>
                </span>
              </>
            )}
            {(fileNote.kind === 'file-missing' || fileNote.kind === 'file-unwritable') && (
              <>
                <span>
                  {fileNote.kind === 'file-missing'
                    ? 'The linked file was moved or deleted. Your draft is safe here.'
                    : 'Couldn’t save to the linked file. Your draft is safe here.'}
                </span>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() =>
                    void desktop?.saveToFile(draftId).then((label) => {
                      if (label?.startsWith('Couldn')) setFileNote({ kind: 'file-unwritable' });
                    })
                  }
                >
                  Save to file…
                </button>
              </>
            )}
          </div>
        )}
        {!notice && !fileNote && showUpdate && !staleRef.current && (
          // lowest priority (R11): a new version waits; only this click reloads. Once shown it stays
          // (no flicker while typing): leave() still keeps unsaved words from being reloaded away
          <div className="notice" role="status">
            <span>Update ready</span>
            <button type="button" className="text-btn" onClick={() => void leave(applyUpdate)}>
              Reload
            </button>
          </div>
        )}
        {!notice && !fileNote && !(showUpdate && !staleRef.current) && chunkFailed && (
          // lowest priority: below the update notice, whose Reload brings the new chunks too
          <div className="notice" role="status">
            <span>Couldn’t open {chunkFailed}. Reload to update</span>
            <button type="button" className="text-btn" onClick={() => void leave(() => location.reload())}>
              Reload
            </button>
          </div>
        )}
        {notice && (
          <div className="notice" role={notice.kind === 'stale' || notice.kind === 'readonly' ? 'alert' : 'status'}>
            {notice.kind === 'stale' && (
              <>
                <span>This tab stopped saving.</span>
                {copyButton}
              </>
            )}
            {notice.kind === 'unsaved-leave' && (
              <>
                <span>Your newest words aren’t saved.</span>
                {copyButton}
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    const go = pendingLeave.current;
                    pendingLeave.current = null;
                    setNotice(null);
                    go?.();
                  }}
                >
                  Leave anyway
                </button>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    pendingLeave.current = null;
                    // back to the notice that was there: still stale, or just retrying saves
                    setNotice(staleRef.current ? { kind: 'stale' } : null);
                  }}
                >
                  Stay
                </button>
              </>
            )}
            {notice.kind === 'readonly' && (
              <>
                <span>Open in another tab.</span>
                <button type="button" className="text-btn" onClick={() => void sessionRef.current?.takeOver()}>
                  Open here instead
                </button>
              </>
            )}
            {notice.kind === 'saving-error' && (
              <>
                <span>Couldn’t save just now. Retrying…</span>
                {copyButton}
              </>
            )}
            {notice.kind === 'damaged' && (
              <>
                <span>Part of this draft’s history is damaged.</span>
                <button type="button" className="text-btn" onClick={() => void repairDamaged(notice)}>
                  Keep the readable text
                </button>
              </>
            )}
            {notice.kind === 'open-error' && (
              <>
                <span>Couldn’t open saved drafts.</span>
                <button
                  type="button"
                  className="text-btn"
                  onClick={() => {
                    setNotice(null);
                    setMountKey((k) => k + 1);
                  }}
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}
      </footer>

      {showDock && (
        <div className="format-dock ui" ref={dockRef} role="region" aria-label="Formatting">
          <FormatToolbar variant="dock" formats={formats} disabled={!canFormat} run={runFormat} focusText={focusText} />
        </div>
      )}
      {sidebar && (
        <LibrarySidebar
          currentId={draftId}
          onClose={closeOverlay}
          onOpen={(id) => {
            setSidebar(false);
            if (id !== draftId) void leave(() => onOpen(id));
          }}
          onNew={(t) => {
            setSidebar(false);
            void leave(() => onNew(t));
          }}
          onExportAll={actions.exportAll}
        />
      )}
      {send && (
        <PaletteBoundary
          onError={() => {
            closeSend();
            setChunkFailed('Send as letter');
          }}
        >
          <Suspense fallback={<SendLoading onClose={closeSend} />}>
            <SendPanel draftId={draftId} title={title} unsaved={send.unsaved} onClose={closeSend} />
          </Suspense>
        </PaletteBoundary>
      )}
      {palette && (
        <PaletteBoundary
          onError={() => {
            closeOverlay();
            setChunkFailed('commands');
          }}
        >
          <Suspense fallback={null}>
            <CommandPalette onClose={closeOverlay} actions={actions} title={title} wordsToday={today} />
          </Suspense>
        </PaletteBoundary>
      )}
    </div>
  );
}
