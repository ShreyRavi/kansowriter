import { isValidOp, apply, type Op } from './kop';
import type { BackupData } from './storage';

export const BACKUP_EXTENSION = '.kansobackup';
const MAX_BACKUP_BYTES = 200 * 1024 * 1024;

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeBackup(data: BackupData): Promise<Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify(data));
  return pipe(json, new CompressionStream('deflate-raw'));
}

export class BackupError extends Error {}

/** Decode and validate an untrusted backup file. Throws BackupError with user-facing text (9A). */
export async function decodeBackup(bytes: Uint8Array): Promise<BackupData> {
  if (bytes.byteLength > MAX_BACKUP_BYTES) throw new BackupError('That file is too large to be a Kansowriter backup');
  let data: unknown;
  try {
    const raw = await pipe(bytes, new DecompressionStream('deflate-raw'));
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new BackupError('That file isn’t a Kansowriter backup');
  }
  if (!isBackup(data)) throw new BackupError('That file isn’t a Kansowriter backup');
  return data;
}

function isBackup(x: unknown): x is BackupData {
  if (typeof x !== 'object' || x === null) return false;
  const d = x as Partial<BackupData>;
  if (d.format !== 'kansobackup' || d.v !== 1 || !Array.isArray(d.drafts) || !Array.isArray(d.days)) return false;
  for (const dr of d.drafts) {
    if (!dr || typeof dr.record?.id !== 'string' || !Array.isArray(dr.ops) || !Array.isArray(dr.snapshots)) return false;
    // ops must replay from empty (history may start at a snapshot at opIndex 0 after clear-history)
    const base = dr.snapshots.find((s) => s.opIndex === 0)?.text ?? '';
    let text = base;
    for (const op of dr.ops as Op[]) {
      if (!isValidOp(op, text.length)) return false;
      text = apply(text, op);
    }
  }
  return true;
}

export function backupFileName(now: number): string {
  return `kansowriter-${new Date(now).toISOString().slice(0, 10)}${BACKUP_EXTENSION}`;
}
