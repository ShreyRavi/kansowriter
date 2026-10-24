import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { EditorView } from '@codemirror/view';
import { createEditor, loadText, setFocusMode, setReadOnly, setTypewriter } from '../editor/setup';
import { attachDraftSession, type SessionHandle } from '../storage/lifecycle';
import { DamagedDraftError, openDraftWriter, type DraftWriter } from '../storage/writer';
import { deriveMeta, renameChange } from '../core/draft';
import { dayKey } from '../core/words';
import { useStore } from './store';
import { TYPEFACES, resolveTheme } from './settings';
import { CommandPalette, type PaletteActions } from './CommandPalette';
import { LibrarySidebar } from './LibrarySidebar';
import { download, isMac, safeFileName } from './platform';
import { exportAll, importBackup } from './backupActions';
import { FocusIcon, MenuIcon, MoonIcon, MoreIcon, SearchIcon, SunIcon } from './icons';

type NoticeState =
  | { kind: 'stale'; text: string }
  | { kind: 'readonly' }
  | { kind: 'saving-error' }
  | { kind: 'unsaved-leave' }
  | { kind: 'damaged'; text: string }
  | { kind: 'open-error' }
  | null;

interface Props {
  draftId: string;
  onOpen(id: string): void;
  onNew(title?: string): void;
  onDeleted(): void;
}

