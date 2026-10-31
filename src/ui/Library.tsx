import { useCallback, useEffect, useRef, useState } from 'react';
import { deriveMeta, newDraft, type DraftRecord } from '../core/draft';
import { countWords, dayKey } from '../core/words';
import { StoreProvider, useStore } from './store';
import { Landing } from './Landing';
import { EditorShell, type LeaveGuard } from './EditorShell';
import { requestPersistence } from './platform';
import { getDesktop } from './desktopBridge';

type Route = { name: 'boot' } | { name: 'landing' } | { name: 'editor'; draftId: string };

/**
 * Routing (R26): "/" opens the most recently edited draft, or Landing when the device has
 * no drafts. "/about" always shows Landing; "/l" is the letter reader (see App.tsx). App start shows only the ground color (21A).
 */
function Router({ initial }: { initial: DraftRecord[] }) {
  const { storage, refreshDrafts, broadcast } = useStore();
  const [route, setRoute] = useState<Route>(() => pick(initial));
  /** the open editor's unsaved-words guard: Back/Forward goes through it like any other leave */
  const guardRef = useRef<LeaveGuard | null>(null);
  const onGuard = useCallback((g: LeaveGuard | null) => void (guardRef.current = g), []);
  /** the URL the shown route belongs to (popstate has already moved location away from it) */
  const shownUrl = useRef(location.pathname);
  useEffect(() => {
    shownUrl.current = location.pathname;
  }, [route]);

  function pick(list: DraftRecord[]): Route {
    if (location.pathname === '/about') return { name: 'landing' };
    return list[0] ? { name: 'editor', draftId: list[0].id } : { name: 'landing' };
  }

  useEffect(() => {
    const onPop = async () => {
      const target = location.pathname;
      const go = () => {
        // "Leave anyway" after the URL was put back: go where Back/Forward pointed
        if (location.pathname !== target) history.pushState(null, '', target);
        void refreshDrafts().then((l) => setRoute(pick(l)));
      };
      const guard = guardRef.current;
      if (!guard) return go();
      const left = await guard(go);
      // unsaved words: stay on the editor's URL while the notice offers Copy / Leave anyway / Stay
      if (!left) history.pushState(null, '', shownUrl.current);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [refreshDrafts]);

  const openDraft = useCallback((draftId: string) => {
    if (location.pathname !== '/') history.pushState(null, '', '/');
    setRoute({ name: 'editor', draftId });
  }, []);

  // macOS: files opened from Finder, the Dock or File > Open… land here (through the unsaved-words guard)
  useEffect(
    () =>
      getDesktop()?.attachHost({
        storage,
        open: (id) => {
          const guard = guardRef.current;
          if (guard) void guard(() => openDraft(id));
          else openDraft(id);
        },
        refreshDrafts,
        broadcast,
      }),
    [storage, refreshDrafts, broadcast, openDraft],
  );

  const createDraft = useCallback(
    async (title?: string) => {
      const now = Date.now();
      const rec = newDraft(crypto.randomUUID(), now);
      await storage.createDraft(rec);
      if (title) {
        // "New draft titled …" (5A): the title is the draft's first recorded op
        const text = `# ${title}\n\n`;
        await storage.append({
          draftId: rec.id,
          baseHead: 0,
          baseEpoch: rec.epoch,
          ops: [[0, 0, text]],
          newSession: { opIndex: 0, at: now, tzOffset: new Date(now).getTimezoneOffset() },
          meta: deriveMeta(text),
          updatedAt: now,
          dayDeltas: [{ key: dayKey(now, new Date(now).getTimezoneOffset()), delta: countWords(text) }],
          snapshots: [],
        });
      }
      await refreshDrafts();
      void requestPersistence();
      openDraft(rec.id);
    },
    [storage, refreshDrafts, openDraft],
  );

  const afterDelete = useCallback(async () => {
    const list = await refreshDrafts();
    if (list[0]) openDraft(list[0].id);
    else setRoute({ name: 'landing' });
  }, [refreshDrafts, openDraft]);

  const afterImport = useCallback(async () => {
    const list = await refreshDrafts();
    void requestPersistence();
    if (list[0]) {
      broadcast({ type: 'library' }); // other tabs' draft lists
      openDraft(list[0].id);
    }
  }, [refreshDrafts, broadcast, openDraft]);

  if (route.name === 'landing') return <Landing onStart={() => void createDraft()} onRestored={afterImport} />;
  if (route.name === 'editor')
    return (
      <EditorShell
        key={route.draftId}
        draftId={route.draftId}
        onOpen={openDraft}
        onNew={createDraft}
        onDeleted={afterDelete}
        onGuard={onGuard}
      />
    );
  return null;
}

/** The writing app: drafts, storage, the editor. Its own chunk, so the letter reader never loads it. */
export function Library() {
  const [initial, setInitial] = useState<DraftRecord[] | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(t);
  }, []);
  const [bootError, setBootError] = useState(false);
  const onReady = useCallback((list: DraftRecord[]) => setInitial(list), []);
  const onBootError = useCallback(() => setBootError(true), []);
  return (
    <StoreProvider onReady={onReady} onBootError={onBootError}>
      {bootError ? (
        <main className="boot ui">
          <h1 className="sr-only">Kansowriter</h1>
          <p role="alert">Couldn’t open your saved drafts. They are still on this device.</p>
          <button type="button" className="text-btn" onClick={() => location.reload()}>
            Try again
          </button>
        </main>
      ) : initial ? (
        <Router initial={initial} />
      ) : (
        <div className="boot" aria-busy="true">
          {slow && <p className="ui">Opening your drafts…</p>}
        </div>
      )}
    </StoreProvider>
  );
}
