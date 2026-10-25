import { runsOf, type Op } from './kop';

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯豈-﫿]/gu;
const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}'’_-]*/gu;

/** The footer's word splitter. CJK characters count as one word each. */
export function countWords(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK, ' ');
  return cjk + (rest.match(TOKEN)?.length ?? 0);
}

/**
 * Words-today delta for one op: word count of the affected lines after the op
 * minus before (document delta, not fragment counting, so partial-word inserts,
 * in-word fixes and space splits/joins count by how the document really changed).
 */
export function wordDelta(before: string, after: string, op: Op): number {
  const runs = runsOf(op);
  let lead = 0;
  for (const r of runs) {
    if (typeof r === 'number' && r > 0) lead += r;
    else break;
  }
  const last = runs[runs.length - 1];
  const trail = typeof last === 'number' && last > 0 && runs.length > 1 ? last : 0;
  if (lead === before.length && lead === after.length) return 0;
  const start = lead === 0 ? 0 : before.lastIndexOf('\n', lead - 1) + 1;
  const endBefore = lineEnd(before, before.length - trail);
  const endAfter = lineEnd(after, after.length - trail);
  return countWords(after.slice(start, endAfter)) - countWords(before.slice(start, endBefore));
}

function lineEnd(text: string, from: number): number {
  const i = text.indexOf('\n', from);
  return i === -1 ? text.length : i;
}

/** Daily ledger (R20): B is the running balance since local midnight; words today = peak. */
export interface Day {
  key: string;
  B: number;
  peak: number;
  resetOffset: number;
}

export function emptyDay(key: string): Day {
  return { key, B: 0, peak: 0, resetOffset: 0 };
}

export function applyDelta(day: Day, delta: number): Day {
  const B = day.B + delta;
  return { ...day, B, peak: Math.max(day.peak, B) };
}

export function wordsToday(day: Day | undefined): number {
  return day ? Math.max(0, day.peak - day.resetOffset) : 0;
}

export function resetDay(day: Day): Day {
  return { ...day, resetOffset: day.peak };
}

/** Local calendar date for an absolute time, using the timezone offset (minutes, as Date.getTimezoneOffset) at write time. */
export function dayKey(at: number, tzOffset: number): string {
  const local = new Date(at - tzOffset * 60_000);
  return local.toISOString().slice(0, 10);
}
