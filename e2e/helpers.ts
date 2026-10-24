import { expect, type Locator, type Page } from '@playwright/test';

/** The app's own rule for ⌘ vs Ctrl, evaluated in the (possibly emulated) page. */
export const mod = async (page: Page) =>
  (await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))) ? 'Meta' : 'Control';

/** Fresh visit: clear storage so each test starts with no drafts. */
export async function freshStart(page: Page) {
  await page.goto('/about');
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = (await indexedDB.databases?.()) ?? [{ name: 'kansowriter' }];
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise((r) => {
            const q = indexedDB.deleteDatabase(d.name!);
            q.onsuccess = q.onerror = q.onblocked = () => r(null);
          }),
      ),
    );
  });
}

export async function startWriting(page: Page) {
  await freshStart(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start writing' }).click();
  const editor = page.getByRole('textbox', { name: 'Draft' });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  return editor;
}

/** Wait until storage has committed (the 500 ms batch plus the 1 s merge window). */
export async function settle(page: Page) {
  await page.waitForTimeout(1800);
}

const isMobile = (page: Page) => page.viewportSize()!.width < 640;

/** Type into the editor; on phone emulation newlines go in as inserted text (as a real keyboard's insertParagraph would). */
export async function write(page: Page, editor: Locator, text: string) {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) await editor.pressSequentially(parts[i]!);
    if (i < parts.length - 1) {
      if (isMobile(page)) await page.keyboard.insertText('\n');
      else await page.keyboard.press('Enter');
    }
  }
}

/** Run a palette command by name: Enter on desktop, tap on phones. */
export async function runCommand(page: Page, query: string, option: string | RegExp) {
  await page.getByPlaceholder('Search commands and settings').fill(query);
  if (isMobile(page)) await page.getByRole('option', { name: option }).first().click();
  else {
    // cmdk re-selects after filtering on the next frame: wait for it, as a person would
    await expect(page.locator('[cmdk-item][data-selected="true"]')).toHaveText(option);
    await page.keyboard.press('Enter');
  }
}

/** Open the drafts sidebar the way a person does: the header fades while typing, so reveal it first. */
export async function openDrafts(page: Page) {
  if (isMobile(page)) await page.touchscreen.tap(5, 400);
  else {
    await page.mouse.move(200, 300);
    await page.mouse.move(240, 340);
  }
  await page.getByRole('button', { name: 'Open drafts' }).click();
}
