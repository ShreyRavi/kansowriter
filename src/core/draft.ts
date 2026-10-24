import { apply, type Op } from './kop';
import { countWords } from './words';

export const SNAPSHOT_EVERY = 500;
export const SESSION_GAP_MS = 30 * 60_000;

export interface Session {
  /** index of the first op in this session */
  opIndex: number;
  /** absolute epoch ms when that op started */
  at: number;
  /** Date.getTimezoneOffset() at write time */
  tzOffset: number;
}

export interface DraftMeta {
  title: string;
  excerpt: string;
  words: number;
}

export interface DraftRecord {
  v: 1;
  id: string;
  createdAt: number;
  updatedAt: number;
  meta: DraftMeta;
  sessions: Session[];
  /** number of ops in the log (next seq) */
  head: number;
  /** random token, renewed by clear-history and import; appends must match it so a reused head can't pass (R5) */
  epoch: string;
}

export interface Snapshot {
  /** text after applying ops [0, opIndex) */
  opIndex: number;
  text: string;
}

export function newEpoch(): string {
  return globalThis.crypto.randomUUID();
}

export function newDraft(id: string, now: number): DraftRecord {
  return { v: 1, id, createdAt: now, updatedAt: now, meta: { title: 'Untitled', excerpt: '', words: 0 }, sessions: [], head: 0, epoch: newEpoch() };
}

export function replay(snapshot: Snapshot | null, ops: Op[]): string {
  let text = snapshot?.text ?? '';
  for (const op of ops) text = apply(text, op);
  return text;
}

const stripMd = (s: string) =>
  s
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
    .replace(/[*_`~]+/g, '')
    .trim();

/**
 * Title = first non-empty line, excerpt = following text up to 160 chars. Scans only as far as
 * needed; pass `words` when the caller tracks the count incrementally.
 */
export function deriveMeta(text: string, words?: number): DraftMeta {
  let title = '';
  let excerpt = '';
  let pos = 0;
  while (pos <= text.length && excerpt.length < EXCERPT_MAX) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? text.length : nl;
    const line = stripMd(text.slice(pos, end));
    if (line) {
      if (!title) title = line.slice(0, 80);
      else excerpt = excerpt ? `${excerpt} ${line}` : line;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { title: title || 'Untitled', excerpt: excerpt.slice(0, EXCERPT_MAX), words: words ?? countWords(text) };
}

const EXCERPT_MAX = 160;

/**
 * R16: a session starts only when an op arrives after the draft was opened
 * or after more than 30 minutes without ops.
 */
export function needsNewSession(lastOpEnd: number | null, now: number, openedSinceLastOp: boolean): boolean {
  if (lastOpEnd === null || openedSinceLastOp) return true;
  return now - lastOpEnd > SESSION_GAP_MS;
}

/**
 * Absolute start time of each op in a full log (ops[0] is op index 0), from each session's
 * `at` plus cumulative dt and d within the session.
 */
export function opTimes(sessions: Session[], ops: Op[]): number[] {
  const times: number[] = [];
  let si = -1;
  let clock = 0;
  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx]!;
    if (si + 1 < sessions.length && sessions[si + 1]!.opIndex === idx) {
      si++;
      clock = sessions[si]!.at - op[0];
    }
    clock += op[0];
    times.push(clock);
    clock += op[1];
  }
  return times;
}

export function shouldSnapshot(head: number): boolean {
  return head > 0 && head % SNAPSHOT_EVERY === 0;
}