export function EditorShell({ draftId, onOpen, onNew, onDeleted }: Props) {
  const store = useStore();
  const { storage, settings, update, today, refreshToday, refreshDrafts, broadcast } = store;
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const writerRef = useRef<DraftWriter | null>(null);
  const sessionRef = useRef<SessionHandle | null>(null);
  const [title, setTitle] = useState('');
  const [notice, setNotice] = useState<NoticeState>(null);
  const [copyLabel, setCopyLabel] = useState<string | null>(null);
  const [chromeVisible, setChromeVisible] = useState(true);
  const [sidebar, setSidebar] = useState(false);
  const [palette, setPalette] = useState(false);
  const [mountKey, setMountKey] = useState(0);
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveRef = useRef<(go: () => void) => Promise<void>>(async (go) => go());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // ---------- editor + single-writer session ----------
  useEffect(() => {
    let disposed = false;
    const host = hostRef.current!;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      const loaded = await storage.loadDraft(draftId).catch(() => undefined);
      if (disposed) return;
      if (loaded === undefined) return setNotice({ kind: 'open-error' });
      if (disposed) return;
      if (!loaded) return onDeleted();
      setTitle(loaded.record.meta.title);
      const view = createEditor(host, {
        doc: loaded.text,
        readOnly: true,
        focus: settingsRef.current.focus,
        typewriter: settingsRef.current.typewriter,
        onChange: (c) => writerRef.current?.push(c),
        onActivity: () => activity(),
      });
      viewRef.current = view;

      const events = {
        onStale: (text: string) => {
          writerRef.current = null;
          setReadOnly(view, true);
          setChromeVisible(true);
          setNotice({ kind: 'stale', text });
        },
        onCommit: (rec: { meta: { title: string } }) => {
          setTitle(rec.meta.title);
          broadcast({ type: 'committed', draftId });
          if (commitTimer) return;
          commitTimer = setTimeout(() => {
            commitTimer = null;
            void refreshToday();
            void refreshDrafts();
          }, 250);
        },
        onError: (e: unknown | null) => setNotice((n) => (e ? (n?.kind === 'stale' ? n : { kind: 'saving-error' }) : n?.kind === 'saving-error' ? null : n)),
      };

      sessionRef.current = attachDraftSession(
        draftId,
        () => openDraftWriter(storage, draftId, events),
        {
          onWritable: (w) => {
            loadText(view, w.currentText);
            if (view.state.doc.length !== w.currentText.length) {
              // the editor normalized the text (e.g. \r line breaks): recording would desync from the log
              sessionRef.current?.dispose();
              setNotice({ kind: 'open-error' });
              return;
            }
            writerRef.current = w;
            setReadOnly(view, false);
            setNotice((n) => (n?.kind === 'readonly' ? null : n));
            view.focus();
          },
          onReadOnly: (reason, error) => {
            writerRef.current = null;
            setReadOnly(view, true);
            setChromeVisible(true);
            if (reason === 'error') {
              setNotice(error instanceof DamagedDraftError ? { kind: 'damaged', text: error.text } : { kind: 'open-error' });
            } else setNotice((n) => (n?.kind === 'stale' ? n : { kind: 'readonly' }));
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
      const s = sessionRef.current;
      sessionRef.current = null;
      writerRef.current = null;
      void s?.dispose().then(() => {
        void refreshDrafts();
        void refreshToday();
      });
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, mountKey]);

  // ---------- settings → editor ----------
  useEffect(() => {
    if (viewRef.current) setFocusMode(viewRef.current, settings.focus);
  }, [settings.focus]);
  useEffect(() => {
    if (viewRef.current) setTypewriter(viewRef.current, settings.typewriter);
  }, [settings.typewriter]);

  // ---------- chrome fade ----------
  const activity = useCallback(() => {
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

  // ---------- actions ----------
  const currentText = () => viewRef.current?.state.doc.toString() ?? '';
  const exportText = useCallback((ext: 'md' | 'txt') => {
    const text = currentText();
    download(`${safeFileName(deriveMeta(text, 0).title)}.${ext}`, text, ext === 'md' ? 'text/markdown' : 'text/plain');
    return `Saved ${safeFileName(deriveMeta(text, 0).title)}.${ext}`;
  }, []);

  const toggleTheme = useCallback(() => {
    update({ theme: resolveTheme(settingsRef.current.theme) === 'night' ? 'paper' : 'night' });
  }, [update]);

  const actions: PaletteActions = useMemo(
    () => ({
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
        if (!view || !writerRef.current) return;
        view.dispatch({ changes: renameChange(view.state.doc.toString(), t), userEvent: 'input' });
      },
      exportMarkdown: () => exportText('md'),
      exportText: () => exportText('txt'),
      exportAll: () => exportAll(storage, (at) => update({ lastExportedAt: at }), writerRef.current),
      importBackup: async () => {
        const r = await importBackup(storage);
        if (r?.added) void refreshDrafts();
        return r?.label ?? null;
      },
      clearHistory: async () => {
        const ok = (await sessionRef.current?.clearHistory()) ?? false;
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
        try {
          await s.dispose();
          await storage.deleteDraft(draftId);
        } catch {
          setMountKey((k) => k + 1); // reopen and keep writing; nothing was lost
          return 'Couldn’t delete. Try again';
        }
        setPalette(false);
        onDeleted();
        return null;
      },
      resetToday: async () => {
        const now = Date.now();
        await storage.resetDay(dayKey(now, new Date(now).getTimezoneOffset()));
        await refreshToday();
        broadcast({ type: 'committed', draftId });
      },
      toggleTheme,
    }),
    [onNew, exportText, storage, update, refreshDrafts, draftId, onDeleted, refreshToday, broadcast, toggleTheme],
  );

  // ---------- leaving with unsaved text ----------
  /** Try to save before switching drafts; if it can't, stay and offer the copy escape. */
  const leave = useCallback(
    async (go: () => void) => {
      const w = writerRef.current;
      if (w?.dirty) await w.flush(true);
      if (w?.dirty || notice?.kind === 'stale') {
        setChromeVisible(true);
        setNotice((n) => (n?.kind === 'stale' ? n : { kind: 'unsaved-leave' }));
        return;
      }
      go();
    },
    [notice],
  );
  leaveRef.current = leave;
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (writerRef.current?.dirty || notice?.kind === 'stale') e.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [notice]);

  const copyUnsaved = async () => {
    const text = currentText();
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

  // ---------- shortcuts ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && !e.shiftKey && k === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      } else if (mod && e.shiftKey && k === 'n') {
        e.preventDefault();
        toggleTheme();
      } else if (mod && k === 'e') {
        e.preventDefault();
        exportText(e.shiftKey ? 'txt' : 'md');
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
        if (!palette && !sidebar) reveal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, sidebar, reveal, toggleTheme, exportText, update]);

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
  const chromeClass = `chrome${chromeVisible || palette || sidebar ? '' : ' hidden'}`;
  const closeOverlay = () => {
    setPalette(false);
    setSidebar(false);
    viewRef.current?.focus();
  };

  return (
    <div className="shell" style={shellStyle}>
      <header className={`header ui ${chromeClass}`} onFocus={reveal}>
        <div className="left">
          <button type="button" className="icon-btn" aria-label="Open drafts" onClick={() => setSidebar(true)}>
            <MenuIcon />
          </button>
          <span className="title">{title || 'Untitled'}</span>
        </div>
        <div className="right">
          <button
            type="button"
            className="icon-btn hide-phone"
            aria-label={settings.focus === 'off' ? 'Turn on focus mode' : 'Turn off focus mode'}
            aria-pressed={settings.focus !== 'off'}
            onClick={() => update({ focus: settings.focus === 'off' ? 'paragraph' : 'off' })}
          >
            <FocusIcon />
          </button>
          <button type="button" className="icon-btn hide-phone" aria-label={night ? 'Switch to paper theme' : 'Switch to night theme'} onClick={toggleTheme}>
            {night ? <SunIcon /> : <MoonIcon />}
          </button>
          <button type="button" className="icon-btn palette-btn hide-phone" aria-label={`Open command palette ${isMac() ? '⌘K' : 'Ctrl K'}`} onClick={() => setPalette(true)}>
            <SearchIcon />
            <span className="key">{isMac() ? '⌘K' : 'Ctrl K'}</span>
          </button>
          <button type="button" className="icon-btn more" aria-label="Open commands" onClick={() => setPalette(true)}>
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
                <span>Couldn’t save your newest words.</span>
                {copyButton}
                <button type="button" className="text-btn" onClick={() => setNotice(null)}>
                  Keep writing
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
                <button
                  type="button"
                  className="text-btn"
                  onClick={async () => {
                    try {
                      const loaded = await storage.loadDraft(draftId);
                      if (loaded) await storage.clearHistory(draftId, notice.text, Date.now(), loaded.record.head, loaded.record.epoch);
                    } catch {
                      return setNotice({ kind: 'open-error' });
                    }
                    setNotice(null);
                    setMountKey((k) => k + 1);
                  }}
                >
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
      {palette && <CommandPalette onClose={closeOverlay} actions={actions} title={title} wordsToday={today} />}
    </div>
  );
}
