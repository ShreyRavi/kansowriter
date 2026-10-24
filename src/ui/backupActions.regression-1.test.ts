// Regression: a valid backup that fails to store was reported as "That file isn’t a Kansowriter backup"
// Found by the /ship coverage audit on 2026-10-24
// Value: protects=a storage failure while restoring a valid backup says the device's storage failed, not that the file is wrong;
//   fails_when=importAll errors fall back into the not-a-backup label again; why_new=the coverage test only asserts some label;
//   seam=none; no_claim=a real quota error (importAll rejects in a fake)
import { describe, expect, it, vi } from 'vitest';
import { encodeBackup } from '../core/backup';
import type { StorageAdapter } from '../core/storage';

const platform = vi.hoisted(() => ({ download: vi.fn(), pickFile: vi.fn() }));
vi.mock('./platform', () => platform);
const { importBackup } = await import('./backupActions');

describe('importBackup storage failure', () => {
  it('blames storage, not the file, when a valid backup cannot be written', async () => {
    const bytes = await encodeBackup({ format: 'kansobackup', v: 1, exportedAt: 0, drafts: [], days: [] });
    platform.pickFile.mockResolvedValue(new File([bytes as Uint8Array<ArrayBuffer>], 'x.kansobackup'));
    const storage = { importAll: () => Promise.reject(new DOMException('full', 'QuotaExceededError')) } as unknown as StorageAdapter;
    expect(await importBackup(storage)).toEqual({ label: 'Couldn’t restore: this device’s storage is full or unavailable', added: 0 });
  });
});
