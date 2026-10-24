// Following another tab, by this tab's state × what the tab holding the draft does. Only a plain
// read-only view follows (other-tab, or after handing the draft over); a stale view (words storage
// lacks) and a read-only error view (damaged / couldn't open) are never replaced or navigated away.
// Two pages of one browser context stand in for two windows (BroadcastChannel and Web Locks are real).
import { expect, test, type Page } from '@playwright/test';
import { mod, removeDraftsUnderneath, runCommand, savedState, settle, startWriting, write } from './helpers';

const draft = (page: Page) => page.getByRole('textbox', { name: 'Draft' });
const readOnlyNotice = (page: Page) => page.getByText('Open in another tab.');
const landing = (page: Page) => page.getByRole('heading', { name: 'A quiet place to write.' });
/** the follower's whole text (CodeMirror only renders lines near the viewport) */
const viewText = async (page: Page) => (await savedState(page)).editor;

async function readOnlySecond(page: Page) {
  const second = await page.context().newPage();
  await second.goto('/');
  await expect(readOnlyNotice(second)).toBeVisible();
  await expect(draft(second)).toHaveAttribute('contenteditable', 'false');
  return second;
}

/** The open draft's stored row, read straight from IndexedDB (for a hand-made broadcast). */
const storedRecord = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('kansowriter');
      q.onsuccess = () => r(q.result);
    });
    const rows = await new Promise<{ id: string }[]>((r) => {
      const q = db.transaction('drafts').objectStore('drafts').getAll();
      q.onsuccess = () => r(q.result);
    });
    db.close();
    return rows[0]!;
  });

/** Another page of the same origin announces a commit and a delete of `record`'s draft. */
async function broadcastCommitAndDelete(from: Page, record: { id: string }) {
  await from.evaluate((record) => {
    const bc = new BroadcastChannel('kansowriter');
    bc.postMessage({ type: 'committed', draftId: record.id, record });
    bc.postMessage({ type: 'deleted', draftId: record.id });
    bc.close();
  }, record);
  // a "never happens" check: give a follow (coalesced 300 ms, then a load) ample time to run
  await from.waitForTimeout(1500);
}

test('read-only × holder commits: the read-only tab follows without moving its scroll', async ({ page }) => {
  const editor = await startWriting(page);
  // long enough to scroll: a line at a time (WebKit drops newlines inside one insertText)
  await editor.pressSequentially('Long');
  const phone = page.viewportSize()!.width < 640;
  for (let i = 1; i <= 60; i++) {
    if (phone) await page.keyboard.insertText('\n');
    else await page.keyboard.press('Enter');
    await page.keyboard.insertText(`Line ${i} of a long draft.`);
  }
  await settle(page);
  const second = await readOnlySecond(page);
  await expect.poll(() => viewText(second)).toBe((await savedState(page)).editor);
  await second.evaluate(() => window.scrollTo(0, 300));
  const scrolled = await second.evaluate(() => window.scrollY);
  expect(scrolled, 'the read-only tab scrolled into the draft').toBeGreaterThan(100);

  await editor.pressSequentially(' more');
  await settle(page);
  const holderText = (await savedState(page)).editor!;
  expect(holderText, JSON.stringify(holderText.slice(0, 80) + '…' + holderText.slice(-60))).toMatch(/long draft\. more$/);
  await expect.poll(() => viewText(second), { timeout: 5000 }).toBe(holderText);
  await expect(draft(second)).toHaveAttribute('contenteditable', 'false');
  await expect(readOnlyNotice(second)).toBeVisible();
  expect(Math.abs((await second.evaluate(() => window.scrollY)) - scrolled)).toBeLessThanOrEqual(2);
});

test('read-only × holder deletes: the read-only tab leaves the editor', async ({ page }) => {
  const editor = await startWriting(page);
  await editor.pressSequentially('soon gone');
  await settle(page);
  const second = await readOnlySecond(page);
  await page.keyboard.press(`${await mod(page)}+k`);
  await runCommand(page, 'delete draft', /Delete draft/);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(landing(page)).toBeVisible();
  await expect(landing(second)).toBeVisible({ timeout: 5000 });
  await expect(draft(second)).toHaveCount(0);
});

test('handed-over × new holder commits: the tab that handed over follows', async ({ page }) => {
  const editor = await startWriting(page);
  await editor.pressSequentially('shared draft');
  await settle(page);
  const second = await readOnlySecond(page);
  await second.getByRole('button', { name: 'Open here instead' }).click();
  await expect(draft(second)).toHaveAttribute('contenteditable', 'true');
  await expect(readOnlyNotice(page)).toBeVisible();
  await expect(draft(page)).toHaveAttribute('contenteditable', 'false');

  await draft(second).click();
  await second.keyboard.press('End');
  await draft(second).pressSequentially(' from the second tab');
  await settle(second);
  await expect(draft(page)).toHaveText('shared draft from the second tab', { timeout: 5000 });
  await expect(readOnlyNotice(page)).toBeVisible();
});

test('stale × committed/deleted broadcasts: the stale view keeps its words and stays', async ({ page }) => {
  const editor = await startWriting(page);
  await write(page, editor, 'first words');
  await settle(page);
  const record = await storedRecord(page);
  await removeDraftsUnderneath(page);
  await editor.pressSequentially(' second');
  await expect(page.getByText('This tab stopped saving.')).toBeVisible({ timeout: 10_000 });

  const other = await page.context().newPage();
  await other.goto('/about');
  await broadcastCommitAndDelete(other, record);
  await expect(page.getByText('This tab stopped saving.')).toBeVisible();
  await expect(draft(page)).toHaveText('first words second');
  await expect(landing(page)).toHaveCount(0);
});

test('read-only error (damaged) × committed/deleted broadcasts: the notice stays, no navigation', async ({ page }) => {
  const editor = await startWriting(page);
  await write(page, editor, 'readable text');
  await settle(page);
  // an op whose runs don't cover the document, as a corrupt log would (see damaged-history.spec.ts)
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('kansowriter');
      q.onsuccess = () => r(q.result);
    });
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(['drafts', 'ops'], 'readwrite');
      const drafts = t.objectStore('drafts');
      const all = drafts.getAll();
      all.onsuccess = () => {
        const rec = all.result[0];
        t.objectStore('ops').put({ draftId: rec.id, seq: rec.head, op: [0, 0, 9999, 'x'] });
        drafts.put({ ...rec, head: rec.head + 1 });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    db.close();
  });
  await page.reload();
  const damaged = page.getByText('Part of this draft’s history is damaged.');
  await expect(damaged).toBeVisible();
  const record = await storedRecord(page);

  const other = await page.context().newPage();
  await other.goto('/about');
  await broadcastCommitAndDelete(other, record);
  await expect(damaged).toBeVisible();
  await expect(draft(page)).toContainText('readable text');
  await expect(draft(page)).toHaveAttribute('contenteditable', 'false');
  await expect(landing(page)).toHaveCount(0);
});
