import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IndexedDbAdapter } from '../storage/idb';
import { channel, FOLLOW_COALESCE_MS, type ChannelMessage } from '../storage/lifecycle';
import { dayKey, wordsToday } from '../core/words';
import type { DraftRecord } from '../core/draft';
import type { StorageAdapter } from '../core/storage';
import { applyTheme, DEFAULTS, sanitizeSettings, storedThemeChoice, type Settings } from './settings';

interface Store {
  storage: StorageAdapter;
  settings: Settings;
  update(patch: Partial<Settings>): void;
  drafts: DraftRecord[];
  refreshDrafts(): Promise<DraftRecord[]>;
  /** put one committed draft in the list (newest first) without rereading the whole table */
  upsertDraft(record: DraftRecord): void;
  today: number;
  refreshToday(): Promise<void>;
  /** tell other tabs something committed (days ledger, draft list) */
  broadcast(m: ChannelMessage): void;
}

const Ctx = createContext<Store | null>(null);

const isRecordFor = (r: unknown, id: string): r is DraftRecord => {
  const rec = r as Partial<DraftRecord> | null;
  return (
    typeof rec === 'object' &&
    rec !== null &&
    rec.id === id &&
    typeof rec.updatedAt === 'number' &&
    typeof rec.meta === 'object' &&
    rec.meta !== null
  );
};
const storage = new IndexedDbAdapter();

export function StoreProvider({
  children,
  onReady,
  onBootError,
}: {
  children: ReactNode;
  onReady?: (drafts: DraftRecord[]) => void;
  onBootError?: (e: unknown) => void;
}) {
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

  const upsertDraft = useCallback((record: DraftRecord) => {
    setDrafts((list) => {
      const rest = list.filter((d) => d.id !== record.id);
      const at = rest.findIndex((d) => d.updatedAt <= record.updatedAt);
      return at < 0 ? [...rest, record] : [...rest.slice(0, at), record, ...rest.slice(at)];
    });
  }, []);

  const refreshToday = useCallback(async () => {
    const now = Date.now();
    setToday(wordsToday(await storage.getDay(dayKey(now, new Date(now).getTimezoneOffset()))));
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const merged = sanitizeSettings(await storage.getSetting<unknown>('settings'));
      merged.theme = storedThemeChoice() ?? merged.theme;
      const list = await storage.listDrafts();
      if (!alive) return;
      setSettings(merged);
      applyTheme(merged.theme);
      setDrafts(list);
      await refreshToday();
      onReady?.(list);
    })().catch((e) => {
      // never show an empty library for a database that failed to open (it would look like data loss)
      if (alive) onBootError?.(e);
    });
    bc.current = channel();
    let refresh: ReturnType<typeof setTimeout> | null = null;
    /** committed rows waiting for the timer; a full reread (released, deleted, library) supersedes them */
    const committed = new Map<string, DraftRecord>();
    let full = false;
    const onMsg = (e: MessageEvent<ChannelMessage>) => {
      const m = e.data;
      if (m?.type === 'settings') {
        void storage.getSetting<unknown>('settings').then((v) => {
          const next = sanitizeSettings(v);
          setSettings(next);
          applyTheme(next.theme);
        });
        return;
      }
      // a row from another tab (maybe another version) goes in only if it is shaped like one; else reread
      if (m?.type === 'committed') {
        if (isRecordFor(m.record, m.draftId)) committed.set(m.draftId, m.record);
        else full = true;
      } else if (m?.type === 'released' || m?.type === 'deleted' || m?.type === 'library') full = true;
      else return;
      if (refresh) return; // another tab commits every BATCH_MS while typing: coalesce
      refresh = setTimeout(() => {
        refresh = null;
        void refreshToday();
        // while someone types, only their draft's row changes: upsert it instead of rereading every draft
        if (full) void refreshDrafts();
        else committed.forEach((r) => upsertDraft(r));
        committed.clear();
        full = false;
      }, FOLLOW_COALESCE_MS);
    };
    bc.current?.addEventListener('message', onMsg);
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => applyTheme(settingsRef.current.theme);
    mq.addEventListener('change', onScheme);
    const midnight = setInterval(() => void refreshToday(), 60_000);
    return () => {
      alive = false;
      if (refresh) clearTimeout(refresh);
      bc.current?.removeEventListener('message', onMsg);
      bc.current?.close();
      mq.removeEventListener('change', onScheme);
      clearInterval(midnight);
    };
  }, [refreshDrafts, upsertDraft, refreshToday, onReady, onBootError]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      if (patch.theme) applyTheme(next.theme);
      return next;
    });
    // persist only the patch over what's stored, so a stale tab can't write back old values
    // (lastExportedAt, safariHintDismissed) that another tab changed; then tell other tabs
    // started at once (not queued behind a read), so a reload right after still keeps it
    storage.patchSetting('settings', patch).then(
      () => {
        try {
          bc.current?.postMessage({ type: 'settings' } satisfies ChannelMessage);
        } catch {
          // channel closed
        }
      },
      () => {
        // storage unavailable: the setting still applies in this tab
      },
    );
  }, []);

  const broadcast = useCallback((m: ChannelMessage) => {
    try {
      bc.current?.postMessage(m);
    } catch {
      // channel closed
    }
  }, []);

  const value = useMemo(
    () => ({ storage, settings, update, drafts, refreshDrafts, upsertDraft, today, refreshToday, broadcast }),
    [settings, update, drafts, refreshDrafts, upsertDraft, today, refreshToday, broadcast],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}
