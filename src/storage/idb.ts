import Dexie, { type Table } from 'dexie';
import { Text } from '@codemirror/state';
import { runsOf, type Op } from '../core/kop';
import { newEpoch, SNAPSHOT_EVERY, type DraftMeta, type DraftRecord, type Snapshot } from '../core/draft';
import { applyDelta, emptyDay, resetDay, type Day } from '../core/words';
import type { AppendBatch, AppendResult, BackupData, ImportResult, LoadedDraft, StorageAdapter } from '../core/storage';

/**
 * Replay on a rope: each op costs O(runs × log n) instead of copying the whole string, so a
 * novel-length history loads and imports in seconds (string replay is ops × length). Stops at the
 * first op that doesn't apply and returns the text so far with ok: false (ok: true when all applied).
 * `onSnapshot` gets op indexes counted from the start of `ops`.
 */
function replayRope(base: string, ops: Op[], onSnapshot?: (opIndex: number, text: Text) => void): { doc: Text; ok: boolean } {
  let doc = Text.of(base.split('\n'));
  for (let i = 0; i < ops.length; i++) {
    let next = doc;
    let pos = 0;
    let ok = true;
    for (const r of runsOf(ops[i]!)) {
      if (typeof r === 'string') {
        next = next.replace(pos, pos, Text.of(r.split('\n')));
        pos += r.length;
      } else if (r >= 0) pos += r;
      else if (pos - r > next.length) ok = false;
      else next = next.replace(pos, pos - r, Text.empty);
      if (!ok || pos > next.length) {
        ok = false;
        break;
      }
    }
    if (!ok || pos !== next.length) return { doc, ok: false };
    doc = next;
    if ((i + 1) % SNAPSHOT_EVERY === 0) onSnapshot?.(i + 1, doc);
  }
  return { doc, ok: true };
}

