import { apply, compose, insertionOf, makeOp, normalize, type Op, type Run } from '../core/kop';
import { deriveMeta, needsNewSession, SNAPSHOT_EVERY, type DraftRecord, type Session, type Snapshot } from '../core/draft';
import { dayKey, wordDelta } from '../core/words';
import type { StorageAdapter } from '../core/storage';

export const MERGE_WINDOW_MS = 1000;
export const BATCH_MS = 500;

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
  /** storage refused our writes (R5): the tab must go read-only; text holds the rejected insertions */
  onStale(unsavedText: string): void;
  /** a batch committed; days ledger and draft meta may have changed */
  onCommit(record: DraftRecord): void;
}

/**
 * Turns editor changes into KOP ops and writes them (flush policy R4 reopened):
 *  - the 500 ms batch writes only CLOSED ops; a pending merged word stays open
 *  - a pending op closes when it goes idle for 1 s, when a non-mergeable change arrives,
 *    or on flush(true) (visibilitychange hidden, pagehide, lock handover)
 */
export class DraftWriter {
  private closedText: string;
  /** text at record.head (what storage holds) */
  private committedText: string;
  private pending: Pending | null = null;
  private queue: Closed[] = [];
  private lastEnd: number | null;
  private openedSinceLastOp = true;
  private writing: Promise<void> = Promise.resolve();
  private stale = false;

  constructor(
    private storage: StorageAdapter,
    private record: DraftRecord,
    text: string,
    private events: WriterEvents,
    private tzOffset: () => number = () => new Date().getTimezoneOffset(),
  ) {
    this.closedText = text;
    this.committedText = text;
    this.lastEnd = null;
  }

  get isStale(): boolean {
    return this.stale;
  }

  get head(): number {
    return this.record.head;
  }

  /** Text including the pending op (what the editor shows). */
  get currentText(): string {
    return this.pending ? apply(this.closedText, [0, 0, ...this.pending.runs]) : this.closedText;
  }

  push(c: Change): void {
    if (this.stale) return;
    const p = this.pending;
    if (p && c.at - p.end <= MERGE_WINDOW_MS && this.canMerge(p, c)) {
      p.runs = compose(p.runs, c.runs);
      p.end = c.at;
      if (c.kind === 'compose') p.kind = 'compose';
      return;
    }
    this.closePending();
    if (c.kind === 'type' || c.kind === 'compose') {
      this.pending = { runs: normalize(c.runs), start: c.at, end: c.at, kind: c.kind };
    } else {
      this.close({ runs: normalize(c.runs), start: c.at, end: c.at });
    }
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
    const p = this.pending;
    this.pending = null;
    this.close(p);
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
    this.openedSinceLastOp = false;
    const op = makeOp(dt, p.end - p.start, p.runs);
    const before = this.closedText;
    const after = apply(before, op);
    this.closedText = after;
    this.lastEnd = p.end;
    const tz = session?.tzOffset ?? this.tzOffset();
    const closed: Closed = { op, start: p.start, delta: wordDelta(before, after, op), key: dayKey(p.start, tz), session };
    if ((index + 1) % SNAPSHOT_EVERY === 0) closed.snapshot = { opIndex: index + 1, text: after };
    this.queue.push(closed);
  }

  /** Write closed ops. With closePending, the open word is closed first (hide, pagehide, handover). */
  flush(closePending = false, now = Date.now()): Promise<void> {
    if (closePending) this.closePending();
    else this.tick(now);
    this.writing = this.writing.then(() => this.drain());
    return this.writing;
  }

  private async drain(): Promise<void> {
    while (this.queue.length && !this.stale) {
      // one append per session boundary, so each batch carries at most one new session
      let n = 1;
      while (n < this.queue.length && !this.queue[n]!.session) n++;
      const batch = this.queue.slice(0, n);
      let textAfter = this.committedText;
      for (const c of batch) textAfter = apply(textAfter, c.op);
      const meta = deriveMeta(textAfter);
      const result = await this.storage.append({
        draftId: this.record.id,
        baseHead: this.record.head,
        ops: batch.map((c) => c.op),
        newSession: batch[0]!.session,
        meta,
        updatedAt: batch[batch.length - 1]!.start,
        dayDeltas: batch.map((c) => ({ key: c.key, delta: c.delta })),
        snapshot: [...batch].reverse().find((c) => c.snapshot)?.snapshot,
      });
      if (!result.ok) {
        this.stale = true;
        const unsaved = this.queue
          .flatMap((c) => c.op.slice(2).filter((r): r is string => typeof r === 'string'))
          .concat(this.pending ? this.pending.runs.filter((r): r is string => typeof r === 'string') : [])
          .join('');
        this.events.onStale(unsaved);
        return;
      }
      this.queue.splice(0, n);
      this.committedText = textAfter;
      const sessions = batch[0]!.session ? [...this.record.sessions, batch[0]!.session] : this.record.sessions;
      this.record = { ...this.record, head: result.head, meta, sessions, updatedAt: batch[batch.length - 1]!.start };
      this.events.onCommit(this.record);
    }
  }

  /** Mark that the draft was (re)opened, so the next op starts a session (R16). */
  markOpened(): void {
    this.openedSinceLastOp = true;
  }
}
