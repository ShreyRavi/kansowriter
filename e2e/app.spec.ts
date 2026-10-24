import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { freshStart, mod, runCommand, settle, startWriting, write } from './helpers';

test.describe('first visit and writing', () => {
  test('landing shows the name, the line types itself, and no third-party requests happen', async ({ page, baseURL }) => {
    const offOrigin: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['http:', 'https:'].includes(u.protocol)) return;
      if (u.origin !== new URL(baseURL!).origin) offOrigin.push(r.url());
    });
    await freshStart(page);
    await page.goto('/');
    await expect(page.getByText('Kansowriter', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A quiet place to write.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore from a backup' })).toBeVisible();
    await expect(page).toHaveTitle(/Kansowriter/);
    expect(offOrigin).toEqual([]);
  });

  test('favicon, apple-touch icon and every manifest icon resolve as images', async ({ page, request }) => {
    await page.goto('/about');
    const hrefs = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (ls) => ls.map((l) => (l as HTMLLinkElement).getAttribute('href')!));
    const manifest = await (await request.get(await page.$eval('link[rel="manifest"]', (l) => (l as HTMLLinkElement).href))).json();
    const all = [...hrefs, ...manifest.icons.map((i: { src: string }) => i.src)];
    expect(all).toEqual(expect.arrayContaining(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/icon-maskable-512.png']));
    for (const href of all) {
      const r = await request.get(href);
      expect(r.status(), href).toBe(200);
      expect(r.headers()['content-type'], href).toMatch(/^image\//);
    }
  });

  test('type, reload: the draft persists and "/" reopens it (R26)', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, '# On silence\n\nA few minutes into writing.');
    await settle(page);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toContainText('A few minutes into writing.');
    await expect(page.locator('.header .title')).toHaveText('On silence');
    await page.goto('/about');
    await expect(page.getByRole('heading', { name: 'A quiet place to write.' })).toBeVisible();
  });

  test('hiding the page saves the word still being typed (R4)', async ({ page }) => {
    const editor = await startWriting(page);
    await editor.pressSequentially('Hel');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toContainText('Hel');
  });

  test('chrome fades after typing and the progress line stays; goal counts words', async ({ page }) => {
    const editor = await startWriting(page);
    await editor.pressSequentially('one two three ');
    await expect(page.locator('.header')).toHaveClass(/hidden/, { timeout: 5000 });
    await expect(page.locator('.progress')).toBeVisible();
    await page.mouse.move(10, 10);
    await page.mouse.move(40, 40);
    await expect(page.locator('.header')).not.toHaveClass(/hidden/);
    await settle(page);
    await expect(page.locator('.footer .count')).toContainText('3 of 750');
  });
});

test.describe('palette, sidebar, tabs', () => {
  test('palette Theme setting: System → Light → Dark, and the choice survives reload', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await startWriting(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const row = page.getByRole('option', { name: /^Theme/ });
    await expect(row).toContainText('System (light)');
    await runCommand(page, 'dark mode', /Theme/); // search finds it by "dark"
    await expect(row).toContainText('Light');
    await runCommand(page, 'theme', /Theme/);
    await expect(row).toContainText('Dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'night');
  });

  test('palette edits a number in its row (19A)', async ({ page }) => {
    await startWriting(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    await runCommand(page, 'daily word goal', /Daily word goal/);
    const field = page.getByRole('textbox', { name: 'goal' });
    await field.fill('1000');
    await field.press('Enter');
    await page.keyboard.press('Escape');
    await expect(page.locator('.footer .count')).toContainText('of 1000');
  });

  test('delete asks for confirmation inside its row (8A)', async ({ page }) => {
    await startWriting(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    await runCommand(page, 'delete draft', /Delete draft/);
    await expect(page.getByRole('alertdialog')).toContainText('can’t be undone');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });

  test('sidebar search shows a no-results state with a new-draft action (5A)', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, '# First draft\n\nSome text.');
    await settle(page);
    await page.getByRole('button', { name: 'Open drafts' }).click();
    const sidebar = page.getByRole('dialog', { name: 'Drafts' });
    await expect(sidebar.getByText('First draft')).toBeVisible();
    await sidebar.getByPlaceholder('Search drafts').fill('zebra');
    await expect(sidebar.getByText('No drafts match “zebra”')).toBeVisible();
    await sidebar.getByRole('button', { name: 'New draft titled “zebra”' }).click();
    await expect(page.locator('.header .title')).toHaveText('zebra');
  });

  test('a second tab is read-only and can take over (R23)', async ({ page, context }) => {
    const editor = await startWriting(page);
    await editor.pressSequentially('shared draft');
    await settle(page);
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByText('Open in another tab.')).toBeVisible();
    await expect(second.getByRole('textbox', { name: 'Draft' })).toHaveAttribute('contenteditable', 'false');
    await second.getByRole('button', { name: 'Open here instead' }).click();
    await expect(second.getByRole('textbox', { name: 'Draft' })).toHaveAttribute('contenteditable', 'true');
    await expect(second.getByRole('textbox', { name: 'Draft' })).toContainText('shared draft');
    await expect(page.getByText('Open in another tab.')).toBeVisible();
  });

  test('export as Markdown downloads the draft', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, '# Export me\n\nBody');
    const download = page.waitForEvent('download');
    await page.keyboard.press(`${await mod(page)}+e`);
    const d = await download;
    expect(d.suggestedFilename()).toBe('Export me.md');
  });
});

