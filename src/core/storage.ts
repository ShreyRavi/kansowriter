import type { Op } from './kop';
import type { DraftMeta, DraftRecord, Session, Snapshot } from './draft';
import type { Day } from './words';

export interface AppendBatch {
  draftId: string;
  /** log length the ops were based on; storage rejects if it isn't the current head (R5) */
  baseHead: number;
  ops: Op[];
  newSession?: Session;
  meta: DraftMeta;
  updatedAt: number;
  /** words-today deltas to apply in order, in the same transaction (R20) */
  dayDeltas: { key: string; delta: number }[];
  snapshot?: Snapshot;
}

export type AppendResult = { ok: true; head: number } | { ok: false; reason: 'stale' | 'missing' };

export interface LoadedDraft {
  record: DraftRecord;
  text: string;
}

export interface BackupDraft {
  record: DraftRecord;
  ops: Op[];
  snapshots: Snapshot[];
}

export interface BackupData {
  format: 'kansobackup';
  v: 1;
  exportedAt: number;
  drafts: BackupDraft[];
  days: Day[];
}

/** Storage boundary: IndexedDB now, Tauri files later (premise 5). */
export interface StorageAdapter {
  listDrafts(): Promise<DraftRecord[]>;
  createDraft(record: DraftRecord): Promise<void>;
  loadDraft(id: string): Promise<LoadedDraft | null>;
  loadOps(id: string, from?: number): Promise<Op[]>;
  loadSnapshots(id: string): Promise<Snapshot[]>;
  append(batch: AppendBatch): Promise<AppendResult>;
  deleteDraft(id: string): Promise<void>;
  /** R9: keep text, drop history; today's words-today value is untouched (R20). */
  clearHistory(id: string, text: string, now: number): Promise<void>;
  getDay(key: string): Promise<Day | undefined>;
  resetDay(key: string): Promise<Day>;
  exportAll(): Promise<BackupData>;
  importAll(data: BackupData): Promise<{ added: number; skipped: number }>;
  getSetting<T>(key: string): Promise<T | undefined>;
  setSetting<T>(key: string, value: T): Promise<void>;
}
