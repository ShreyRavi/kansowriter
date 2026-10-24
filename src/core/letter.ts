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
 * CONTRACT for v0.1 (implementations fill these in; signatures are fixed so core and UI can be
 * built in parallel).
 */
import type { Op, Run } from './kop';
import type { Session } from './draft';

/** encoded size cap, links and .kansoletter files alike (R13) */
export const LETTER_CAP_BYTES = 256 * 1024;
/** links above this suggest trimming or a file (tuned by scripts/measure-letters.ts) */
export const LINK_THRESHOLD_BYTES = 8 * 1024;
/** decoder limits (untrusted input) */
export const MAX_DECOMPRESSED_BYTES = 2 * 1024 * 1024;
export const MAX_OPS = 200_000;
export const LETTER_PREFIX = 'v1.';
export const LETTER_FILE_EXTENSION = '.kansoletter';

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
  constructor(readonly kind: LetterErrorKind, message?: string) {
    super(message ?? kind);
  }
}

/** true when the browser can decode letters (DecompressionStream deflate-raw) (R14) */
export function lettersSupported(): boolean {
  throw new Error('not implemented');
}

/** Letter → "v1.<base64url>". Throws LetterError('too-large') over LETTER_CAP_BYTES. */
export async function encodeLetter(_letter: Letter): Promise<string> {
  throw new Error('not implemented');
}

/**
 * "v1.<base64url>" (a URL fragment without "#", or a file's text) → Letter, fully validated:
 * prefix, size cap, decompression limits, schema (R24), and that every op's runs cover the
 * document exactly. Throws LetterError('damaged' | 'too-large' | 'unsupported').
 */
export async function decodeLetter(_encoded: string): Promise<Letter> {
  throw new Error('not implemented');
}

/**
 * Build a letter from a draft's history: base = text at op 0 (the draft's base snapshot, '' if
 * none), all ops, and the op index where replay starts. mode 'final' = final text only.
 */
export function buildLetter(
  _base: string,
  _ops: Op[],
  _start: number,
  _mode: 'replay' | 'final',
  _meta?: LetterMeta,
): Letter {
  throw new Error('not implemented');
}

/** Default replay start (R16): the opIndex of the last session that contains ops; 0 if none. */
export function defaultStart(_sessions: Session[], _opCount: number): number {
  throw new Error('not implemented');
}

/** Session boundaries the "start replay from" slider snaps to (ascending, includes 0). */
export function startPoints(_sessions: Session[], _opCount: number): number[] {
  throw new Error('not implemented');
}

/**
 * Replay pacing (R12, R18). `at` is ms from replay start. Each step's `runs` cover the document
 * as it stands after all earlier steps (apply them in order, starting from baseText), so a
 * reader can feed them to CodeMirror incrementally (never a full-text copy per step). Pauses
 * (dt) over 4 s are capped at 1.5 s; a merged op's inserted characters are spread evenly across
 * its d, one step per character (a surrogate pair is never split); other ops are one step.
 */
export interface ReplayStep {
  at: number;
  runs: Run[];
  /** caret position (UTF-16) after the step */
  caret: number;
}
export function replaySteps(_letter: Letter): ReplayStep[] {
  throw new Error('not implemented');
}
