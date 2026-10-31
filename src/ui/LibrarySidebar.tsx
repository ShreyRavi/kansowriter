import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from './store';
import { daysSince, isSafariNotInstalled, when } from './platform';
import { CloseIcon, FileIcon, PlusIcon, SearchIcon } from './icons';
import { getDesktop } from './desktopBridge';
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

  // search covers title and body: load bodies lazily (in parallel, kept lowercased), only once someone searches
  useEffect(() => {
    if (!q || bodies.size) return;
    let alive = true;
    void (async () => {
      const texts = await Promise.all(drafts.map(async (d) => ((await storage.loadDraft(d.id))?.text ?? '').toLowerCase()));
      if (alive) setBodies(new Map(drafts.map((d, i) => [d.id, texts[i]!])));
    })();
    return () => {
      alive = false;
    };
  }, [q, bodies.size, drafts, storage]);

  // macOS: drafts linked to a Markdown file get a small file glyph (none on the web)
  const [linked, setLinked] = useState<Set<string>>(new Set());
  useEffect(() => {
    const desktop = getDesktop();
    if (!desktop) return;
    const read = () => setLinked(new Set(drafts.filter((d) => desktop.linkedPath(d.id)).map((d) => d.id)));
    read();
    return desktop.subscribe(read);
  }, [drafts]);

  const needle = q.trim().toLowerCase();
  const list = useMemo(
    () =>
      needle
        ? drafts.filter(
            (d) => d.meta.title.toLowerCase().includes(needle) || (bodies.get(d.id) ?? d.meta.excerpt.toLowerCase()).includes(needle),
          )
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
            <button
              type="button"
              className="icon-btn"
              aria-label="New draft"
              data-tip="New draft"
              data-tip-align="end"
              onClick={() => onNew()}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="Close drafts"
              data-tip="Close Esc"
              data-tip-align="end"
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
        <div className="search">
          <label htmlFor="draft-search" className="sr-only">
            Search drafts
          </label>
          <SearchIcon />
          <input
            ref={searchRef}
            id="draft-search"
            type="search"
            placeholder="Search drafts"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
          />
          {q && (
            <button
              type="button"
              className="icon-btn clear"
              aria-label="Clear search"
              data-tip="Clear search"
              data-tip-align="end"
              onClick={() => setQ('')}
            >
              <CloseIcon />
            </button>
          )}
        </div>
        <nav aria-label="Draft list">
          {list.map((d) => (
            <button key={d.id} type="button" className="draft-row" aria-current={d.id === currentId} onClick={() => onOpen(d.id)}>
              <span className="row1">
                <span className="t">
                  {linked.has(d.id) && (
                    <span className="linked" role="img" aria-label="Linked to a file">
                      <FileIcon />
                    </span>
                  )}
                  {highlight(d.meta.title)}
                </span>
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
