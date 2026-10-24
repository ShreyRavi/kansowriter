import { BACKUP_EXTENSION, BackupError, backupFileName, decodeBackup, encodeBackup } from '../core/backup';
import type { ImportResult, StorageAdapter } from '../core/storage';
import type { DraftWriter } from '../storage/writer';
import { download, pickFile } from './platform';

/**
 * Export all drafts as one .kansobackup (R21). Returns the in-place feedback label (9A).
 * The open draft's writer is flushed first; if it still can't save, the file is written but the
 * export-age reminder is NOT reset, and the label says the backup misses the newest text.
 */
export async function exportAll(storage: StorageAdapter, onExported: (at: number) => void, writer?: DraftWriter | null): Promise<string> {
  try {
    if (writer) await writer.flush(true);
    const unsaved = writer?.dirty ?? false;
    const now = Date.now();
    const bytes = await encodeBackup(await storage.exportAll());
    const name = backupFileName(now);
    download(name, bytes as Uint8Array<ArrayBuffer>, 'application/octet-stream');
    if (unsaved) return `Saved ${name}, without your newest unsaved words`;
    onExported(now);
    return `Saved ${name}`;
  } catch (e) {
    return e instanceof BackupError ? e.message : 'Your browser blocked the download. Try again';
  }
}

const drafts = (n: number) => `${n} draft${n === 1 ? '' : 's'}`;

export function importLabel({ added, copies, skipped, damaged }: ImportResult): string {
  const parts: string[] = [];
  if (added - copies) parts.push(`Added ${drafts(added - copies)}`);
  if (copies) parts.push(`${parts.length ? 'added' : 'Added'} ${copies} changed draft${copies === 1 ? ' as a copy' : 's as copies'}`);
  if (skipped && parts.length) parts.push(`skipped ${skipped} already here`);
  if (damaged) parts.push(`${parts.length ? 'left out' : 'Left out'} ${drafts(damaged)} that couldn’t be read`);
  if (!parts.length) return `Nothing new: all ${drafts(skipped)} ${skipped === 1 ? 'is' : 'are'} already here`;
  return parts.join(', ');
}

/** Import a .kansobackup; returns the feedback label and how many drafts were added. */
export async function importBackup(storage: StorageAdapter): Promise<{ label: string; added: number } | null> {
  const file = await pickFile(`${BACKUP_EXTENSION},application/octet-stream`);
  if (!file) return null;
  try {
    const data = await decodeBackup(new Uint8Array(await file.arrayBuffer()));
    const r = await storage.importAll(data);
    return { label: importLabel(r), added: r.added };
  } catch (e) {
    return { label: e instanceof BackupError ? e.message : 'That file isn’t a Kansowriter backup', added: 0 };
  }
}
