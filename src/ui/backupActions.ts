import {
  BACKUP_EXTENSION,
  BackupError,
  KANSO_EXTENSION,
  NOT_A_BACKUP,
  backupFileName,
  decodeImport,
  encodeBackup,
  encodeKanso,
} from '../core/backup';
import type { ImportResult, StorageAdapter } from '../core/storage';
import type { DraftWriter } from '../storage/writer';
import { download, pickFile, safeFileName } from './platform';

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
  if (!added && !skipped && !damaged) return 'That backup has no drafts';
  const parts: string[] = [];
  if (added - copies) parts.push(`Added ${drafts(added - copies)}`);
  if (copies) parts.push(`${parts.length ? 'added' : 'Added'} ${copies} changed draft${copies === 1 ? ' as a copy' : 's as copies'}`);
  if (skipped && parts.length) parts.push(`skipped ${skipped} already here`);
  if (!added && skipped)
    parts.push(`Nothing new: ${damaged ? `${skipped}` : `all ${drafts(skipped)}`} ${skipped === 1 ? 'is' : 'are'} already here`);
  if (damaged) parts.push(`${parts.length ? 'left out' : 'Left out'} ${drafts(damaged)} that couldn’t be read`);
  return parts.join(', ');
}

export interface ImportOutcome {
  label: string;
  added: number;
  damaged?: number;
  /** a .kanso: the draft to open (already here, added, or added as a copy) */
  openId?: string;
}

/**
 * Import a .kansobackup (every draft) or a .kanso (one draft with its history); returns the
 * feedback label, how many drafts were added and how many left out, and for a .kanso the draft
 * to open. `file` skips the picker (a file dropped on the page).
 */
export async function importBackup(storage: StorageAdapter, picked?: File): Promise<ImportOutcome | null> {
  const file = picked ?? (await pickFile(`${BACKUP_EXTENSION},${KANSO_EXTENSION},application/octet-stream`));
  if (!file) return null;
  let decoded;
  try {
    decoded = await decodeImport(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    return { label: e instanceof BackupError ? e.message : NOT_A_BACKUP, added: 0 };
  }
  try {
    if (decoded.kind === 'draft') {
      const r = await storage.importDraft(decoded.file.draft);
      if (r.status === 'damaged') return { label: 'That draft’s history couldn’t be read', added: 0, damaged: 1 };
      const label = { existing: 'Opened the draft already here', added: 'Added the draft', copy: 'Added the draft as a copy' }[r.status];
      return { label, added: r.status === 'existing' ? 0 : 1, openId: r.id };
    }
    const r = await storage.importAll(decoded.data);
    return { label: importLabel(r), added: r.added, damaged: r.damaged };
  } catch (e) {
    // a valid backup that this device couldn't store (quota, IndexedDB error) is not "not a backup"
    return { label: e instanceof BackupError ? e.message : 'Couldn’t restore: this device’s storage is full or unavailable', added: 0 };
  }
}

/**
 * Save the open draft with its whole history as a .kanso: the writer is flushed first so the
 * file ends where the page does. `save` downloads it (web) or shows a save panel (macOS); its
 * label (null when cancelled) is the row's feedback.
 */
export async function exportKanso(
  storage: StorageAdapter,
  draftId: string,
  writer: DraftWriter | null,
  save: (name: string, bytes: Uint8Array) => Promise<string | null>,
): Promise<string | null> {
  try {
    if (writer) await writer.flush(true);
    const unsaved = writer?.dirty ?? false;
    const draft = await storage.exportDraft(draftId);
    if (!draft) return 'This draft is gone';
    const bytes = await encodeKanso(draft);
    const label = await save(safeFileName(draft.record.meta.title), bytes);
    return label && unsaved ? `${label}, without your newest unsaved words` : label;
  } catch (e) {
    return e instanceof BackupError ? e.message : 'Couldn’t save the file. Try again';
  }
}

/** The web's .kanso save: a download, as exports are. */
export async function downloadKanso(name: string, bytes: Uint8Array): Promise<string> {
  const file = `${name}${KANSO_EXTENSION}`;
  download(file, bytes as Uint8Array<ArrayBuffer>, 'application/octet-stream');
  return `Saved ${file}`;
}
