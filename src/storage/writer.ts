import { apply, compose, insertionOf, makeOp, normalize, type Op, type Run } from '../core/kop';
import { deriveMeta, needsNewSession, shouldSnapshot, type DraftRecord, type Session, type Snapshot } from '../core/draft';
import { countWords, dayKey, wordDelta } from '../core/words';
import type { LoadedDraft, StorageAdapter } from '../core/storage';

export const MERGE_WINDOW_MS = 1000;
export const BATCH_MS = 500;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
/** ops per append: keeps a retry small enough to fit once a little space frees up */
export const MAX_BATCH = 200;

/** What the editor recorder reports for each document change. */
export interface Change {
  runs: Run[];
  /** ms timestamp when the change happened */
  at: number;
  /** 'type' = a typed character; 'compose' = IME/autocorrect replace inside a word (R22); 'other' = paste, delete, etc. */
  kind: 'type' | 'compose' | 'other';
}

interface Pending {
  runs: Run[];
  start: number;
  end: number;
  kind: 'type' | 'compose';
}

interface Closed {
  op: Op;
  start: number;
  delta: number;
  key: string;
  session?: Session;
  snapshot?: Snapshot;
}

export interface WriterEvents {
  /** storage refused our writes or we lost the lock: the tab must go read-only; text is the full document as shown (R5) */
  onStale(currentText: string): void;
  /** a batch committed; days ledger and draft meta may have changed */
  onCommit(record: DraftRecord): void;
  /** a write failed (error) or recovered (null); queued ops are kept and retried */
  onError?(error: unknown | null): void;
}

/**
 * Turns editor changes into KOP ops and writes them (flush policy R4 reopened):
 *  - the 500 ms batch writes only CLOSED ops; a pending merged word stays open
 *  - a pending op closes when it goes idle for 1 s, when a non-mergeable change arrives,
 *    or on flush(true) (visibilitychange hidden, pagehide, lock handover)
 *  - a write that throws keeps the queue and retries with backoff; it never stops saving
 *
 *   push ─► pending ─(idle 1 s | other change | flush(true))─► queue ─(flush)─► storage.append
 *                                                                │  ok    → committed
 *                                                                │  stale → onStale(currentText), read-only
 *                                                                └  throw → keep queue, onError, retry
 */
export class DraftWriter {
  private closedText: string;
  /** text at record.head (what storage holds) */
  private committedText: string;
  private pending: Pending | null = null;
  private queue: Closed[] = [];
  private lastEnd: number | null = null;
  private openedSinceLastOp = true;
  private writing: Promise<void> = Promise.resolve();
  private stale = false;
  private retryAt = 0;
  private retryDelay = RETRY_MIN_MS;
  private failing = false;

  constructor(
    private storage: StorageAdapter,
    private record: DraftRecord,
    text: string,
    private events: WriterEvents,
    private tzOffset: () => number = () => new Date().getTimezoneOffset(),
  ) {
    this.closedText = text;
    this.committedText = text;
    // incremental word counting starts from a full count of the loaded text
    this.record = { ...record, meta: { ...record.meta, words: countWords(text) } };
  }

  get isStale(): boolean {
    return this.stale;
  }

  get head(): number {
    return this.record.head;
  }

  get draft(): DraftRecord {
    return this.record;
  }

  /** True when there are changes not yet committed to storage. */
  get dirty(): boolean {
    return this.pending !== null || this.queue.length > 0;
  }

  /** Text including the pending op (what the editor shows). */
  get currentText(): string {
    if (!this.pending) return this.closedText;
    try {
      return apply(this.closedText, [0, 0, ...this.pending.runs]);
    } catch {
      return this.closedText;
    }
  }

