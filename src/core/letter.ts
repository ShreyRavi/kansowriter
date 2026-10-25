/**
 * Letters (v0.1): a range of a draft's history, compressed into a link or a .kansoletter file.
 *
 *   payload v1 = { v: 1, baseText, ops, meta? }                      (R24)
 *   JSON → deflate-raw → base64url → "v1." + payload  →  /l#v1.<payload>
 *
 * baseText is the document at the chosen start (empty from creation), shown instantly; ops replay
 * after it. "Final text only" = { baseText: final, ops: [] }. Unknown keys inside meta are ignored;
 * unknown top-level keys are rejected. One shared cap (R13) for links and files.
 *
 * The v1 wire format (and the decoder's reading of it) is permanent: letters already sent are
 * decoded with these semantics forever (see kop.golden.test.ts). So are the exported signatures.
 */
import { Text } from '@codemirror/state';
import { isValidOp, normalize, runsOf, targetLength, type Op, type Run } from './kop';
import { opTimes, type Session } from './draft';

/** encoded size cap, links and .kansoletter files alike (R13) */
export const LETTER_CAP_BYTES = 256 * 1024;
/** links above this suggest trimming or a file (tuned by scripts/measure-letters.ts) */
export const LINK_THRESHOLD_BYTES = 8 * 1024;
/** decoder limits (untrusted input) */
export const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_OPS = 200_000;
/** replaySteps never emits more steps than this; a letter with more ops is 'too-large' */
export const MAX_REPLAY_STEPS = MAX_OPS;
export const LETTER_PREFIX = 'v1.';
export const LETTER_FILE_EXTENSION = '.kansoletter';
export const LETTER_MIME = 'application/x-kansoletter';

export interface LetterMeta {
  /** ms epoch of the replay's first op (shown as "A letter, written Oct 22") */
  writtenAt?: number;
  /** writer's tz offset in minutes (Date#getTimezoneOffset) */
  tz?: number;
}

export interface Letter {
  v: 1;
  baseText: string;
  ops: Op[];
  meta?: LetterMeta;
}

export type LetterErrorKind = 'damaged' | 'too-large' | 'unsupported';
export class LetterError extends Error {
  constructor(
    readonly kind: LetterErrorKind,
    message?: string,
  ) {
    super(message ?? kind);
  }
}

/** true when the browser can decode letters (DecompressionStream deflate-raw) (R14) */
export function lettersSupported(): boolean {
  try {
    if (typeof DecompressionStream !== 'function' || typeof CompressionStream !== 'function') return false;
    new DecompressionStream('deflate-raw');
    new CompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// codec

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}

/** Inflate with a hard output cap: a tiny crafted payload can't expand into unbounded memory. */
async function inflateCapped(bytes: Uint8Array, cap: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let r: ReadableStreamReadResult<Uint8Array>;
    try {
      r = await reader.read();
    } catch {
      throw new LetterError('damaged', 'payload does not inflate');
    }
    if (r.done) break;
    total += r.value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      throw new LetterError('too-large', 'payload inflates past the cap');
    }
    chunks.push(r.value);
  }
  return new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new LetterError('damaged', 'not base64url');
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new LetterError('damaged', 'not base64url');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** encodeLetter's padding attempts (~4% of prose-sized payloads end in '-' or '_' per try) */
const PAD_TRIES = 64;

/**
 * Letter → "v1.<base64url>". Throws LetterError('too-large') over LETTER_CAP_BYTES (or over the
 * decoder's MAX_OPS / MAX_DECOMPRESSED_BYTES). The letter is validated with the decoder's own
 * schema first, so we never send something a reader would refuse (an invalid letter throws
 * LetterError('damaged'), which means a bug on our side). Unknown meta keys are dropped.
 *
 * The link always ends in [A-Za-z0-9] (D3): chat apps and mail clients trim a trailing '-' or '_'
 * off a URL. Spaces after the JSON's closing brace (which JSON.parse ignores) change the deflate
 * output; we add one at a time until the last character is alphanumeric.
 */
export async function encodeLetter(letter: Letter): Promise<string> {
  const payload = validateLetter({ ...letter });
  const json = JSON.stringify(payload);
  let encoded = '';
  for (let pad = 0; pad < PAD_TRIES; pad++) {
    const bytes = new TextEncoder().encode(json + ' '.repeat(pad));
    if (bytes.byteLength > MAX_DECOMPRESSED_BYTES) throw new LetterError('too-large', 'payload too large');
    encoded = LETTER_PREFIX + toBase64Url(await deflate(bytes));
    if (encoded.length > LETTER_CAP_BYTES) throw new LetterError('too-large', 'encoded letter over the cap');
    if (/[A-Za-z0-9]$/.test(encoded)) break;
  }
  return encoded;
}

