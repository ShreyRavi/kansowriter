import Dexie, { type Table } from 'dexie';
import type { Op } from '../core/kop';
import { replay, type DraftRecord, type Snapshot } from '../core/draft';
import { applyDelta, emptyDay, resetDay, type Day } from '../core/words';
import type { AppendBatch, AppendResult, BackupData, LoadedDraft, StorageAdapter } from '../core/storage';

/**
 * IndexedDB layout (R15, R20):
 *   drafts     id → DraftRecord {v, meta, sessions, head}
 *   ops        [draftId, seq] → op         (append-only, one row per KOP op)
 *   snapshots  [draftId, opIndex] → text   (every 500 ops; opIndex 0 after clear-history)
 *   days       localDate → {B, peak, resetOffset}   (words-today ledger, source of truth)
 *   kv         settings
 * append() writes ops, draft meta and day deltas in ONE transaction, so tabs serialize through IDB.
 */
interface OpRow {
  draftId: string;
  seq: number;
  op: Op;
}
interface SnapRow extends Snapshot {
  draftId: string;
}
interface KvRow {
  key: string;
  value: unknown;
}

class KansoDB extends Dexie {
  drafts!: Table<DraftRecord, string>;
  ops!: Table<OpRow, [string, number]>;
  snapshots!: Table<SnapRow, [string, number]>;
  days!: Table<Day, string>;
  kv!: Table<KvRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      drafts: '&id, updatedAt',
      ops: '[draftId+seq], draftId',
      snapshots: '[draftId+opIndex], draftId',
      days: '&key',
      kv: '&key',
    });
  }
}

export class IndexedDbAdapter implements StorageAdapter {
  readonly db: KansoDB;

  constructor(name = 'kansowriter') {
    this.db = new KansoDB(name);
  }

  async listDrafts(): Promise<DraftRecord[]> {
    return this.db.drafts.orderBy('updatedAt').reverse().toArray();
  }

  async createDraft(record: DraftRecord): Promise<void> {
    await this.db.drafts.add(record);
  }

  async loadDraft(id: string): Promise<LoadedDraft | null> {
    return this.db.transaction('r', this.db.drafts, this.db.ops, this.db.snapshots, async () => {
      const record = await this.db.drafts.get(id);
      if (!record) return null;
      const snap = await this.latestSnapshot(id, record.head);
      const from = snap?.opIndex ?? 0;
      const ops = await this.loadOps(id, from);
      return { record, text: replay(snap, ops) };
    });
  }

  private async latestSnapshot(id: string, head: number): Promise<Snapshot | null> {
    const rows = await this.db.snapshots
      .where('[draftId+opIndex]')
      .between([id, 0], [id, head], true, true)
      .reverse()
      .limit(1)
      .toArray();
    const r = rows[0];
    return r ? { opIndex: r.opIndex, text: r.text } : null;
  }

  async loadOps(id: string, from = 0): Promise<Op[]> {
    const rows = await this.db.ops.where('[draftId+seq]').between([id, from], [id, Dexie.maxKey], true, true).toArray();
    return rows.map((r) => r.op);
  }

  async loadSnapshots(id: string): Promise<Snapshot[]> {
    const rows = await this.db.snapshots.where('draftId').equals(id).sortBy('opIndex');
    return rows.map(({ opIndex, text }) => ({ opIndex, text }));
  }

  async append(b: AppendBatch): Promise<AppendResult> {
    return this.db.transaction('rw', [this.db.drafts, this.db.ops, this.db.snapshots, this.db.days], async () => {
      const rec = await this.db.drafts.get(b.draftId);
      if (!rec) return { ok: false, reason: 'missing' } as const;
      if (rec.head !== b.baseHead) return { ok: false, reason: 'stale' } as const;
      await this.db.ops.bulkAdd(b.ops.map((op, i) => ({ draftId: b.draftId, seq: rec.head + i, op })));
      const head = rec.head + b.ops.length;
      const sessions = b.newSession ? [...rec.sessions, b.newSession] : rec.sessions;
      await this.db.drafts.put({ ...rec, head, meta: b.meta, updatedAt: b.updatedAt, sessions });
      if (b.snapshot) await this.db.snapshots.put({ draftId: b.draftId, ...b.snapshot });
      const touched = new Map<string, Day>();
      for (const { key, delta } of b.dayDeltas) {
        const day = touched.get(key) ?? (await this.db.days.get(key)) ?? emptyDay(key);
        touched.set(key, applyDelta(day, delta));
      }
      if (touched.size) await this.db.days.bulkPut([...touched.values()]);
      return { ok: true, head } as const;
    });
  }

  async deleteDraft(id: string): Promise<void> {
    await this.db.transaction('rw', this.db.drafts, this.db.ops, this.db.snapshots, async () => {
      await this.db.ops.where('draftId').equals(id).delete();
      await this.db.snapshots.where('draftId').equals(id).delete();
      await this.db.drafts.delete(id);
    });
  }

  async clearHistory(id: string, text: string, now: number): Promise<void> {
    await this.db.transaction('rw', this.db.drafts, this.db.ops, this.db.snapshots, async () => {
      const rec = await this.db.drafts.get(id);
      if (!rec) return;
      await this.db.ops.where('draftId').equals(id).delete();
      await this.db.snapshots.where('draftId').equals(id).delete();
      await this.db.snapshots.put({ draftId: id, opIndex: 0, text });
      await this.db.drafts.put({ ...rec, head: 0, sessions: [], updatedAt: now });
    });
  }

  async getDay(key: string): Promise<Day | undefined> {
    return this.db.days.get(key);
  }

  async resetDay(key: string): Promise<Day> {
    return this.db.transaction('rw', this.db.days, async () => {
      const day = resetDay((await this.db.days.get(key)) ?? emptyDay(key));
      await this.db.days.put(day);
      return day;
    });
  }

  async exportAll(): Promise<BackupData> {
    return this.db.transaction('r', [this.db.drafts, this.db.ops, this.db.snapshots, this.db.days], async () => {
      const records = await this.db.drafts.toArray();
      const drafts = [];
      for (const record of records) {
        drafts.push({ record, ops: await this.loadOps(record.id), snapshots: await this.loadSnapshots(record.id) });
      }
      return { format: 'kansobackup', v: 1, exportedAt: Date.now(), drafts, days: await this.db.days.toArray() } as const;
    });
  }

  async importAll(data: BackupData): Promise<{ added: number; skipped: number }> {
    return this.db.transaction('rw', [this.db.drafts, this.db.ops, this.db.snapshots, this.db.days], async () => {
      let added = 0;
      let skipped = 0;
      for (const d of data.drafts) {
        if (await this.db.drafts.get(d.record.id)) {
          skipped++;
          continue;
        }
        await this.db.drafts.add({ ...d.record, head: d.ops.length });
        await this.db.ops.bulkAdd(d.ops.map((op, seq) => ({ draftId: d.record.id, seq, op })));
        await this.db.snapshots.bulkAdd(d.snapshots.map((s) => ({ draftId: d.record.id, ...s })));
        added++;
      }
      for (const day of data.days) if (!(await this.db.days.get(day.key))) await this.db.days.add(day);
      return { added, skipped };
    });
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.db.kv.get(key))?.value as T | undefined;
  }

  async setSetting<T>(key: string, value: T): Promise<void> {
    await this.db.kv.put({ key, value });
  }
}