  push(c: Change): void {
    if (this.stale) return;
    try {
      const p = this.pending;
      if (p && c.at - p.end <= MERGE_WINDOW_MS && this.canMerge(p, c)) {
        p.runs = compose(p.runs, c.runs);
        p.end = c.at;
        if (c.kind === 'compose') p.kind = 'compose';
        return;
      }
      this.closePending();
      if (this.stale) return;
      if (c.kind === 'type' || c.kind === 'compose') {
        this.pending = { runs: normalize(c.runs), start: c.at, end: c.at, kind: c.kind };
      } else {
        this.close({ runs: normalize(c.runs), start: c.at, end: c.at });
      }
    } catch (error) {
      // first divergence between editor and writer: stop at once and hand back the valid text
      this.emit(() => this.events.onError?.(error));
      this.goStale();
    }
  }

  /**
   * Take every change not yet committed (queued ops and the open word) out of this writer and
   * retire it silently. Used to carry edits across a writer rebuild (clear-history).
   */
  takeUnsaved(): Change[] {
    const out: Change[] = this.queue.map((c) => ({ runs: c.op.slice(2) as Run[], at: c.start, kind: 'other' as const }));
    if (this.pending) out.push({ runs: this.pending.runs, at: this.pending.start, kind: 'other' });
    this.queue = [];
    this.pending = null;
    this.stale = true;
    return out;
  }

  private canMerge(p: Pending, c: Change): boolean {
    if (c.kind === 'compose') return true;
    if (c.kind !== 'type') return false;
    const prev = insertionOf(p.runs);
    const next = insertionOf(c.runs);
    if (!prev || !next) return p.kind === 'compose' && next !== null;
    if (/\s/.test(next.text)) return false; // a space ends the word
    return next.at === prev.at + prev.text.length;
  }

  /** Close the pending op if it has been idle for the merge window. */
  tick(now: number): void {
    if (this.pending && now - this.pending.end >= MERGE_WINDOW_MS) this.closePending();
  }

  closePending(): void {
    if (!this.pending) return;
    try {
      this.close(this.pending);
      this.pending = null;
    } catch (error) {
      // the recorder and writer disagree about the document: stop writing, hand back what is valid
      this.pending = null;
      this.emit(() => this.events.onError?.(error));
      this.goStale();
    }
  }

  private emit(f: () => void): void {
    try {
      f();
    } catch {
      // UI callback errors must never stop saving
    }
  }

  private close(p: { runs: Run[]; start: number; end: number }): void {
    if (p.runs.length === 1 && typeof p.runs[0] === 'number' && p.runs[0] > 0) return; // no-op
    const index = this.record.head + this.queue.length;
    let session: Session | undefined;
    let dt = this.lastEnd === null ? 0 : p.start - this.lastEnd;
    if (needsNewSession(this.lastEnd, p.start, this.openedSinceLastOp)) {
      session = { opIndex: index, at: p.start, tzOffset: this.tzOffset() };
      dt = 0;
    }
    const op = makeOp(dt, p.end - p.start, p.runs);
    const before = this.closedText;
    const after = apply(before, op); // validate before mutating any state
    this.openedSinceLastOp = false;
    this.closedText = after;
    this.lastEnd = p.end;
    const tz = session?.tzOffset ?? this.tzOffset();
    // no per-op copy of the document: a long run of failed saves must not hold N copies (memory)
    const closed: Closed = { op, start: p.start, delta: wordDelta(before, after, op), key: dayKey(p.start, tz), session };
    if (shouldSnapshot(index + 1)) closed.snapshot = { opIndex: index + 1, text: after };
    this.queue.push(closed);
  }

  /** Write closed ops. With closePending, the open word is closed first (hide, pagehide, handover). */
  flush(closePending = false, now = Date.now()): Promise<void> {
    if (!this.stale) {
      if (closePending) this.closePending();
      else this.tick(now);
    }
    // the chain can never stay rejected: a failed drain must not block later saves
    this.writing = this.writing.catch(() => {}).then(() => this.drain(now, closePending));
    return this.writing;
  }

