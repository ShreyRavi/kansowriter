import { opCoverage } from './kop';
import type { BackupData, BackupDraft, KansoFile } from './storage';
import type { Day } from './words';

export const BACKUP_EXTENSION = '.kansobackup';
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;

export class BackupError extends Error {}
export const NOT_A_BACKUP = 'That file isn’t a Kansowriter backup';

/**
 * A .kanso file: one draft with its whole history, in the backup's container (deflate-raw JSON,
 * the same caps and the same per-draft checks), marked `format: 'kanso'` so the two never mix up.
 */
export const KANSO_EXTENSION = '.kanso';
export const MAX_KANSO_BYTES = MAX_BACKUP_BYTES;
export const NOT_A_KANSO = 'That file isn’t a Kansowriter draft';
const TOO_LARGE_BACKUP = 'That backup is too large to open';
const TOO_LARGE_KANSO = 'That draft is too large to open';

async function compress(bytes: Uint8Array): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}

/** Inflate with a hard output cap, so a tiny crafted file can't expand into gigabytes. */
async function inflateCapped(bytes: Uint8Array, cap: number, tooLarge: string): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      throw new BackupError(tooLarge);
    }
    chunks.push(value);
  }
  return new Uint8Array(await new Blob(chunks as Uint8Array<ArrayBuffer>[]).arrayBuffer());
}

export async function encodeBackup(data: BackupData): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  if (json.byteLength > MAX_DECOMPRESSED_BYTES) throw new BackupError('Your drafts are too large for one backup file');
  const out = await compress(json);
  if (out.byteLength > MAX_BACKUP_BYTES) throw new BackupError('Your drafts are too large for one backup file');
  return out;
}

/** Inflate and parse an untrusted file, or throw BackupError with user-facing text. */
async function readContainer(bytes: Uint8Array, maxBytes: number, tooLarge: string, notOne: string): Promise<unknown> {
  if (bytes.byteLength > maxBytes) throw new BackupError(tooLarge);
  try {
    return JSON.parse(new TextDecoder().decode(await inflateCapped(bytes, MAX_DECOMPRESSED_BYTES, tooLarge)));
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(notOne);
  }
}

function check<T>(data: unknown, valid: (x: unknown) => x is T, notOne: string): T {
  try {
    if (!valid(data)) throw new BackupError(notOne);
  } catch (e) {
    throw e instanceof BackupError ? e : new BackupError(notOne);
  }
  return data as T;
}

/** Decode and validate an untrusted backup file. Throws BackupError with user-facing text (9A). */
export async function decodeBackup(bytes: Uint8Array): Promise<BackupData> {
  return check(await readContainer(bytes, MAX_BACKUP_BYTES, TOO_LARGE_BACKUP, NOT_A_BACKUP), isBackup, NOT_A_BACKUP);
}

export async function encodeKanso(draft: BackupDraft, now = Date.now()): Promise<Uint8Array> {
  const file: KansoFile = { format: 'kanso', v: 1, exportedAt: now, draft };
  const json = new TextEncoder().encode(JSON.stringify(file));
  if (json.byteLength > MAX_DECOMPRESSED_BYTES) throw new BackupError('This draft is too large for one file');
  const out = await compress(json);
  if (out.byteLength > MAX_KANSO_BYTES) throw new BackupError('This draft is too large for one file');
  return out;
}

/** Decode and validate an untrusted .kanso file: the backup's caps and checks, for its one draft. */
export async function decodeKanso(bytes: Uint8Array): Promise<KansoFile> {
  return check(await readContainer(bytes, MAX_KANSO_BYTES, TOO_LARGE_KANSO, NOT_A_KANSO), isKanso, NOT_A_KANSO);
}

/**
 * What Import accepts: a backup (every draft) or a .kanso (one draft), told apart by the format
 * marker inside, never by the file name.
 */
export async function decodeImport(bytes: Uint8Array): Promise<{ kind: 'backup'; data: BackupData } | { kind: 'draft'; file: KansoFile }> {
  const data = await readContainer(bytes, Math.max(MAX_BACKUP_BYTES, MAX_KANSO_BYTES), TOO_LARGE_BACKUP, NOT_A_BACKUP);
  if (isObj(data) && data.format === 'kanso') return { kind: 'draft', file: check(data, isKanso, NOT_A_KANSO) };
  return { kind: 'backup', data: check(data, isBackup, NOT_A_BACKUP) };
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

function isBackup(x: unknown): x is BackupData {
  if (!isObj(x) || x.format !== 'kansobackup' || x.v !== 1 || !Array.isArray(x.drafts) || !Array.isArray(x.days)) return false;
  const ids = new Set<string>();
  for (const d of x.drafts) {
    if (!isDraft(d) || ids.has(d.record.id)) return false;
    ids.add(d.record.id);
  }
  const keys = new Set<string>();
  for (const day of x.days) {
    if (!isDay(day) || keys.has(day.key)) return false;
    keys.add(day.key);
  }
  return true;
}

function isKanso(x: unknown): x is KansoFile {
  return isObj(x) && x.format === 'kanso' && x.v === 1 && isNum(x.exportedAt) && isDraft(x.draft);
}

function isDraft(d: unknown): d is BackupDraft {
  if (!isObj(d) || !isObj(d.record) || !Array.isArray(d.ops) || !Array.isArray(d.snapshots)) return false;
  const r = d.record;
  if (typeof r.id !== 'string' || !r.id || r.v !== 1 || !isNum(r.createdAt) || !isNum(r.updatedAt)) return false;
  if (!isObj(r.meta) || typeof r.meta.title !== 'string' || typeof r.meta.excerpt !== 'string' || !isInt(r.meta.words)) return false;
  if (!Array.isArray(r.sessions)) return false;
  let prev = -1;
  for (const s of r.sessions) {
    // strictly increasing, and each session starts at a real op
    if (!isObj(s) || !isInt(s.opIndex) || s.opIndex <= prev || s.opIndex >= d.ops.length || !isNum(s.at) || !isNum(s.tzOffset))
      return false;
    prev = s.opIndex;
  }
  for (const s of d.snapshots) {
    if (!isObj(s) || !isInt(s.opIndex) || s.opIndex > d.ops.length || typeof s.text !== 'string' || s.text.includes('\r')) return false;
  }
  for (const op of d.ops) {
    // shape only: whether the ops replay is the importer's call, per draft, so one damaged draft
    // (which Export all still writes) leaves just that draft out instead of the whole file.
    // The editor normalizes line breaks to \n, so text with \r would desync it from the log.
    if (opCoverage(op) === null || (op as unknown[]).some((r) => typeof r === 'string' && r.includes('\r'))) return false;
  }
  return true;
}

function isDay(day: unknown): day is Day {
  return (
    isObj(day) &&
    typeof day.key === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(day.key) &&
    isNum(day.B) &&
    isNum(day.peak) &&
    isNum(day.resetOffset)
  );
}

/** File name with the local date (not UTC), e.g. kansowriter-2026-10-23.kansobackup */
export function backupFileName(now: number, tzOffset = new Date(now).getTimezoneOffset()): string {
  return `kansowriter-${new Date(now - tzOffset * 60_000).toISOString().slice(0, 10)}${BACKUP_EXTENSION}`;
}