/**
 * "v1.<base64url>" (a URL fragment without "#", or a file's text) → Letter, fully validated:
 * prefix, size cap, decompression limits, schema (R24), and that every op's runs cover the
 * document exactly. Throws LetterError('damaged' | 'too-large' | 'unsupported').
 *
 * A leading "#" is tolerated, and surrounding whitespace (a file's trailing newline) is trimmed.
 * The "v1." prefix is the version gate: any other prefix is 'unsupported'. An inner `v` other
 * than 1 under a v1 prefix is a malformed payload, so it is 'damaged'.
 */
export async function decodeLetter(encoded: string): Promise<Letter> {
  if (typeof encoded !== 'string') throw new LetterError('damaged');
  let s = encoded.trim();
  if (s.startsWith('#')) s = s.slice(1);
  if (!s.startsWith(LETTER_PREFIX)) throw new LetterError('unsupported', 'unknown letter version');
  if (s.length > LETTER_CAP_BYTES) throw new LetterError('too-large', 'encoded letter over the cap');
  const bytes = fromBase64Url(s.slice(LETTER_PREFIX.length));
  if (bytes.length === 0) throw new LetterError('damaged', 'empty payload');
  const json = await inflateCapped(bytes, MAX_DECOMPRESSED_BYTES);
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch {
    throw new LetterError('damaged', 'payload is not JSON');
  }
  return validateLetter(data);
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const TOP_KEYS = new Set(['v', 'baseText', 'ops', 'meta']);

/** Schema check (R24) of a parsed payload; returns a clean Letter (unknown meta keys dropped). */
export function validateLetter(data: unknown): Letter {
  const damaged = (why: string) => new LetterError('damaged', why);
  if (!isObj(data)) throw damaged('payload is not an object');
  for (const k of Object.keys(data)) if (!TOP_KEYS.has(k)) throw damaged(`unknown key ${k}`);
  if (data.v !== 1) throw damaged('payload version is not 1');
  const { baseText, ops } = data;
  // the editor normalizes line breaks to \n, so text with \r would desync replay from the log
  if (typeof baseText !== 'string' || baseText.includes('\r')) throw damaged('bad baseText');
  if (!Array.isArray(ops)) throw damaged('ops is not an array');
  if (ops.length > MAX_OPS || ops.length > MAX_REPLAY_STEPS) throw new LetterError('too-large', 'too many ops');
  // length-only tracking: linear, no string building
  let len = baseText.length;
  for (const op of ops as unknown[]) {
    if (!isValidOp(op, len)) throw damaged('op does not cover the document');
    const runs = runsOf(op);
    if (runs.some((r) => typeof r === 'string' && r.includes('\r'))) throw damaged('carriage return in op');
    len = targetLength(runs);
  }
  const letter: Letter = { v: 1, baseText, ops: ops as Op[] };
  if (data.meta !== undefined) {
    const m = data.meta;
    if (!isObj(m)) throw damaged('meta is not an object');
    const meta: LetterMeta = {};
    if (m.writtenAt !== undefined) {
      if (!isNum(m.writtenAt)) throw damaged('bad meta.writtenAt');
      meta.writtenAt = m.writtenAt;
    }
    if (m.tz !== undefined) {
      if (!isNum(m.tz)) throw damaged('bad meta.tz');
      meta.tz = m.tz;
    }
    letter.meta = meta;
  }
  return letter;
}

// ---------------------------------------------------------------------------------------------
// range

const clampStart = (start: number, n: number) => (Number.isFinite(start) ? Math.min(n, Math.max(0, Math.floor(start))) : 0);

const textOf = (s: string) => Text.of(s.split('\n'));

/** One op on a rope, O(runs × log n). Throws when its runs don't cover the document (as kop.apply). */
function applyRope(doc: Text, op: Op): Text {
  let pos = 0;
  for (const r of runsOf(op)) {
    if (typeof r === 'string') {
      doc = doc.replace(pos, pos, textOf(r));
      pos += r.length;
    } else if (r > 0) pos += r;
    else if (pos - r > doc.length) pos = Infinity;
    else doc = doc.replace(pos, pos - r, Text.empty);
    if (pos > doc.length) break;
  }
  if (pos !== doc.length) throw new Error('KOP op does not cover the document');
  return doc;
}

/**
 * Build a letter from a draft's history: base = text at op 0 (the draft's base snapshot, '' if
 * none), all ops, and the op index where replay starts. mode 'final' = final text only; pass
 * `finalText` (the draft's current text) to skip replaying the history for it.
 * `start` is clamped into [0, ops.length]. Throws when an op doesn't apply.
 */
export function buildLetter(
  base: string,
  ops: Op[],
  start: number,
  mode: 'replay' | 'final',
  meta?: LetterMeta,
  finalText?: string,
): Letter {
  const from = mode === 'final' ? ops.length : clampStart(start, ops.length);
  let baseText: string;
  if (mode === 'final' && finalText !== undefined) baseText = finalText;
  else {
    let doc = textOf(base);
    for (let i = 0; i < from; i++) doc = applyRope(doc, ops[i]!);
    baseText = doc.toString();
  }
  const letter: Letter = { v: 1, baseText, ops: ops.slice(from) };
  if (meta !== undefined) letter.meta = { ...meta };
  return letter;
}

/**
 * The text at each start point (op index, clamped into [0, ops.length]) in one forward pass, so
 * the send panel can move its slider without replaying the history each time. Keyed by the
 * points as given. Throws when an op doesn't apply.
 */
export function baseTexts(base: string, ops: Op[], points: number[]): Map<number, string> {
  const out = new Map<number, string>();
  const order = [...new Set(points)].map((p) => [p, clampStart(p, ops.length)] as const).sort((a, b) => a[1] - b[1]);
  let doc = textOf(base);
  let i = 0;
  for (const [p, at] of order) {
    for (; i < at; i++) doc = applyRope(doc, ops[i]!);
    out.set(p, doc.toString());
  }
  return out;
}

/** Default replay start (R16): the opIndex of the last session that contains ops; 0 if none. */
export function defaultStart(sessions: Session[], opCount: number): number {
  let best = 0;
  for (const s of sessions) if (s.opIndex < opCount && s.opIndex > best) best = s.opIndex;
  return best;
}

/** Session boundaries the "start replay from" slider snaps to (ascending, includes 0). */
export function startPoints(sessions: Session[], opCount: number): number[] {
  const set = new Set<number>([0]);
  for (const s of sessions) if (Number.isSafeInteger(s.opIndex) && s.opIndex >= 0 && s.opIndex < opCount) set.add(s.opIndex);
  return [...set].sort((a, b) => a - b);
}

/**
 * Meta for a letter whose replay starts at `start` in the full log: writtenAt = absolute start
 * time of ops[start] (or the last op's end when nothing replays), tz = that op's session offset.
 * Returns {} when the log has no sessions/ops to date it. writtenAt is left out when no session
 * starts at or before that op (opTimes would count it from clock 0, dating the letter to 1970).
 */
export function letterMeta(sessions: Session[], ops: Op[], start: number): LetterMeta {
  if (!ops.length || !sessions.length) return {};
  const times = opTimes(sessions, ops);
  const i = clampStart(start, ops.length);
  const idx = Math.min(i, ops.length - 1);
  const dated = sessions.some((s) => s.opIndex <= idx);
  const writtenAt = i < ops.length ? times[i]! : times[ops.length - 1]! + ops[ops.length - 1]![1];
  let tz = sessions[0]!.tzOffset;
  for (const s of sessions) if (s.opIndex <= idx) tz = s.tzOffset;
  const meta: LetterMeta = {};
  if (dated && Number.isFinite(writtenAt)) meta.writtenAt = writtenAt;
  if (Number.isFinite(tz)) meta.tz = tz;
  return meta;
}

// ---------------------------------------------------------------------------------------------
// pacing

/** dt over this is a thinking pause, replayed as REPLAY_PAUSE_CAP_MS (R12) */
export const REPLAY_PAUSE_OVER_MS = 4000;
export const REPLAY_PAUSE_CAP_MS = 1500;
/**
 * An op's `d` is untrusted: the reader honours at most this much per character typed (the
 * writer's merge window, so real recordings are never cut) and REPLAY_MAX_OP_MS per op. With
 * dt ≤ 4 s and MAX_REPLAY_STEPS ops, the clock stays far inside safe integers.
 */
export const REPLAY_MS_PER_CHAR = 1000;
export const REPLAY_MAX_OP_MS = 60_000;
/** a merged op's insert is spread over at most this many steps (longer ones land in chunks) */
export const REPLAY_MAX_STEPS_PER_OP = 256;

/** One replay step: `runs` applied at `at` ms from replay start, then the caret sits at `caret`. */
export interface ReplayStep {
  at: number;
  runs: Run[];
  /** caret position (UTF-16) after the step */
  caret: number;
}

/**
 * UTF-16 end offsets of the pieces `text` is typed in: one per code point, or at most `max`
 * evenly sized chunks when it has more (a surrogate pair is never split).
 */
function pieceEnds(text: string, max: number): number[] {
  const ends: number[] = [];
  if (text.length <= 2 * max) {
    let o = 0;
    for (const ch of text) ends.push((o += ch.length));
    if (ends.length <= max) return ends;
    ends.length = 0;
  }
  const n = Math.max(1, max);
  for (let j = 1; j <= n; j++) {
    let e = Math.round((j * text.length) / n);
    const c = text.charCodeAt(e - 1);
    if (e < text.length && c >= 0xd800 && c <= 0xdbff) e++; // keep the pair together
    if (e > (ends[ends.length - 1] ?? 0)) ends.push(e);
  }
  return ends;
}

/**
 * Replay pacing (R12, R18). `at` is ms from replay start. Each step's `runs` cover the document
 * as it stands after all earlier steps (apply them in order, starting from baseText), so a
 * reader can feed them to CodeMirror incrementally (never a full-text copy per step).
 *
 * Time model: an op starts `pause(dt)` after the previous op ended (pauses over 4 s are capped at
 * 1.5 s) and lasts `d` (capped: REPLAY_MS_PER_CHAR per character typed, REPLAY_MAX_OP_MS per op).
 * An op with several inserts, or none, is one step. For an op with exactly one insert, its
 * deletes (if any) are one step at the op's start, then piece i of k (a code point, or a chunk
 * when the insert has more than REPLAY_MAX_STEPS_PER_OP of them) lands at start + d·i/(k−1): the
 * first at the start, the last at the end, matching how the merged word was recorded. When d = 0
 * or there's one piece, the whole insert is one step. `at` is rounded to whole ms.
 *
 * Bounded for untrusted letters: never more than max(MAX_REPLAY_STEPS, ops.length) steps (and
 * decodeLetter refuses more ops than that); near the cap, ops stop being split.
 */
export function replaySteps(letter: Letter): ReplayStep[] {
  const steps: ReplayStep[] = [];
  const { ops } = letter;
  let len = letter.baseText.length;
  let clock = 0;
  let caret = len;
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi]!;
    const [dt] = op;
    clock += dt > REPLAY_PAUSE_OVER_MS ? REPLAY_PAUSE_CAP_MS : dt;
    const runs = runsOf(op);
    let inserts = 0;
    let typed = 0;
    let deletes = false;
    for (const r of runs) {
      if (typeof r === 'string') {
        inserts++;
        typed += r.length;
      } else if (r < 0) {
        deletes = true;
        typed -= r;
      }
    }
    const d = Math.min(op[1], REPLAY_MS_PER_CHAR * typed, REPLAY_MAX_OP_MS);
    // steps this op may use and still leave one for every later op
    const budget = Math.min(REPLAY_MAX_STEPS_PER_OP + 1, MAX_REPLAY_STEPS - steps.length - (ops.length - oi - 1));
    let text = '';
    let at = 0; // insert position after the op's deletes
    if (inserts === 1)
      for (const r of runs) {
        if (typeof r === 'string') text = r;
        else if (r > 0 && !text) at += r;
      }
    const onePiece = text.length === 1 || (text.length === 2 && text.codePointAt(0)! > 0xffff);
    if (inserts !== 1 || budget < 2 || d === 0 || onePiece) {
      // one step for the whole op (its pieces would all share one `at` anyway); caret after its
      // last insert, else at its last delete
      let pos = 0;
      let c = -1;
      for (const r of runs) {
        if (typeof r === 'string') c = pos += r.length;
        else if (r > 0) pos += r;
        else c = pos;
      }
      len = targetLength(runs);
      caret = c >= 0 ? c : Math.min(caret, len);
      steps.push({ at: Math.round(clock), runs, caret });
      clock += d;
      continue;
    }
    // single insert: (deletes) + its pieces spread over d
    if (deletes) {
      const rest = normalize(runs.filter((r) => typeof r !== 'string'));
      len = targetLength(rest);
      steps.push({ at: Math.round(clock), runs: rest, caret: at });
    }
    const ends = pieceEnds(text, Math.min(REPLAY_MAX_STEPS_PER_OP, budget - (deletes ? 1 : 0)));
    const k = ends.length;
    let from = 0;
    for (let i = 0; i < k; i++) {
      const piece = text.slice(from, ends[i]);
      from = ends[i]!;
      const tail = len - at;
      const stepRuns: Run[] = at > 0 ? [at, piece] : [piece];
      if (tail > 0) stepRuns.push(tail);
      at += piece.length;
      len += piece.length;
      steps.push({ at: Math.round(k > 1 ? clock + (d * i) / (k - 1) : clock), runs: stepRuns, caret: at });
    }
    caret = at;
    clock += d;
  }
  return steps;
}