  private async drain(now: number, urgent: boolean): Promise<void> {
    if (this.failing && !urgent && now < this.retryAt) return;
    while (this.queue.length && !this.stale) {
      // one append per session boundary, so each batch carries at most one new session
      let n = 1;
      while (n < this.queue.length && n < MAX_BATCH && !this.queue[n]!.session) n++;
      const batch = this.queue.slice(0, n);
      const last = batch[n - 1]!;
      let after = this.committedText;
      for (const c of batch) after = apply(after, c.op);
      const words = Math.max(0, this.record.meta.words + batch.reduce((s, c) => s + c.delta, 0));
      const meta = deriveMeta(after, words);
      let result;
      try {
        result = await this.storage.append({
          draftId: this.record.id,
          baseHead: this.record.head,
          baseEpoch: this.record.epoch,
          ops: batch.map((c) => c.op),
          newSession: batch[0]!.session,
          meta,
          updatedAt: last.start,
          dayDeltas: batch.map((c) => ({ key: c.key, delta: c.delta })),
          snapshots: batch.flatMap((c) => (c.snapshot ? [c.snapshot] : [])),
        });
      } catch (error) {
        this.failing = true;
        this.retryAt = now + this.retryDelay;
        this.retryDelay = Math.min(this.retryDelay * 2, RETRY_MAX_MS);
        this.emit(() => this.events.onError?.(error));
        return; // queue kept; the next flush retries
      }
      if (!result.ok) {
        this.goStale();
        return;
      }
      if (this.failing) {
        this.failing = false;
        this.retryDelay = RETRY_MIN_MS;
        this.emit(() => this.events.onError?.(null));
      }
      this.queue.splice(0, n);
      this.committedText = after;
      const sessions = batch[0]!.session ? [...this.record.sessions, batch[0]!.session] : this.record.sessions;
      this.record = { ...this.record, head: result.head, meta, sessions, updatedAt: last.start };
      const committed = this.record;
      this.emit(() => this.events.onCommit(committed));
    }
  }

  private goStale(): void {
    if (this.stale) return;
    this.stale = true;
    const text = this.currentText;
    this.emit(() => this.events.onStale(text));
  }

  /**
   * We lost the lock without a cooperative handover (another tab stole it, R23): never write
   * again (the new holder may already have loaded), and hand back anything unsaved.
   */
  abandon(): void {
    if (this.stale) return;
    if (this.dirty) this.goStale();
    else this.stale = true;
  }

  /** Text that storage has committed (at `head`): what clear-history rebases on (EditorShell passes it). */
  get savedText(): string {
    return this.committedText;
  }

  /** Mark that the draft was (re)opened, so the next op starts a session (R16). */
  markOpened(): void {
    this.openedSinceLastOp = true;
  }
}

export class DamagedDraftError extends Error {
  constructor(readonly text: string) {
    super('Draft history is damaged');
  }
}

/**
 * Load a draft and build its writer. Damaged drafts are never written on top of (repair first).
 * `preloaded` (a draft the caller already replayed) is reused only while storage's record still
 * has the same head and epoch, so a draft opens with one replay but never from a stale copy.
 */
export async function openDraftWriter(
  storage: StorageAdapter,
  id: string,
  events: WriterEvents,
  tzOffset?: () => number,
  preloaded?: LoadedDraft,
): Promise<DraftWriter> {
  let loaded: LoadedDraft | null = null;
  if (preloaded && preloaded.record.id === id) {
    const rec = await storage.getRecord(id);
    if (rec && rec.head === preloaded.record.head && rec.epoch === preloaded.record.epoch) loaded = { ...preloaded, record: rec };
  }
  loaded ??= await storage.loadDraft(id);
  if (!loaded) throw new Error(`Draft ${id} not found`);
  if (loaded.damaged) throw new DamagedDraftError(loaded.text);
  return new DraftWriter(storage, loaded.record, loaded.text, events, tzOffset);
}