/**
 * IndexedDB layout (R15, R20):
 *   drafts     id → DraftRecord {v, meta, sessions, head, epoch}
 *   ops        [draftId, seq] → op         (append-only, one row per KOP op)
 *   snapshots  [draftId, opIndex] → text   (the opIndex-0 base plus only the newest every-SNAPSHOT_EVERY one)
 *   days       localDate → {B, peak, resetOffset}   (words-today ledger, source of truth)
 *   kv         settings
 * append() writes ops, draft meta and day deltas in ONE transaction, so tabs serialize through IDB.
 * Every write that rewrites history (clear-history, import) renews the draft's epoch, so a
 * writer holding an old head can never pass the stale check by coincidence.
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
      const ops = await this.loadOps(id, snap?.opIndex ?? 0);
      // A bad op must not make the whole draft unreadable: keep the last state that applied.
      const { doc, ok } = replayRope(snap?.text ?? '', ops);
      return ok ? { record, text: doc.toString() } : { record, text: doc.toString(), damaged: true };
    });
  }

  async getRecord(id: string): Promise<DraftRecord | undefined> {
    return this.db.drafts.get(id);
  }

  private async latestSnapshot(id: string, head: number): Promise<Snapshot | null> {
    const rows = await this.db.snapshots.where('[draftId+opIndex]').between([id, 0], [id, head], true, true).reverse().limit(1).toArray();
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
      if (rec.head !== b.baseHead || rec.epoch !== b.baseEpoch) return { ok: false, reason: 'stale' } as const;
      await this.db.ops.bulkAdd(b.ops.map((op, i) => ({ draftId: b.draftId, seq: rec.head + i, op })));
      const head = rec.head + b.ops.length;
      const sessions = b.newSession ? [...rec.sessions, b.newSession] : rec.sessions;
      await this.db.drafts.put({ ...rec, head, meta: b.meta, updatedAt: b.updatedAt, sessions });
      if (b.snapshots.length) {
        // keep only the base (opIndex 0) and the newest snapshot: loads read just the latest one,
        // and full-text copies every 500 ops would otherwise grow quadratically with the draft
        const newest = Math.max(...b.snapshots.map((s) => s.opIndex));
        await this.db.snapshots.where('[draftId+opIndex]').between([b.draftId, 1], [b.draftId, newest], true, false).delete();
        await this.db.snapshots.put({ draftId: b.draftId, ...b.snapshots.find((s) => s.opIndex === newest)! });
      }
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

  async clearHistory(id: string, text: string, now: number, baseHead: number, baseEpoch: string, meta?: DraftMeta) {
    return this.db.transaction('rw', this.db.drafts, this.db.ops, this.db.snapshots, async () => {
      const rec = await this.db.drafts.get(id);
      if (!rec || rec.head !== baseHead || rec.epoch !== baseEpoch) return { ok: false } as const;
      await this.db.ops.where('draftId').equals(id).delete();
      await this.db.snapshots.where('draftId').equals(id).delete();
      await this.db.snapshots.put({ draftId: id, opIndex: 0, text });
      const record: DraftRecord = { ...rec, meta: meta ?? rec.meta, head: 0, sessions: [], updatedAt: now, epoch: newEpoch() };
      await this.db.drafts.put(record);
      return { ok: true, record } as const;
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
      const [records, opRows, snapRows, days] = await Promise.all([
        this.db.drafts.toArray(),
        this.db.ops.toArray(), // ordered by [draftId, seq]
        this.db.snapshots.toArray(),
        this.db.days.toArray(),
      ]);
      const ops = new Map<string, Op[]>();
      for (const r of opRows) (ops.get(r.draftId) ?? ops.set(r.draftId, []).get(r.draftId)!).push(r.op);
      const snaps = new Map<string, Snapshot[]>();
      for (const r of snapRows)
        (snaps.get(r.draftId) ?? snaps.set(r.draftId, []).get(r.draftId)!).push({ opIndex: r.opIndex, text: r.text });
      // only the base snapshot travels: the importer rebuilds the rest, keeping backups small
      const drafts = records.map((record) => ({
        record,
        ops: ops.get(record.id) ?? [],
        snapshots: (snaps.get(record.id) ?? []).filter((s) => s.opIndex === 0),
      }));
      return { format: 'kansobackup', v: 1, exportedAt: Date.now(), drafts, days } as const;
    });
  }

  /**
   * Adds every draft from the file. A draft whose id is already here is skipped only when its
   * text matches; a draft that diverged (edited on another device) comes in as a copy with a new
   * id, so newer work is never dropped. Only the opIndex-0 base snapshot is trusted from the
   * file; the newest snapshot is rebuilt by replaying the (already validated) ops. A draft whose
   * ops don't replay is left out and counted, instead of failing the whole import.
   */
  async importAll(data: BackupData): Promise<ImportResult> {
    const prepared = data.drafts.map((d) => {
      const base = d.snapshots.find((s) => s.opIndex === 0);
      let last: { opIndex: number; doc: Text } | null = null;
      const { doc, ok } = replayRope(base?.text ?? '', d.ops, (opIndex, doc) => (last = { opIndex, doc }));
      if (!ok) return null;
      const l = last as { opIndex: number; doc: Text } | null;
      const snap: Snapshot | null = l ? { opIndex: l.opIndex, text: l.doc.toString() } : null;
      return { d, base, text: doc.toString(), snap };
    });
    return this.db.transaction('rw', [this.db.drafts, this.db.ops, this.db.snapshots, this.db.days], async () => {
      const r: ImportResult = { added: 0, copies: 0, skipped: 0, damaged: 0 };
      let texts: Set<string> | null = null; // every local draft's text, loaded once on the first fork
      const localTexts = async () => {
        if (!texts) {
          texts = new Set();
          for (const rec of await this.db.drafts.toArray()) texts.add((await this.loadDraft(rec.id))?.text ?? '');
        }
        return texts;
      };
      for (const p of prepared) {
        if (!p) {
          r.damaged++;
          continue;
        }
        const { d, base, text, snap } = p;
        const rec = d.record;
        let id = rec.id;
        // rebuild from known fields only: unknown keys in the file never reach storage
        let meta: DraftMeta = { title: rec.meta.title, excerpt: rec.meta.excerpt, words: rec.meta.words };
        if (await this.db.drafts.get(id)) {
          if ((await this.alreadyHere(id, d.ops, text)) || (await localTexts()).has(text)) {
            r.skipped++;
            continue;
          }
          id = crypto.randomUUID();
          meta = { ...meta, title: `${meta.title} (from backup)` };
          r.copies++;
        }
        r.added++;
        (texts as Set<string> | null)?.add(text);
        const snaps: SnapRow[] = base ? [{ draftId: id, opIndex: 0, text: base.text }] : [];
        if (snap) snaps.push({ draftId: id, ...(snap as Snapshot) });
        await this.db.drafts.add({
          v: 1,
          id,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          meta,
          sessions: rec.sessions.map(({ opIndex, at, tzOffset }) => ({ opIndex, at, tzOffset })),
          head: d.ops.length,
          epoch: newEpoch(),
        });
        await this.db.ops.bulkAdd(d.ops.map((op, seq) => ({ draftId: id, seq, op })));
        if (snaps.length) await this.db.snapshots.bulkAdd(snaps);
      }
      for (const { key, B, peak, resetOffset } of data.days)
        if (!(await this.db.days.get(key))) await this.db.days.add({ key, B, peak, resetOffset });
      return r;
    });
  }

  /**
   * The backup's version of a draft is already on this device when: the text matches; the local
   * history starts with the backup's ops (an older backup restored onto the same device). The
   * caller also skips text an earlier import already added as a copy. Only real divergence copies.
   */
  private async alreadyHere(id: string, ops: Op[], text: string): Promise<boolean> {
    if ((await this.loadDraft(id))?.text === text) return true;
    if (ops.length) {
      const local = await this.db.ops.where('[draftId+seq]').between([id, 0], [id, ops.length], true, false).toArray();
      if (local.length === ops.length && local.every((row, i) => JSON.stringify(row.op) === JSON.stringify(ops[i]))) return true;
    }
    return false;
  }

  async getSetting<T>(key: string): Promise<T | undefined> {
    return (await this.db.kv.get(key))?.value as T | undefined;
  }

  async patchSetting(key: string, patch: Record<string, unknown>): Promise<void> {
    await this.db.transaction('rw', this.db.kv, async () => {
      const cur = (await this.db.kv.get(key))?.value;
      await this.db.kv.put({ key, value: { ...(typeof cur === 'object' && cur ? cur : {}), ...patch } });
    });
  }
}
