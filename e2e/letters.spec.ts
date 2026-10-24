import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mod, runCommand, startWriting, write } from './helpers';

const PRIVACY = 'Anyone with this link can read the letter. It lives in the link, in your chat and in browser history.';
const isMobile = (page: Page) => page.viewportSize()!.width < 640;

/** Send as letter (3A): ⌘⇧L / Ctrl ⇧L on desktop, the palette from ⋯ on phones. */
async function openSend(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open commands' }).click();
    await runCommand(page, 'send', /Send as letter/);
  } else await page.keyboard.press(`${await mod(page)}+Shift+L`);
  const dialog = page.getByRole('dialog', { name: 'Send as letter' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** The letter link from the send panel: the real clipboard on Chromium, else the 9A fallback field. */
async function copyLink(page: Page, browserName: string): Promise<string> {
  const dialog = page.getByRole('dialog', { name: 'Send as letter' });
  await expect(dialog.getByText(/Fits in a link · [\d.]+ KB/)).toBeVisible();
  if (browserName === 'chromium') {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await dialog.getByRole('button', { name: 'Copy link' }).click();
    await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
    return page.evaluate(() => navigator.clipboard.readText());
  }
  // WebKit has no clipboard permission to grant: exercise the blocked-clipboard path instead
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
  });
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  await expect(dialog.getByText('Couldn’t copy. Select the link below')).toBeVisible();
  const field = dialog.getByRole('textbox', { name: 'Letter link' });
  await expect(field).toBeFocused();
  return field.inputValue();
}

async function letterFor(page: Page, browserName: string, text: string) {
  const editor = await startWriting(page);
  await write(page, editor, text);
  await openSend(page);
  return copyLink(page, browserName);
}

