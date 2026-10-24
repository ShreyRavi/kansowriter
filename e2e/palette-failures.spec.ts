// Value: protects=a palette chunk that won't load closes the palette with an in-place "Reload to update" notice
//   while the editor stays mounted, editable and saving (the root error screen would unmount it, its unsaved-words
//   guard and its session), a failing Clear history answers in its row instead of hanging on "Clearing…", and
//   emptying a number field keeps its value;
//   fails_when=the palette's local boundary or the lazy retry goes, run() loses its rejection handler or
//   clearHistory stops catching storage errors, or commitEdit turns '' into 0 (clamped to the minimum);
//   why_new=no test drove a chunk failure, a rejected palette action or an emptied field; seam=none;
//   no_claim=why a chunk fails in the wild (the request is aborted by the test); the root ErrorBoundary's
//   unsaved-words screen (no production seam forces a root render error: src/ui/ErrorBoundary.test.tsx covers it)
import { expect, test } from '@playwright/test';
import { failIdb, mod, runCommand, savedState, settle, startWriting, write } from './helpers';

test.describe('palette chunk failure', () => {
  // page.route can't see requests a service worker answers from its precache
  test.use({ serviceWorkers: 'block' });

  test('a palette chunk that never loads keeps the editor open and saving, with a Reload notice', async ({ page }) => {
    const chunk = /\/assets\/CommandPalette-[\w-]+\.js$/;
    let blocked = 0;
    await page.route(chunk, (route) => {
      blocked++;
      return route.abort();
    });
    const editor = await startWriting(page);
    await write(page, editor, 'still on this device');
    await settle(page);
    await page.keyboard.press(`${await mod(page)}+k`);
    const notice = page.locator('.notice');
    await expect(notice).toContainText('Couldn’t open commands. Reload to update');
    expect(blocked).toBeGreaterThan(0);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expect(page.getByPlaceholder('Search commands and settings')).toHaveCount(0);

    // the editor never unmounted: same text, still editable, and new words still reach IndexedDB
    await expect(editor).toHaveAttribute('contenteditable', 'true');
    await expect(editor).toContainText('still on this device');
    await write(page, editor, ' and more');
    await settle(page);
    const { saved } = await savedState(page);
    expect(saved.map((d) => d.text)).toEqual(['still on this device and more']);

    await page.unroute(chunk);
    await notice.getByRole('button', { name: 'Reload' }).click();
    await expect(page.getByRole('textbox', { name: 'Draft' })).toContainText('still on this device and more');
    await expect(page.locator('.notice')).toHaveCount(0);
  });
});

test('a Clear history that storage refuses says so in its row instead of hanging', async ({ page }) => {
  const editor = await startWriting(page);
  await write(page, editor, 'keep these words');
  await settle(page);
  await failIdb(page, ['put', 'delete']);
  await page.keyboard.press(`${await mod(page)}+k`);
  await runCommand(page, 'clear history', /Clear history/);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Clear' }).click();
  const row = page.getByRole('option', { name: /Clear history/ });
  await expect(row).toContainText('Couldn’t clear history. Try again');
  await expect(row).not.toContainText('Clearing…');
});

test('emptying the daily goal field keeps the current goal', async ({ page }) => {
  await startWriting(page);
  await page.keyboard.press(`${await mod(page)}+k`);
  await runCommand(page, 'daily word goal', /Daily word goal/);
  const field = page.getByRole('textbox', { name: 'goal' });
  const before = await field.inputValue();
  await field.fill('');
  await field.press('Enter');
  await expect(field).toHaveCount(0);
  await expect(page.getByRole('option', { name: /Daily word goal/ })).toContainText(before);
  await page.keyboard.press('Escape');
  await expect(page.locator('.footer .count')).toContainText(`of ${before}`);
});
