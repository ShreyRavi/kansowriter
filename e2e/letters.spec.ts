import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {
  decodeTestLetter,
  encodeTestLetter,
  failIdb,
  mod,
  readerPath,
  requestedName,
  runCommand,
  settle,
  startWriting,
  write,
} from './helpers';

const PRIVACY = 'Anyone with this link can read the letter. It lives in the link, in your chat and in browser history.';
const FILE_PRIVACY = 'Anyone with this file can read the letter. It lives in the file, not on a server.';
const DAMAGED = 'This letter didn’t arrive whole. Ask the sender to send the link again, or as a file.';
/** production builds link to the canonical origin (D4, src/ui/letterLinks.ts) */
const CANONICAL = 'https://kansowriter.vercel.app';
const isMobile = (page: Page) => page.viewportSize()!.width < 640;

/** Send as letter (3A): ⌘⇧L / Ctrl ⇧L on desktop, the palette from ⋯ on phones. */
async function openSend(page: Page) {
  if (isMobile(page)) {
    await page.touchscreen.tap(5, 400); // the header fades while typing: a tap brings it back
    await page.getByRole('button', { name: 'Open commands' }).click();
    await runCommand(page, 'send', /Send as letter/);
  } else await page.keyboard.press(`${await mod(page)}+Shift+L`);
  const dialog = page.getByRole('dialog', { name: 'Send as letter' });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Click Copy link and return what was copied: the real clipboard on Chromium, else the 9A fallback field. */
async function clickCopy(page: Page, browserName: string): Promise<string> {
  const dialog = page.getByRole('dialog', { name: 'Send as letter' });
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

async function copyLink(page: Page, browserName: string): Promise<string> {
  await expect(page.getByRole('dialog', { name: 'Send as letter' }).getByText(/Fits in a link · [\d.]+ KB/)).toBeVisible();
  return clickCopy(page, browserName);
}

async function letterFor(page: Page, browserName: string, text: string) {
  const editor = await startWriting(page);
  await write(page, editor, text);
  await openSend(page);
  return copyLink(page, browserName);
}

/** Show the reader's quiet controls the way a keyboard reader does (any key reveals them). */
async function revealControls(reader: Page) {
  await expect(reader.getByRole('textbox', { name: 'Letter' })).toBeVisible(); // decoded: the controls are listening
  await expect(async () => {
    await reader.keyboard.press('Shift');
    await expect(reader.locator('.replay-controls')).not.toHaveClass(/hidden/, { timeout: 500 });
  }).toPass();
}

/**
 * Jump a (short, real) letter to its end without racing it: the click happens in the page, and only
 * while Skip is still enabled (a replay that already ended has nothing to skip).
 */
async function toTheEnd(reader: Page) {
  await expect(reader.getByRole('textbox', { name: 'Letter' })).toBeVisible();
  await revealControls(reader);
  await reader.evaluate(() => {
    const skip = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Skip to the end');
    if (skip && !skip.disabled) skip.click();
  });
  await expect(reader.getByRole('link', { name: 'Written with Kansowriter' })).toBeAttached();
}

/** A replay that takes 30 s: one insert spread over its whole d (R12), so no test can race its end. */
const SLOW_TEXT = 'One line. Another line.';
const slowLetter = () =>
  encodeTestLetter({ v: 1, baseText: '', ops: [[0, 30_000, SLOW_TEXT]], meta: { writtenAt: Date.UTC(2026, 9, 22, 12), tz: 0 } });

/** 26 ops 250 ms apart: a replay whose length (12 750 ms) is not a whole number of scrubber steps */
const STEPPED_TEXT = 'Dear Sam,\n\nThe garden is quiet this morning. I wrote this slowly so you could watch it arrive.\n\nLove, R.';
const steppedLetter = () => {
  const ops: (number | string)[][] = [];
  for (let i = 0; i < STEPPED_TEXT.length; i += 4)
    ops.push(i ? [250, 250, i, STEPPED_TEXT.slice(i, i + 4)] : [0, 250, STEPPED_TEXT.slice(0, 4)]);
  return encodeTestLetter({ v: 1, baseText: '', ops });
};

/** A file dropped on `selector`, as the OS does it (dragover, then drop); returns whether the page claimed each. */
async function dropFile(page: Page, selector: string, name: string, content: string) {
  return page.evaluate(
    ({ selector, name, content }) => {
      const target = document.querySelector(selector)!;
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: 'application/x-kansoletter' }));
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(over);
      const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(drop);
      // a drop the page doesn't preventDefault is one the browser navigates to (leaving the reader)
      return { over: over.defaultPrevented, drop: drop.defaultPrevented };
    },
    { selector, name, content },
  );
}

