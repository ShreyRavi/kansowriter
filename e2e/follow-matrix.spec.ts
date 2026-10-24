// Following another tab, by this tab's state × what the tab holding the draft does. Only a plain
// read-only view follows (other-tab, or after handing the draft over); a stale view (words storage
// lacks) and a read-only error view (damaged / couldn't open) are never replaced or navigated away.
// Two pages of one browser context stand in for two windows (BroadcastChannel and Web Locks are real).
import { expect, test, type Page } from '@playwright/test';
import { mod, removeDraftsUnderneath, runCommand, savedState, setVisibility, settle, startWriting, write } from './helpers';

const draft = (page: Page) => page.getByRole('textbox', { name: 'Draft' });
const readOnlyNotice = (page: Page) => page.getByText('Open in another tab.');
const landing = (page: Page) => page.getByRole('heading', { name: 'A quiet place to write.' });
/** the follower's whole text (CodeMirror only renders lines near the viewport) */
const viewText = async (page: Page) => (await savedState(page)).editor;
/** the same, without touching IndexedDB (a page whose writes are stalled queues its own reads behind them) */
const shownText = (page: Page) =>
  page.evaluate(() => {
    type Node = { root?: { view?: View }; rootView?: { view?: View }; view?: View };
    type View = { state: { doc: { toString(): string } } };
    const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: Node; cmView?: Node }) | null;
    const tile = content?.cmTile ?? content?.cmView;
    return (tile?.root?.view ?? tile?.rootView?.view ?? tile?.view)?.state.doc.toString() ?? null;
  });

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

/** The stored row plus how many ops it has: what a refused repair must leave untouched. */
const storedHistory = (page: Page) =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('kansowriter');
      q.onsuccess = () => r(q.result);
    });
    const get = <T>(store: string) =>
      new Promise<T[]>((r) => {
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => r(q.result as T[]);
      });
    const [drafts, ops] = await Promise.all([get<{ id: string; head: number; epoch: string }>('drafts'), get<unknown>('ops')]);
    db.close();
    return { id: drafts[0]!.id, head: drafts[0]!.head, epoch: drafts[0]!.epoch, ops: ops.length };
  });

/** Append an op whose runs don't cover the document, as a corrupt log would (see damaged-history.spec.ts), and reopen. */
async function damage(page: Page) {
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
  const notice = page.getByText('Part of this draft’s history is damaged.');
  await expect(notice).toBeVisible();
  return notice;
}

/** Another page of the same origin announces a commit of `record`'s draft. */
async function broadcastCommit(from: Page, record: { id: string }) {
  await from.evaluate((record) => {
    const bc = new BroadcastChannel('kansowriter');
    bc.postMessage({ type: 'committed', draftId: record.id, record });
    bc.close();
  }, record);
}

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

  // handed-over × holder deletes: the tab that handed over leaves the editor too
  await second.keyboard.press(`${await mod(second)}+k`);
  await runCommand(second, 'delete draft', /Delete draft/);
  await second.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(landing(second)).toBeVisible();
  await expect(landing(page)).toBeVisible({ timeout: 5000 });
  await expect(draft(page)).toHaveCount(0);
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
  const damaged = await damage(page);
  const record = await storedRecord(page);

  const other = await page.context().newPage();
  await other.goto('/about');
  await broadcastCommitAndDelete(other, record);
  await expect(damaged).toBeVisible();
  await expect(draft(page)).toContainText('readable text');
  await expect(draft(page)).toHaveAttribute('contenteditable', 'false');
  await expect(landing(page)).toHaveCount(0);
});

test('read-only × commit while hidden: nothing follows until the tab is visible, then it catches up', async ({ page }) => {
  const editor = await startWriting(page);
  await editor.pressSequentially('seen');
  await settle(page);
  const second = await readOnlySecond(page);
  await expect.poll(() => viewText(second)).toBe('seen');
  // let the catch-up it scheduled on opening run first (coalesced 300 ms, then a load): no signal to poll
  await second.waitForTimeout(1000);

  await setVisibility(second, 'hidden');
  await editor.pressSequentially(' while away');
  await settle(page);
  await second.waitForTimeout(1500); // a follow (coalesced 300 ms, then a load) would have run by now
  expect(await viewText(second)).toBe('seen');

  await setVisibility(second, 'visible');
  await expect.poll(() => viewText(second), { timeout: 5000 }).toBe('seen while away');
  await expect(readOnlyNotice(second)).toBeVisible();
});

