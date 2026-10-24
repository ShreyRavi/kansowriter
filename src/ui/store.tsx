import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IndexedDbAdapter } from '../storage/idb';
import { channel, type ChannelMessage } from '../storage/lifecycle';
import { dayKey, wordsToday } from '../core/words';
import type { DraftRecord } from '../core/draft';
import type { StorageAdapter } from '../core/storage';
import { applyTheme, DEFAULTS, type Settings } from './settings';

interface Store {
  storage: StorageAdapter;
  settings: Settings;
  update(patch: Partial<Settings>): void;
  drafts: DraftRecord[];
  refreshDrafts(): Promise<DraftRecord[]>;
  today: number;
  refreshToday(): Promise<void>;
  /** tell other tabs something committed (days ledger, draft list) */
  broadcast(m: ChannelMessage): void;
}

const Ctx = createContext<Store | null>(null);
const storage = new IndexedDbAdapter();

export function StoreProvider({ children, onReady }: { children: ReactNode; onReady?: (drafts: DraftRecord[]) => void }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [drafts, setDrafts] = useState<DraftRecord[]>([]);
  const [today, setToday] = useState(0);
  const bc = useRef<BroadcastChannel | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const refreshDrafts = useCallback(async () => {
    const list = await storage.listDrafts();
    setDrafts(list);
    return list;
  }, []);

  const refreshToday = useCallback(async () => {
    const now = Date.now();
    setToday(wordsToday(await storage.getDay(dayKey(now, new Date(now).getTimezoneOffset()))));
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const saved = (await storage.getSetting<Partial<Settings>>('settings')) ?? {};
      const merged = { ...DEFAULTS, ...saved };
      const list = await storage.listDrafts();
      if (!alive) return;
      setSettings(merged);
      applyTheme(merged.theme);
      setDrafts(list);
      await refreshToday();
      onReady?.(list);
    })().catch(() => onReady?.([]));
    bc.current = channel();
    const onMsg = () => {
      void refreshToday();
      void refreshDrafts();
    };
    bc.current?.addEventListener('message', onMsg);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => applyTheme(settingsRef.current.theme);
    mq.addEventListener('change', onScheme);
    const midnight = setInterval(() => void refreshToday(), 60_000);
    return () => {
      alive = false;
      bc.current?.removeEventListener('message', onMsg);
      bc.current?.close();
      mq.removeEventListener('change', onScheme);
      clearInterval(midnight);
    };
  }, [refreshDrafts, refreshToday, onReady]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      if (patch.theme) applyTheme(next.theme);
      void storage.setSetting('settings', next);
      return next;
    });
  }, []);

  const broadcast = useCallback((m: ChannelMessage) => {
    try {
      bc.current?.postMessage(m);
    } catch {
      // channel closed
    }
  }, []);

  const value = useMemo(
    () => ({ storage, settings, update, drafts, refreshDrafts, today, refreshToday, broadcast }),
    [settings, update, drafts, refreshDrafts, today, refreshToday, broadcast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