test.describe('letters (v0.1)', () => {
  test('send preview shows the privacy line, copies a canonical link, and the link replays to the end', async ({ page, browserName }) => {
    const editor = await startWriting(page);
    await write(page, editor, '# For Maya\n\nThe light came back today.');
    const dialog = await openSend(page);
    await expect(dialog.getByText(PRIVACY)).toBeVisible();
    await expect(dialog.getByRole('radio', { name: 'Replay' })).toBeChecked();
    // the live preview replays the letter (2A)
    await expect(dialog.getByRole('textbox', { name: 'Letter preview' })).toContainText('The light came back today.', { timeout: 20_000 });
    const link = await copyLink(page, browserName);
    expect(link).toMatch(new RegExp(`^${CANONICAL.replace(/\./g, '\\.')}/l#v1\\.[A-Za-z0-9_-]+$`));

    // Esc closes and returns to the editor (Send was opened from the text)
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    if (!isMobile(page)) await expect(editor).toBeFocused();

    const reader = await page.context().newPage();
    await reader.goto(readerPath(link));
    await expect(reader).toHaveTitle('A letter — Kansowriter');
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText('For Maya', { timeout: 20_000 });
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText('The light came back today.', { timeout: 20_000 });
    await expect(reader.getByText(/^A letter, written /)).toBeVisible();
    await expect(reader.getByRole('link', { name: 'Written with Kansowriter' })).toHaveAttribute('href', '/');
    await expect(reader.locator('.cm-reader-caret')).toHaveCount(0);
  });

  test('a short letter replays in real time, then shows the end link', async ({ page, browserName }) => {
    const link = await letterFor(page, browserName, 'Hi Sam, slowly.');
    const reader = await page.context().newPage();
    await reader.goto(readerPath(link));
    const letter = reader.getByRole('textbox', { name: 'Letter' });
    await expect(letter).toContainText('Hi Sam, slowly.', { timeout: 20_000 });
    await expect(reader.locator('.cm-reader-caret')).toHaveCount(0);
    await expect(reader.locator('.replay-progress > div')).toHaveAttribute('style', /width: 100%/);
    const end = reader.getByRole('link', { name: 'Written with Kansowriter' });
    await expect(end).toBeAttached();
    await expect(end).toHaveCSS('opacity', '1', { timeout: 5000 }); // fades in after 1.5 s
  });

  test('the reader controls stay hidden until the reader moves, then Skip to the end works', async ({ page }) => {
    test.skip(isMobile(page), 'pointer-move reveal is a desktop path; phones reveal on touch or a key (covered below)');
    await page.goto(`/l#${await slowLetter()}`);
    await expect(page.getByRole('textbox', { name: 'Letter' })).toBeVisible(); // decoded: the reader is listening
    const controls = page.locator('.replay-controls');
    await expect(controls).toHaveClass(/hidden/);
    await page.mouse.move(10, 10);
    await page.mouse.move(60, 60);
    await expect(controls).not.toHaveClass(/hidden/);
    // the end link belongs to the end only
    await expect(page.getByRole('link', { name: 'Written with Kansowriter' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Skip to the end' }).click();
    await expect(page.getByRole('textbox', { name: 'Letter' })).toHaveText(SLOW_TEXT);
    await expect(page.getByRole('button', { name: 'Replay' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Written with Kansowriter' })).toBeAttached();
  });

  test('replaying again hides the end link until the new end', async ({ page }) => {
    await page.goto(`/l#${await slowLetter()}`);
    await revealControls(page);
    await page.getByRole('button', { name: 'Skip to the end' }).click();
    const end = page.getByRole('link', { name: 'Written with Kansowriter' });
    await expect(end).toBeAttached();
    await page.getByRole('button', { name: 'Replay' }).click();
    await expect(end).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Letter' })).not.toHaveText(SLOW_TEXT);
  });

  test('paused, the scrubber and its value text follow every quick seek', async ({ page }) => {
    await page.goto(`/l#${await slowLetter()}`);
    await revealControls(page);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    const scrubber = page.getByRole('slider', { name: 'Replay position' });
    const max = Number(await scrubber.getAttribute('max'));
    // a drag: seeks closer together than the playing throttle (100 ms), each set the way the browser
    // sets it (Playwright's fill() goes around React's value tracker, so React never hears it)
    for (const v of ['9000', '4000', '12000', '12400'])
      await scrubber.evaluate((el: HTMLInputElement, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }, v);
    const clock = (ms: number) => `${Math.floor(Math.round(ms / 1000) / 60)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
    await expect(scrubber).toHaveValue('12400');
    await expect(scrubber).toHaveAttribute('aria-valuetext', `${clock(12_400)} of ${clock(max)}`);
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  });

  test('paused, the scrubber reaches the true end, and the end finishes the replay', async ({ page }) => {
    await page.goto(`/l#${await steppedLetter()}`);
    await revealControls(page);
    await page.getByRole('button', { name: 'Pause' }).click();
    const scrubber = page.getByRole('slider', { name: 'Replay position' });
    const max = Number(await scrubber.getAttribute('max'));
    expect(max % 100).toBe(0); // a whole number of steps, so the range can land on it
    await scrubber.focus();
    await page.keyboard.press('End');
    await expect(scrubber).toHaveValue(String(max));
    await expect(page.getByRole('textbox', { name: 'Letter' })).toHaveText(STEPPED_TEXT.replace(/\n/g, ''));
    await expect(page.getByRole('button', { name: 'Replay' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Skip to the end' })).toBeDisabled();
    await expect(page.getByRole('link', { name: 'Written with Kansowriter' })).toBeAttached();
    // one step back and the end is undone; one step on and it is reached again
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('link', { name: 'Written with Kansowriter' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Skip to the end' })).toBeEnabled();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('link', { name: 'Written with Kansowriter' })).toBeAttached();
  });

  test('paused, every arrow press moves the scrubber one step', async ({ page }) => {
    await page.goto(`/l#${await slowLetter()}`);
    await revealControls(page);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
    const scrubber = page.getByRole('slider', { name: 'Replay position' });
    await scrubber.focus();
    const at = Number(await scrubber.inputValue());
    expect(at % 100).toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect(scrubber).toHaveValue(String(at + 100));
    await page.keyboard.press('ArrowRight');
    await expect(scrubber).toHaveValue(String(at + 200));
    await page.keyboard.press('ArrowLeft');
    await expect(scrubber).toHaveValue(String(at + 100));
  });

  test('Skip to the end hands focus to Replay instead of dropping it', async ({ page }) => {
    await page.goto(`/l#${await slowLetter()}`);
    await revealControls(page);
    const skip = page.getByRole('button', { name: 'Skip to the end' });
    await skip.focus();
    await page.keyboard.press('Enter');
    await expect(skip).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Replay' })).toBeFocused();
  });

  test('on phones the scrubber is a full touch target and the controls fit on one line', async ({ page }) => {
    test.skip(!isMobile(page), 'coarse pointers only');
    await page.goto(`/l#${await slowLetter()}`);
    await revealControls(page);
    const scrubber = await page.getByRole('slider', { name: 'Replay position' }).boundingBox();
    expect(scrubber!.height).toBeGreaterThanOrEqual(44);
    const skip = await page.getByRole('button', { name: 'Skip to the end' }).boundingBox();
    const pause = await page.getByRole('button', { name: 'Pause' }).boundingBox();
    expect(skip!.height).toBe(pause!.height); // one line, no taller than its neighbour
    const controls = await page.locator('.replay-controls').boundingBox();
    const width = page.viewportSize()!.width;
    expect(controls!.x).toBeGreaterThanOrEqual(0);
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('under reduced motion the reader still replays, with a caret that never blinks (17A)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/l#${await slowLetter()}`);
    const letter = page.getByRole('textbox', { name: 'Letter' });
    await expect(letter).toContainText('One'); // under way
    await expect(letter).not.toHaveText(SLOW_TEXT); // not the final text at once
    const caret = page.locator('.cm-reader-caret');
    await expect(caret).toHaveCount(1);
    await expect(caret).toHaveCSS('animation-name', 'none');
    await expect(page.getByRole('link', { name: 'Written with Kansowriter' })).toHaveCount(0);
    await revealControls(page);
    await page.getByRole('button', { name: 'Skip to the end' }).click();
    await expect(letter).toHaveText(SLOW_TEXT);
    // no fade under reduced motion: the end link is there at once
    await expect(page.getByRole('link', { name: 'Written with Kansowriter' })).toHaveCSS('opacity', '1');
  });

  test('under reduced motion the send preview replays exactly as the reader will (17A)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const editor = await startWriting(page);
    await write(page, editor, 'One line.');
    await page.waitForTimeout(3500); // a pause under 4 s replays as recorded: the replay lasts ~3.5 s
    await write(page, editor, ' Another line.');
    const dialog = await openSend(page);
    const preview = dialog.getByRole('textbox', { name: 'Letter preview' });
    await expect(preview).toContainText('One line.');
    await expect(preview).not.toContainText('Another line.');
    await expect(preview).toContainText('One line. Another line.', { timeout: 20_000 });
  });

  test('switching to Final text only and copying at once never sends the replay (privacy)', async ({ page, browserName }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'Draft words. Then the real ones.');
    const dialog = await openSend(page);
    await expect(dialog.getByText(/Fits in a link · [\d.]+ KB/)).toBeVisible();
    await dialog.getByRole('radio', { name: 'Final text only' }).check();
    const link = await clickCopy(page, browserName);
    const letter = await decodeTestLetter(link);
    expect(letter.ops).toEqual([]);
    expect(letter.baseText).toBe('Draft words. Then the real ones.');
  });

  test('Final text only: no slider, and the reader shows the text at once with no controls', async ({ page, browserName }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'Just the words.');
    const dialog = await openSend(page);
    await dialog.getByRole('radio', { name: 'Final text only' }).check();
    await expect(dialog.getByRole('slider')).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Letter preview' })).toHaveText('Just the words.');
    const link = await copyLink(page, browserName);
    const reader = await page.context().newPage();
    await reader.goto(readerPath(link));
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toHaveText('Just the words.');
    await expect(reader.getByRole('link', { name: 'Written with Kansowriter' })).toBeAttached();
    await reader.keyboard.press('Shift');
    await expect(reader.locator('.replay-controls')).toHaveCount(0);
  });

  test('the start slider snaps to writing sessions', async ({ page, browserName }) => {
    test.slow(); // three sessions, each saved and reopened
    let editor = await startWriting(page);
    await write(page, editor, 'First.');
    await settle(page);
    for (const words of [' Second.', ' Third.']) {
      await page.reload(); // reopening the draft starts a new session (R16)
      editor = page.getByRole('textbox', { name: 'Draft' });
      await expect(editor).toHaveAttribute('contenteditable', 'true');
      await editor.click();
      await page.keyboard.press(isMobile(page) || (await mod(page)) === 'Control' ? 'Control+End' : 'Meta+ArrowDown');
      await write(page, editor, words);
      await settle(page);
    }
    const dialog = await openSend(page);
    const slider = dialog.getByRole('slider');
    // three sessions → three stops; it starts at the latest (R16)
    await expect(slider).toHaveAttribute('max', '2');
    await expect(slider).toHaveValue('2');
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveValue('1');
    expect((await decodeTestLetter(await copyLink(page, browserName))).baseText).toBe('First.');
    await slider.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveValue('0');
    await expect(dialog.getByText('the beginning')).toBeVisible();
    const fromStart = await decodeTestLetter(await copyLink(page, browserName));
    expect(fromStart.baseText).toBe('');
  });

  test('a letter too long for a link downloads as a file that opens in the reader', async ({ page }, testInfo) => {
    test.slow();
    const editor = await startWriting(page);
    await write(page, editor, '# Long letter.\n\n'); // a title ending in a dot: never "Long letter..kansoletter"
    // incompressible text: well past the 8 KB link size once deflated
    const noise = randomBytes(10_500).toString('base64'); // ~14 000 characters, ~6 bits each
    await page.keyboard.insertText(noise);
    const dialog = await openSend(page);
    await dialog.getByRole('radio', { name: 'Final text only' }).check();
    await expect(dialog.getByText(/Too long for a link · [\d.]+ KB file/)).toBeVisible({ timeout: 20_000 });
    // only a file goes out, so the privacy line speaks of the file
    await expect(dialog.getByText(FILE_PRIVACY)).toBeVisible();
    await expect(dialog.getByText(PRIVACY)).toHaveCount(0);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      dialog.getByRole('button', { name: 'Download letter file' }).click(),
    ]);
    expect(requestedName(download)).toBe('Long letter.kansoletter');
    const file = testInfo.outputPath('letter.kansoletter');
    await download.saveAs(file);

    const reader = await page.context().newPage();
    await reader.goto('/l');
    await reader.locator('input[type="file"]').setInputFiles(file);
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText('Long letter');
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText(noise.slice(-40));
  });

  test('/l without a letter offers "Open a letter file", and a file opens', async ({ page, browserName }) => {
    const link = await letterFor(page, browserName, 'Sent as a file.');
    const reader = await page.context().newPage();
    await reader.goto('/l');
    await expect(reader.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
    await reader.locator('input[type="file"]').setInputFiles({
      name: 'Sent as a file.kansoletter',
      mimeType: 'application/x-kansoletter',
      buffer: Buffer.from(link.split('#')[1]! + '\n'),
    });
    await expect(reader.getByRole('textbox', { name: 'Letter' })).toContainText('Sent as a file.', { timeout: 20_000 });
  });

  test('an oversized file is refused without being read', async ({ page }) => {
    await page.goto('/l');
    await page.evaluate(() => {
      const w = window as unknown as { reads: number };
      w.reads = 0;
      const real = Blob.prototype.text;
      Blob.prototype.text = function () {
        w.reads++;
        return real.call(this);
      };
    });
    await page.locator('input[type="file"]').setInputFiles({
      name: 'huge.kansoletter',
      mimeType: 'application/x-kansoletter',
      buffer: Buffer.alloc(256 * 1024 + 65, 'a'),
    });
    await expect(page.getByText('That file isn’t a Kansowriter letter.')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { reads: number }).reads)).toBe(0);
  });

  test('a file dropped anywhere on the reader opens there, never navigating away', async ({ page }) => {
    const encoded = await slowLetter();
    await page.goto('/l');
    await expect(page.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
    // outside the drop zone, on the page itself
    expect(await dropFile(page, 'main', 'a.kansoletter', encoded)).toEqual({ over: true, drop: true });
    await expect(page.getByRole('textbox', { name: 'Letter' })).toContainText('One');
    expect(new URL(page.url()).pathname).toBe('/l');
    // and while a letter is showing
    const other = await encodeTestLetter({ v: 1, baseText: 'A second letter.', ops: [] });
    expect(await dropFile(page, 'main', 'b.kansoletter', other)).toEqual({ over: true, drop: true });
    await expect(page.getByRole('textbox', { name: 'Letter' })).toHaveText('A second letter.');
    // and on the damaged view
    await page.goto('/l#v1.garbage');
    await expect(page.getByRole('alert')).toBeVisible();
    expect(await dropFile(page, 'main', 'c.kansoletter', other)).toEqual({ over: true, drop: true });
    await expect(page.getByRole('textbox', { name: 'Letter' })).toHaveText('A second letter.');
  });

  test('a launched file that fails to read never replaces a letter opened since', async ({ page }) => {
    // an installed app's launchQueue (R1), stood in for: the test holds the file read open
    await page.addInitScript(() => {
      const w = window as unknown as { launch?: (p: unknown) => void };
      // Chromium has its own (read-only) launchQueue
      Object.defineProperty(window, 'launchQueue', {
        configurable: true,
        value: { setConsumer: (c: (p: unknown) => void) => (w.launch = c) },
      });
    });
    await page.goto('/l');
    await expect(page.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
    await page.evaluate(() => {
      const w = window as unknown as { launch: (p: unknown) => void; failFile?: () => void };
      w.launch({ files: [{ getFile: () => new Promise((_, reject) => (w.failFile = () => reject(new Error('gone')))) }] });
    });
    const encoded = await encodeTestLetter({ v: 1, baseText: 'Opened from a link.', ops: [] });
    await page.evaluate((hash) => (location.hash = hash), encoded);
    const letter = page.getByRole('textbox', { name: 'Letter' });
    await expect(letter).toHaveText('Opened from a link.');
    await page.evaluate(() => (window as unknown as { failFile: () => void }).failFile());
    // a failed read settles after the link: give it a turn to (wrongly) take over
    await page.evaluate(() => new Promise((r) => setTimeout(r, 100)));
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(letter).toHaveText('Opened from a link.');
  });

  test('"/l/" with a trailing slash opens the reader', async ({ page }) => {
    const encoded = await encodeTestLetter({ v: 1, baseText: 'Trailing slash.', ops: [] });
    await page.goto(`/l/#${encoded}`);
    await expect(page.getByRole('textbox', { name: 'Letter' })).toHaveText('Trailing slash.');
    expect(new URL(page.url()).pathname).toBe('/l');
    expect(new URL(page.url()).hash).toBe(`#${encoded}`);
  });

  test('clearing the fragment shows the empty reader', async ({ page }) => {
    await page.goto(`/l#${await slowLetter()}`);
    await expect(page.getByRole('textbox', { name: 'Letter' })).toBeVisible();
    await page.evaluate(() => (location.hash = ''));
    await expect(page.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Letter' })).toHaveCount(0);
  });

  test('a damaged link says so calmly', async ({ page }) => {
    await page.goto('/l#v1.garbage');
    await expect(page.getByText(DAMAGED)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
  });

  test('a letter from a newer Kansowriter says so, not that it was damaged', async ({ page }) => {
    await page.goto('/l#v2.c29tZXRoaW5nIG5ldw');
    await expect(page.getByRole('alert')).toHaveText('This letter was written with a newer Kansowriter. Open it in the latest version.');
    await expect(page.getByText(DAMAGED)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy link' })).toBeVisible();
  });

  test('a file that isn’t a letter says so, and offers another file', async ({ page }) => {
    await page.goto('/l');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'photo.png',
      mimeType: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
    });
    await expect(page.getByRole('alert')).toHaveText('That file isn’t a Kansowriter letter.');
    await expect(page.getByText(DAMAGED)).toHaveCount(0);
    // and the way forward still opens a letter
    await expect(page.getByRole('button', { name: 'Open a letter file' })).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'a.kansoletter',
      mimeType: 'application/x-kansoletter',
      buffer: Buffer.from(await encodeTestLetter({ v: 1, baseText: 'The right file.', ops: [] })),
    });
    await expect(page.getByRole('textbox', { name: 'Letter' })).toHaveText('The right file.');
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
    await reader.goto(readerPath(link));
    await toTheEnd(reader);
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

  test('words that couldn’t be saved are named in the panel', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'Saved words.');
    await settle(page);
    await failIdb(page, ['add', 'put']);
    await write(page, editor, ' Unsaved words.');
    const dialog = await openSend(page);
    await expect(dialog.getByText('Your newest words aren’t saved yet, so they aren’t in this letter.')).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Letter preview' })).toContainText('Saved words.', { timeout: 20_000 });
  });

  test('while Send is open the editor shortcuts stay out of the way', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'Hello.');
    const dialog = await openSend(page);
    const m = await mod(page);
    await page.keyboard.press(`${m}+K`);
    await expect(page.getByPlaceholder('Search commands and settings')).toHaveCount(0);
    await expect(dialog).toBeVisible();
    // its own shortcut closes it again
    await page.keyboard.press(`${m}+Shift+L`);
    await expect(dialog).toBeHidden();
  });

  test('Send opened from the envelope returns focus to the envelope', async ({ page }) => {
    test.skip(isMobile(page), 'the envelope is hidden on phones (hide-phone); Send opens from the palette there');
    const editor = await startWriting(page);
    await write(page, editor, 'Hello.');
    await page.mouse.move(200, 300);
    await page.mouse.move(240, 340);
    const envelope = page.getByRole('button', { name: 'Send as letter' });
    // from the keyboard: WebKit (like Safari) doesn't focus a button on click, so there would be no opener to return to
    await envelope.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Send as letter' });
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(envelope).toBeFocused();
  });

  test('the reader and the send panel pass axe', async ({ page, browserName }) => {
    test.slow(); // three axe passes plus a written letter
    const link = await letterFor(page, browserName, '# A note\n\nShort and kind.');
    expect((await new AxeBuilder({ page }).include('.send-wrap').analyze()).violations).toEqual([]);
    const reader = await page.context().newPage();
    await reader.emulateMedia({ reducedMotion: 'reduce' }); // the end link without its fade
    await reader.goto(readerPath(link));
    await toTheEnd(reader);
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

  test('the service worker never answers a letter navigation with the cached shell', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'reads the generated sw.js once; the rule is the same file for every browser');
    const sw = await (await page.request.get('/sw.js')).text();
    // workbox's NavigationRoute denylist (the /l pattern), tested as workbox does: pathname + search
    const deny = /denylist:\s*\[\s*\/(.+?)\/\s*\]/.exec(sw)?.[1];
    expect(deny).toBeDefined();
    const denied = new RegExp(deny!);
    for (const url of ['/l', '/l/', '/l?fbclid=x', '/l/?utm_source=chat']) expect(denied.test(url), url).toBe(true);
    for (const url of ['/', '/about', '/letters', '/l2', '/l/x']) expect(denied.test(url), url).toBe(false);
    // and a NetworkFirst route for /l navigations, falling back to the precached shell
    expect(sw).toContain('NetworkFirst');
    expect(sw).toContain('letter-reader');
    expect(sw).toMatch(/handlerDidError:async\(\)=>[^]*?caches\.match\("\/index\.html",\{ignoreSearch:!0\}/);
  });

  test('offline, a letter opened for the first time still reaches the reader', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'one engine is enough for the worker rule; Playwright’s offline mode reaches Chromium’s worker');
    await page.goto('/about');
    // installed and active: the precache (with the shell) is complete
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true);
    try {
      // /l was never fetched in this context, so the letter-reader cache is empty
      const encoded = await encodeTestLetter({ v: 1, baseText: 'Read on a plane.', ops: [] });
      for (const path of [`/l#${encoded}`, `/l?fbclid=x#${encoded}`]) {
        await page.goto(path);
        await expect(page.getByRole('textbox', { name: 'Letter' })).toHaveText('Read on a plane.');
      }
    } finally {
      await context.setOffline(false);
    }
  });
});
