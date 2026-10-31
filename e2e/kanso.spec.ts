// Value: protects=a draft saved as a .kanso from the palette comes back with its whole history (every op and
//   session, so replay and letters work) on a fresh device, and importing it where the draft already is opens
//   that draft instead of duplicating it; fails_when=exportDraft/encodeKanso/decodeImport/importDraft or the
//   palette rows or the landing restore path break anywhere in the chain; why_new=kanso.test.ts covers the
//   codec and adapter only; seam=none; no_claim=the macOS save panel or Finder opening (desktop-only, probed)
import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import { freshStart, mod, requestedName, runCommand, settle, startWriting, write } from './helpers';
import type { Page } from '@playwright/test';

/** Every draft's record and ops, straight from IndexedDB. */
const history = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const q = indexedDB.open('kansowriter');
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    const all = <T>(store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => resolve(q.result as T[]);
        q.onerror = () => reject(q.error);
      });
    type Rec = { id: string; head: number; sessions: unknown[]; meta: { title: string } };
    const drafts = await all<Rec>('drafts');
    const ops = await all<{ draftId: string; seq: number; op: unknown[] }>('ops');
    db.close();
    return drafts.map((d) => ({
      id: d.id,
      title: d.meta.title,
      head: d.head,
      sessions: d.sessions,
      ops: ops
        .filter((o) => o.draftId === d.id)
        .sort((a, b) => a.seq - b.seq)
        .map((o) => o.op),
    }));
  });

test('Save as Kansowriter file, then open it on a fresh start: the draft and its whole history come back', async ({ page }, testInfo) => {
  const editor = await startWriting(page);
  await write(page, editor, '# Field notes\n\nThe heron waited.');
  await settle(page);
  const before = await history(page);
  expect(before).toHaveLength(1);
  expect(before[0]!.ops.length).toBeGreaterThan(3);

  await page.keyboard.press(`${await mod(page)}+k`);
  const downloading = page.waitForEvent('download');
  await runCommand(page, 'kanso', /Save as Kansowriter file/);
  const download = await downloading;
  expect(requestedName(download)).toBe('Field notes.kanso');
  const file = testInfo.outputPath('Field notes.kanso');
  await download.saveAs(file);
  await expect(page.getByRole('option', { name: /Save as Kansowriter file/ })).toContainText('Saved Field notes.kanso');
  // a .kanso is the backup container (deflate-raw), never plain JSON or Markdown
  expect(readFileSync(file).subarray(0, 1).toString()).not.toBe('{');

  // importing it where the draft already is opens that draft, no duplicate
  const choosing = page.waitForEvent('filechooser');
  await runCommand(page, 'import', /Import backup/);
  await (await choosing).setFiles(file);
  await expect(page.getByRole('option', { name: /Import backup/ })).toContainText('Opened the draft already here');
  expect(await history(page)).toHaveLength(1);

  await freshStart(page);
  await page.goto('/');
  const restoring = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Restore from a backup' }).click();
  await (await restoring).setFiles(file);

  const restored = page.getByRole('textbox', { name: 'Draft' });
  await expect(restored).toContainText('The heron waited.');
  await expect(page.locator('.header .title')).toHaveText('Field notes');
  await expect(restored).toHaveAttribute('contenteditable', 'true');
  const after = await history(page);
  expect(after).toHaveLength(1);
  // the same draft (id), every op and session: replay and letters see the same history
  expect(after[0]).toEqual(before[0]);
});