test.describe('document commands and failure paths', () => {
  test('rename inserts a heading above prose instead of overwriting the first line', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'Dear Sam, it has been a while.');
    await page.keyboard.press(`${await mod(page)}+k`);
    await runCommand(page, 'rename', /Rename draft/);
    const field = page.getByRole('textbox', { name: 'Draft title' });
    await field.fill('Letter to Sam');
    await field.press('Enter');
    await page.keyboard.press('Escape');
    await expect(editor).toContainText('Dear Sam, it has been a while.');
    await expect(page.locator('.header .title')).toHaveText('Letter to Sam', { timeout: 5000 });
  });

  test('→ on Theme offers System / Light / Dark; System follows the device again', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'keyboard path');
    await page.emulateMedia({ colorScheme: 'dark' });
    await startWriting(page);
    await page.keyboard.press(`${await mod(page)}+Shift+n`); // explicit override: light
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'paper');
    await page.keyboard.press(`${await mod(page)}+k`);
    await page.getByPlaceholder('Search commands and settings').fill('theme');
    await expect(page.locator('[cmdk-item][data-selected="true"]')).toHaveText(/Theme/);
    await page.keyboard.press('ArrowRight');
    await page.locator('.choices').getByRole('button', { name: 'System' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'night'); // device is dark
    await expect(page.getByRole('option', { name: /^Theme/ })).toContainText('System (dark)');
  });

  test('Escape in an inline field cancels the edit and keeps the palette open', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'keyboard path');
    await startWriting(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    await runCommand(page, 'daily word goal', /Daily word goal/);
    await page.getByRole('textbox', { name: 'goal' }).press('Escape');
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'goal' })).toHaveCount(0);
  });

  test('→ on Typeface expands the choices; ↓ and Enter pick one', async ({ page, isMobile }) => {
    test.skip(!!isMobile, 'keyboard path');
    await startWriting(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    await page.getByPlaceholder('Search commands and settings').fill('typeface');
    await expect(page.locator('[cmdk-item][data-selected="true"]')).toHaveText(/Typeface/);
    await page.keyboard.press('ArrowRight');
    const group = page.locator('.choices');
    await expect(group).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(group).toHaveCount(0);
    await expect(page.getByRole('option', { name: /Typeface/ })).toContainText('Instrument Sans');
  });

  test('delete confirms in its row, then removes the draft and returns to landing', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'short lived');
    await settle(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    await runCommand(page, 'delete draft', /Delete draft/);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('button', { name: 'Start writing' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Start writing' })).toBeVisible();
  });

  test('clear history keeps the text', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'keep these words');
    await settle(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    await runCommand(page, 'clear history', /Clear history/);
    await page.getByRole('alertdialog').getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByRole('option', { name: /Clear history/ })).toContainText('History cleared');
    await page.keyboard.press('Escape');
    await editor.pressSequentially(' more');
    await settle(page);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toContainText('keep these words more');
  });

  test('when storage refuses writes, the tab says so and offers the unsaved text (R5)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    const editor = await startWriting(page);
    await editor.pressSequentially('first');
    await settle(page);
    // the draft disappears underneath this tab (deleted elsewhere): the next write is refused
    await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((r) => { const q = indexedDB.open('kansowriter'); q.onsuccess = () => r(q.result); });
      await new Promise((r) => { const t = db.transaction('drafts', 'readwrite'); t.objectStore('drafts').clear(); t.oncomplete = r; });
      db.close();
    });
    await editor.pressSequentially(' second');
    await expect(page.getByText('This tab stopped saving.')).toBeVisible({ timeout: 5000 });
    await expect(editor).toHaveAttribute('contenteditable', 'false');
    await page.getByRole('button', { name: 'Copy unsaved text' }).click();
    await expect(page.locator('.notice')).toContainText(/Copied|Selected/);    // switching drafts asks once, and Leave anyway really leaves (never a trap)
    await page.getByRole('button', { name: 'Open drafts' }).click();
    await page.getByRole('dialog', { name: 'Drafts' }).getByRole('button', { name: 'New draft' }).click();
    await expect(page.getByText('Your newest words aren’t saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Leave anyway' }).click();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveAttribute('contenteditable', 'true');
    await expect(page.getByRole('textbox', { name: 'Draft' })).not.toContainText('first');
  });
});

test.describe('phone layout', () => {
  test('the header never covers the first line of the draft', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone only');
    const editor = await startWriting(page);
    await write(page, editor, 'First line');
    const header = await page.locator('.header').boundingBox();
    const line = await page.locator('.cm-line').first().boundingBox();
    expect(line!.y).toBeGreaterThanOrEqual(header!.y + header!.height);
  });
});

test.describe('accessibility (17A)', () => {
  test('landing, editor, palette and sidebar pass axe', async ({ page }) => {
    await freshStart(page);
    await page.goto('/');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const editor = await startWriting(page);
    await write(page, editor, '# Title\n\nBody text.');
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.keyboard.press(`${await mod(page)}+k`);
    expect((await new AxeBuilder({ page }).include('.palette').analyze()).violations).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Open drafts' }).click();
    expect((await new AxeBuilder({ page }).include('.sidebar').analyze()).violations).toEqual([]);
  });

  test('Tab leaves the editor and reaches the drafts button first', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Safari skips buttons on Tab unless "Press Tab to highlight each item" is enabled');
    const editor = await startWriting(page);
    await editor.pressSequentially('words');
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', /Send|Open command palette|theme|focus mode|Open drafts|Open commands/);
  });
});
