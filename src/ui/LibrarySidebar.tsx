import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { daysSince, isSafariNotInstalled, when } from './platform';
import { CloseIcon, PlusIcon, SearchIcon } from './icons';
import { useDialog } from './useDialog';

interface Props {
  currentId: string;
  onClose(): void;
  onOpen(id: string): void;
  onNew(title?: string): void;
  onExportAll(): Promise<string>;
}

/** Drafts sidebar (artboard + 5A no-results, 14A search field, R10 Safari hint and export age). */
export function LibrarySidebar({ currentId, onClose, onOpen, onNew, onExportAll }: Props) {
  const { drafts, settings, update, storage } = useStore();
  const [q, setQ] = useState('');
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [feedback, setFeedback] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useDialog(ref, onClose, searchRef);

  // search covers title and body: load bodies lazily, only once someone searches
  useEffect(() => {
    if (!q || bodies.size) return;
    let alive = true;
    void (async () => {
      const m = new Map<string, string>();
      for (const d of drafts) m.set(d.id, (await storage.loadDraft(d.id))?.text ?? '');
      if (alive) setBodies(m);
    })();
    return () => {
      alive = false;
    };
  }, [q, bodies.size, drafts, storage]);

  const needle = q.trim().toLowerCase();
  const list = useMemo(
    () =>
      needle
        ? drafts.filter((d) => d.meta.title.toLowerCase().includes(needle) || (bodies.get(d.id) ?? d.meta.excerpt).toLowerCase().includes(needle))
        : drafts,
    [drafts, needle, bodies],
  );

  const exportAge = daysSince(settings.lastExportedAt);
  const showHint = !settings.safariHintDismissed && isSafariNotInstalled();

  const highlight = (title: string) => {
    if (!needle) return title;
    const i = title.toLowerCase().indexOf(needle);
    if (i < 0) return title;
    return (
      <>
        {title.slice(0, i)}
        <mark>{title.slice(i, i + needle.length)}</mark>
        {title.slice(i + needle.length)}
      </>
    );
  };

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={ref} className="sidebar" aria-label="Drafts" role="dialog" aria-modal="true">
        <div className="top">
          <span>Drafts</span>
          <div style={{ display: 'flex', gap: 2 }}>
            <button type="button" className="icon-btn" aria-label="New draft" onClick={() => onNew()}>
              <PlusIcon />
            </button>
            <button type="button" className="icon-btn" aria-label="Close drafts" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="search">
          <label htmlFor="draft-search" className="sr-only">
            Search drafts
          </label>
          <SearchIcon />
          <input ref={searchRef} id="draft-search" type="search" placeholder="Search drafts" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
          {q && (
            <button type="button" className="icon-btn clear" aria-label="Clear search" onClick={() => setQ('')}>
              <CloseIcon />
            </button>
          )}
        </div>
        <nav aria-label="Draft list">
          {list.map((d) => (
            <button key={d.id} type="button" className="draft-row" aria-current={d.id === currentId} onClick={() => onOpen(d.id)}>
              <span className="row1">
                <span className="t">{highlight(d.meta.title)}</span>
                <span className="when">{when(d.updatedAt)}</span>
              </span>
              {d.meta.excerpt && <span className="ex">{d.meta.excerpt}</span>}
              <span className="words">{d.meta.words} words</span>
            </button>
          ))}
          {needle && list.length === 0 && (
            <div className="empty" role="status">
              <span>No drafts match “{q.trim()}”</span>
              <button type="button" className="text-btn" onClick={() => setQ('')}>
                Clear search
              </button>
              <button type="button" className="text-btn" onClick={() => onNew(q.trim())}>
                New draft titled “{q.trim()}”
              </button>
            </div>
          )}
        </nav>
        <div className="bottom">
          {showHint && (
            <div className="line">
              <span>Add to Home Screen to keep drafts safe</span>
              <button type="button" className="text-btn" onClick={() => update({ safariHintDismissed: true })}>
                Dismiss
              </button>
            </div>
          )}
          <div className="line">
            <span>Stored on this device</span>
            <span>
              {exportAge !== null && exportAge >= 7 && <span>last exported {exportAge} days ago · </span>}
              <button
                type="button"
                className="text-btn"
                onClick={async () => {
                  setFeedback('Saving…');
                  setFeedback(await onExportAll());
                  setTimeout(() => setFeedback(null), 2000);
                }}
              >
                {feedback ?? 'Export all'}
              </button>
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