test.describe('letters (v0.1)', () => {
  test('send preview shows the privacy line, copies a link, and the link replays to the end', async ({ page, browserName }) => {
    const editor = await startWriting(page);
    await write(page, editor, '# For Maya\n\nThe light came back today.');
    const dialog = await openSend(page);
    await expect(dialog.getByText(PRIVACY)).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Replay' })).toBeChecked();
    // the live preview replays the letter (2A)
    await expect(dialog.getByRole('textbox', { name: 'Letter preview' })).toContainText('The light came back today.', { timeout: 20_000 });
    const link = await copyLink(page, browserName);
    expect(link).toMatch(/^http:\/\/[^/]+\/l#v1\.[A-Za-z0-9_-]+$/);

    // Esc closes and returns to the editor
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    if (!isMobile(page)) await expect(editor).toBeFocused();

    const reader = await page.context().newPage();
    await reader.emulateMedia({ reducedMotion: 'reduce' });
    await reader.goto(link);
    await expect(reader).toHaveTitle('A letter — Kansowriter');
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText('For Maya');
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText('The light came back today.');
    await expect(reader.getByText(/^A letter, written /)).toBeVisible();
    await expect(reader.getByRole('link', { name: 'Written with Kansowriter' })).toHaveAttribute('href', '/');
    await expect(reader.locator('.cm-reader-caret')).toHaveCount(0);
  });

  test('a short letter replays in real time, then shows the end link', async ({ page, browserName }) => {
    const link = await letterFor(page, browserName, 'Hi Sam, slowly.');
    const reader = await page.context().newPage();
    await reader.goto(link);
    const letter = reader.getByRole('textbox', { name: 'Letter' });
    await expect(letter).toContainText('Hi Sam, slowly.', { timeout: 20_000 });
    await expect(reader.locator('.cm-reader-caret')).toHaveCount(0);
    await expect(reader.locator('.replay-progress > div')).toHaveAttribute('style', /width: 100%/);
    const end = reader.getByRole('link', { name: 'Written with Kansowriter' });
    await expect(end).toBeAttached();
    await expect(end).toHaveCSS('opacity', '1', { timeout: 5000 }); // fades in after 1.5 s
  });

  test('the reader controls stay hidden until the reader moves, then Skip to the end works', async ({ page, browserName }) => {
    test.skip(isMobile(page), 'pointer-move reveal is a desktop path; phones reveal on touch');
    const editor = await startWriting(page);
    await write(page, editor, 'One line.');
    await page.waitForTimeout(3000); // a pause under 4 s replays as recorded: the replay lasts ~3 s
    await write(page, editor, ' Another line.');
    await openSend(page);
    const link = await copyLink(page, browserName);
    const reader = await page.context().newPage();
    await reader.goto(link);
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toBeVisible(); // decoded: the reader is listening
    const controls = reader.locator('.replay-controls');
    await expect(controls).toHaveClass(/hidden/);
    await reader.mouse.move(10, 10);
    await reader.mouse.move(60, 60);
    await expect(controls).not.toHaveClass(/hidden/);
    await reader.getByRole('button', { name: 'Skip to the end' }).click();
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText('One line. Another line.');
    await expect(reader.getByRole('button', { name: 'Replay' })).toBeVisible();
    await expect(reader.getByRole('link', { name: 'Written with Kansowriter' })).toBeAttached();
  });

  test('/l without a letter offers "Open a letter file", and a file opens', async ({ page, browserName }) => {
    const link = await letterFor(page, browserName, 'Sent as a file.');
    const reader = await page.context().newPage();
    await reader.emulateMedia({ reducedMotion: 'reduce' });
    await reader.goto('/l');
    await expect(reader.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
    await reader.locator('input[type="file"]').setInputFiles({
      name: 'Sent as a file.kansoletter',
      mimeType: 'application/x-kansoletter',
      buffer: Buffer.from(link.split('#')[1]! + '\n'),
    });
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText('Sent as a file.');
  });

  test('a damaged link says so calmly', async ({ page }) => {
    await page.goto('/l#v1.garbage');
    await expect(page.getByText('This letter didn’t arrive whole. Ask the sender to send the link again, or as a file.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
  });

  test('without DecompressionStream the reader asks for a newer browser (R14)', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as { DecompressionStream?: unknown }).DecompressionStream;
    });
    await page.goto('/l#v1.anything');
    await expect(page.getByText('This letter needs a newer browser. Open it in Safari, Chrome or Firefox.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  });

  test('images, raw HTML and links stay text and nothing loads off-site (R6)', async ({ page, browserName, baseURL }) => {
    const text = '![x](https://example.com/p.png)\n<img src=https://example.com/a.png>\n<iframe>\n[a link](https://example.com/l)';
    const link = await letterFor(page, browserName, text);
    const reader = await page.context().newPage();
    const offOrigin: string[] = [];
    reader.on('request', (r) => {
      const u = new URL(r.url());
      if (['http:', 'https:'].includes(u.protocol) && u.origin !== new URL(baseURL!).origin) offOrigin.push(r.url());
    });
    await reader.emulateMedia({ reducedMotion: 'reduce' });
    await reader.goto(link);
    const letter = reader.getByRole('textbox', { name: 'Letter' });
    await expect(letter).toContainText('![x](https://example.com/p.png)');
    await expect(letter).toContainText('<img src=https://example.com/a.png>');
    await expect(letter).toContainText('<iframe>');
    await expect(letter).toContainText('a link');
    await expect(reader.locator('.replay-column').locator('img, iframe, a, object, embed')).toHaveCount(0);
    await reader.waitForTimeout(500);
    expect(offOrigin).toEqual([]);
  });

  test('an empty draft has nothing to send yet', async ({ page }) => {
    await startWriting(page);
    const dialog = await openSend(page);
    await expect(dialog.getByText('Nothing to send yet. Write something first.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
  });

  test('the reader and the send panel pass axe', async ({ page, browserName }) => {
    test.slow(); // three axe passes plus a written letter
    const link = await letterFor(page, browserName, '# A note\n\nShort and kind.');
    expect((await new AxeBuilder({ page }).include('.send-wrap').analyze()).violations).toEqual([]);
    const reader = await page.context().newPage();
    await reader.emulateMedia({ reducedMotion: 'reduce' });
    await reader.goto(link);
    await expect(reader.getByRole('link', { name: 'Written with Kansowriter' })).toBeVisible();
    expect((await new AxeBuilder({ page: reader }).analyze()).violations).toEqual([]);
    await reader.goto('/l');
    await expect(reader.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
    expect((await new AxeBuilder({ page: reader }).analyze()).violations).toEqual([]);
  });

  test('the installed app claims .kansoletter files (R1)', async ({ page, request, browserName }) => {
    test.skip(browserName !== 'chromium', 'file_handlers is Chromium-only (R1)');
    await page.goto('/about');
    const manifest = await (await request.get(await page.$eval('link[rel="manifest"]', (l) => (l as HTMLLinkElement).href))).json();
    expect(manifest.file_handlers).toEqual([{ action: '/l', accept: { 'application/x-kansoletter': ['.kansoletter'] } }]);
  });
});
