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
}

export interface Snapshot {
  /** text after applying ops [0, opIndex) */
  opIndex: number;
  text: string;
}

export function newDraft(id: string, now: number): DraftRecord {
  return { v: 1, id, createdAt: now, updatedAt: now, meta: { title: 'Untitled', excerpt: '', words: 0 }, sessions: [], head: 0 };
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

export function deriveMeta(text: string): DraftMeta {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const title = stripMd(lines[0] ?? '').slice(0, 80) || 'Untitled';
  const body = lines.slice(1).map(stripMd).join(' ');
  return { title, excerpt: body.slice(0, 160), words: countWords(text) };
}

/**
 * R16: a session starts only when an op arrives after the draft was opened
 * or after more than 30 minutes without ops.
 */
export function needsNewSession(lastOpEnd: number | null, now: number, openedSinceLastOp: boolean): boolean {
  if (lastOpEnd === null || openedSinceLastOp) return true;
  return now - lastOpEnd > SESSION_GAP_MS;
}

/** Absolute start time of each op, from its session's `at` plus cumulative dt and d. */
export function opTimes(sessions: Session[], ops: Op[], firstIndex = 0): number[] {
  const times: number[] = [];
  let si = -1;
  let clock = 0;
  for (let k = 0; k < ops.length; k++) {
    const idx = firstIndex + k;
    while (si + 1 < sessions.length && sessions[si + 1]!.opIndex <= idx) {
      si++;
      if (sessions[si]!.opIndex === idx) clock = sessions[si]!.at - ops[k]![0];
    }
    const op = ops[k]!;
    clock += op[0];
    times.push(clock);
    clock += op[1];
  }
  return times;
}

export function shouldSnapshot(head: number): boolean {
  return head > 0 && head % SNAPSHOT_EVERY === 0;
}