test('handing-over × holder commits/deletes: nothing follows until the final write released, then it catches up and leaves', async ({
  page,
}) => {
  // counts this page's read transactions over the draft's ops (what a follow's load opens), once
  // __followLoads is set; installed before the app opens IndexedDB (Dexie binds transaction() at open)
  await page.addInitScript(() => {
    const w = window as unknown as { __followLoads?: number };
    const real = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...a: Parameters<typeof real>) {
      if (w.__followLoads !== undefined && (a[1] ?? 'readonly') === 'readonly' && [a[0]].flat().includes('ops')) w.__followLoads++;
      return real.apply(this, a);
    };
  });
  const editor = await startWriting(page);
  await editor.pressSequentially('shared');
  await settle(page);
  const second = await readOnlySecond(page);
  const record = await storedRecord(page); // read now: while writes stall, reads queue behind them
  // the requester waits as long as the test needs (it would steal after 2 s, ending the handover)
  await second.evaluate(() => {
    const real = window.setTimeout;
    window.setTimeout = ((f: TimerHandler, ms?: number, ...a: unknown[]) => real(f, ms === 2000 ? 60_000 : ms, ...a)) as typeof setTimeout;
  });
  // stall this tab's writes: a readwrite transaction on 'days' (every append's scope) kept open until released
  await page.evaluate(
    () =>
      new Promise<void>((started) => {
        const w = window as unknown as { __stall: boolean };
        w.__stall = true;
        const q = indexedDB.open('kansowriter');
        q.onsuccess = () => {
          const days = q.result.transaction('days', 'readwrite').objectStore('days');
          const spin = () => {
            if (w.__stall) days.get('').onsuccess = spin;
          };
          spin();
          started();
        };
      }),
  );
  // a follow's load would queue behind the stall too (no visible change): count the loads it starts
  await page.evaluate(() => ((window as unknown as { __followLoads: number }).__followLoads = 0));
  await editor.pressSequentially(' final');
  await second.getByRole('button', { name: 'Open here instead' }).click();
  await expect(readOnlyNotice(page)).toBeVisible();
  await expect(draft(page)).toHaveAttribute('contenteditable', 'false');
  await expect(draft(second), 'the final write is stalled: no release yet').toHaveAttribute('contenteditable', 'false');

  // a commit and a delete announced meanwhile: neither is followed
  const other = await page.context().newPage();
  await other.goto('/about');
  await broadcastCommitAndDelete(other, record);
  await expect(draft(second)).toHaveAttribute('contenteditable', 'false');
  expect(await shownText(page)).toBe('shared final');
  expect(
    await page.evaluate(() => (window as unknown as { __followLoads: number }).__followLoads),
    'loads started while handing over',
  ).toBe(0);
  await expect(landing(page)).toHaveCount(0);

  await page.evaluate(() => ((window as unknown as { __stall: boolean }).__stall = false));
  await expect(draft(second)).toHaveAttribute('contenteditable', 'true', { timeout: 10_000 });
  await expect(draft(second)).toHaveText('shared final');
  await draft(second).click();
  await second.keyboard.press('End');
  await draft(second).pressSequentially(' then more');
  await settle(second);
  await expect.poll(() => viewText(page), { timeout: 5000 }).toBe('shared final then more');

  await second.keyboard.press(`${await mod(second)}+k`);
  await runCommand(second, 'delete draft', /Delete draft/);
  await second.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
  await expect(landing(page)).toBeVisible({ timeout: 5000 });
});

test('stale × commit while hidden: the stale words and notice stay once visible again', async ({ page }) => {
  const editor = await startWriting(page);
  await write(page, editor, 'first words');
  await settle(page);
  const record = await storedRecord(page);
  await removeDraftsUnderneath(page);
  await editor.pressSequentially(' second');
  await expect(page.getByText('This tab stopped saving.')).toBeVisible({ timeout: 10_000 });

  await setVisibility(page, 'hidden');
  const other = await page.context().newPage();
  await other.goto('/about');
  await broadcastCommit(other, record);
  await setVisibility(page, 'visible');
  await page.waitForTimeout(1500); // a catch-up would find the draft gone and leave the editor
  await expect(page.getByText('This tab stopped saving.')).toBeVisible();
  await expect(draft(page)).toHaveText('first words second');
  await expect(landing(page)).toHaveCount(0);
});

test('damaged × commit while hidden: the damaged notice and text stay once visible again', async ({ page }) => {
  const editor = await startWriting(page);
  await write(page, editor, 'readable text');
  await settle(page);
  const damaged = await damage(page);
  const record = await storedRecord(page);

  await setVisibility(page, 'hidden');
  const other = await page.context().newPage();
  await other.goto('/about');
  await broadcastCommit(other, record);
  await setVisibility(page, 'visible');
  await page.waitForTimeout(1500);
  await expect(damaged).toBeVisible();
  await expect(draft(page)).toContainText('readable text');
  await expect(draft(page)).toHaveAttribute('contenteditable', 'false');
});

test('damaged × "Keep the readable text" while another tab holds the lock: history untouched, read-only after remount', async ({
  page,
}) => {
  const editor = await startWriting(page);
  await write(page, editor, 'readable text');
  await settle(page);
  await damage(page);
  const before = await storedHistory(page);

  const holder = await page.context().newPage();
  await holder.goto('/about');
  await holder.evaluate((id) => {
    void navigator.locks.request(`draft:${id}`, () => new Promise(() => {})); // held for good
  }, before.id);
  await expect.poll(() => holder.evaluate(async () => (await navigator.locks.query()).held?.length ?? 0)).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Keep the readable text' }).click();
  await expect(readOnlyNotice(page)).toBeVisible();
  await expect(page.getByText('Part of this draft’s history is damaged.')).toHaveCount(0);
  await expect(draft(page)).toHaveAttribute('contenteditable', 'false');
  expect(await storedHistory(page)).toEqual(before);
});
