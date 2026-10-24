import { useCallback, useEffect, useState } from 'react';
import { deriveMeta, newDraft, type DraftRecord } from '../core/draft';
import { countWords, dayKey } from '../core/words';
import { StoreProvider, useStore } from './store';
import { Landing } from './Landing';
import { EditorShell } from './EditorShell';
import { requestPersistence } from './platform';

type Route = { name: 'boot' } | { name: 'landing' } | { name: 'editor'; draftId: string };

/**
 * Routing (R26): "/" opens the most recently edited draft, or Landing when the device has
 * no drafts. "/about" always shows Landing. App start shows only the ground color (21A).
 */
function Router({ initial }: { initial: DraftRecord[] }) {
  const { storage, refreshDrafts } = useStore();
  const [route, setRoute] = useState<Route>(() => pick(initial));

  function pick(list: DraftRecord[]): Route {
    if (location.pathname === '/about') return { name: 'landing' };
    return list[0] ? { name: 'editor', draftId: list[0].id } : { name: 'landing' };
  }

  useEffect(() => {
    const onPop = () => void refreshDrafts().then((l) => setRoute(pick(l)));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [refreshDrafts]);

  const openDraft = useCallback((draftId: string) => {
    if (location.pathname !== '/') history.pushState(null, '', '/');
    setRoute({ name: 'editor', draftId });
  }, []);

  const createDraft = useCallback(async (title?: string) => {
    const now = Date.now();
    const rec = newDraft(crypto.randomUUID(), now);
    await storage.createDraft(rec);
    if (title) {
      // "New draft titled …" (5A): the title is the draft's first recorded op
      const text = `# ${title}\n\n`;
      await storage.append({
        draftId: rec.id, baseHead: 0, baseEpoch: rec.epoch, ops: [[0, 0, text]],
        newSession: { opIndex: 0, at: now, tzOffset: new Date(now).getTimezoneOffset() },
        meta: deriveMeta(text), updatedAt: now,
        dayDeltas: [{ key: dayKey(now, new Date(now).getTimezoneOffset()), delta: countWords(text) }], snapshots: [],
      });
    }
    await refreshDrafts();
    void requestPersistence();
    openDraft(rec.id);
  }, [storage, refreshDrafts, openDraft]);

  const afterDelete = useCallback(async () => {
    const list = await refreshDrafts();
    if (list[0]) openDraft(list[0].id);
    else setRoute({ name: 'landing' });
  }, [refreshDrafts, openDraft]);

  const afterImport = useCallback(async () => {
    const list = await refreshDrafts();
    if (list[0]) openDraft(list[0].id);
  }, [refreshDrafts, openDraft]);

  if (route.name === 'landing') return <Landing onStart={() => void createDraft()} onRestored={afterImport} />;
  if (route.name === 'editor')
    return <EditorShell key={route.draftId} draftId={route.draftId} onOpen={openDraft} onNew={createDraft} onDeleted={afterDelete} />;
  return null;
}

export function App() {
  const [initial, setInitial] = useState<DraftRecord[] | null>(null);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(t);
  }, []);
  const onReady = useCallback((list: DraftRecord[]) => setInitial(list), []);
  return (
    <StoreProvider onReady={onReady}>
      {initial ? (
        <Router initial={initial} />
      ) : (
        <div className="boot" aria-busy="true">
          {slow && <p className="ui">Opening your drafts…</p>}
        </div>
      )}
    </StoreProvider>
  );
}
