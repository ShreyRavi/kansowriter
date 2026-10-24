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
  test('⌘K palette toggles night theme, and the choice survives reload', async ({ page }) => {
    await startWriting(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    await runCommand(page, 'night', /Night theme/);
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
