import { BACKUP_EXTENSION, BackupError, backupFileName, decodeBackup, encodeBackup } from '../core/backup';
import type { StorageAdapter } from '../core/storage';
import { download, pickFile } from './platform';

/** Export all drafts as one .kansobackup (R21). Returns the in-place feedback label (9A). */
export async function exportAll(storage: StorageAdapter, onExported: (at: number) => void): Promise<string> {
  try {
    const now = Date.now();
    const bytes = await encodeBackup(await storage.exportAll());
    const name = backupFileName(now);
    download(name, bytes as Uint8Array<ArrayBuffer>, 'application/octet-stream');
    onExported(now);
    return `Saved ${name}`;
  } catch (e) {
    return e instanceof BackupError ? e.message : 'Your browser blocked the download. Try again';
  }
}

/** Import a .kansobackup; returns the feedback label and whether anything was added. */
export async function importBackup(storage: StorageAdapter): Promise<{ label: string; added: number } | null> {
  const file = await pickFile(`${BACKUP_EXTENSION},application/octet-stream`);
  if (!file) return null;
  try {
    const data = await decodeBackup(new Uint8Array(await file.arrayBuffer()));
    const { added, skipped } = await storage.importAll(data);
    if (!added) return { label: `Nothing new: all ${skipped} draft${skipped === 1 ? ' is' : 's are'} already here`, added };
    return { label: `Added ${added} draft${added === 1 ? '' : 's'}${skipped ? `, skipped ${skipped} already here` : ''}`, added };
  } catch (e) {
    return { label: e instanceof BackupError ? e.message : 'That file isn’t a Kansowriter backup', added: 0 };
  }
}
