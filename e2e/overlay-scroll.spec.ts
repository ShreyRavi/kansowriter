// Scrolling inside an overlay (palette, drafts sidebar, send panel) scrolls the overlay, never the
// draft behind it: the page is locked while an overlay is open, and the overlay's lists contain
// their own overscroll (src/ui/scrollLock.ts, styles.css).
import { expect, test, type Page } from '@playwright/test';
import { mod, openDrafts, startWriting } from './helpers';

const isMobile = (page: Page) => page.viewportSize()!.width < 640;
const scrollY = (page: Page) => page.evaluate(() => Math.round(window.scrollY));

/** A draft long enough to scroll, with the page scrolled part-way (so it could move either way). */
async function longDraft(page: Page) {
  const editor = await startWriting(page);
  await editor.click();
  await page.keyboard.insertText(Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of a long draft.`).join('\n\n'));
  await page.evaluate(() => window.scrollTo(0, Math.round(document.documentElement.scrollHeight / 2)));
  // CodeMirror measures the lines it brings into view over a few frames (its height estimates
  // settle and the scroll position follows): wait until both hold still
  let last = '';
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() => `${Math.round(window.scrollY)}:${document.documentElement.scrollHeight}`);
        const same = now === last;
        last = now;
        return same;
      },
      { intervals: [400] },
    )
    .toBe(true);
  expect(await scrollY(page)).toBeGreaterThan(200);
  return scrollY(page);
}

async function wheelAt(page: Page, x: number, y: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, dy);
  await page.waitForTimeout(250); // let a smooth scroll (and any chaining) land
}

test.describe('overlays keep the draft still', () => {
  test.beforeEach(({ page }) => {
    test.skip(isMobile(page), 'Playwright has no touch-scroll gesture (touchscreen is tap-only) and mobile WebKit has no mouse wheel');
  });

  test('wheel over the palette list scrolls the list; over the list end or the backdrop, nothing behind moves', async ({ page }) => {
    const before = await longDraft(page);
    await page.keyboard.press(`${await mod(page)}+K`);
    const list = page.locator('.palette [cmdk-list]');
    await expect(list).toBeVisible();
    const box = (await list.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await wheelAt(page, cx, cy, 300);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await scrollY(page)).toBe(before);

    // past the list's ends: the scroll is not handed on to the page
    await wheelAt(page, cx, cy, 5000);
    await wheelAt(page, cx, cy, -10000);
    await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
    await wheelAt(page, cx, cy, -2000);
    expect(await scrollY(page)).toBe(before);

    // the transparent backdrop around the palette
    const vp = page.viewportSize()!;
    await wheelAt(page, 12, vp.height - 12, -600);
    await wheelAt(page, 12, vp.height - 12, 600);
    expect(await scrollY(page)).toBe(before);

    // closed again, the page scrolls as before
    await page.keyboard.press('Escape');
    await expect(list).toBeHidden();
    await wheelAt(page, vp.width / 2, vp.height / 2, -300);
    await expect.poll(() => scrollY(page)).toBeLessThan(before);
  });

  test('the drafts sidebar and the send panel lock the page too', async ({ page }) => {
    const before = await longDraft(page);
    const vp = page.viewportSize()!;
    await openDrafts(page);
    await expect(page.getByRole('dialog', { name: 'Drafts' })).toBeVisible();
    await wheelAt(page, vp.width - 20, vp.height / 2, -600); // over the scrim
    await wheelAt(page, 60, vp.height / 2, -600); // over the sidebar's list
    expect(await scrollY(page)).toBe(before);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Drafts' })).toBeHidden();

    await page.keyboard.press(`${await mod(page)}+Shift+L`);
    const dialog = page.getByRole('dialog', { name: 'Send as letter' });
    await expect(dialog.getByText(/Fits in a link|Too long for a link/)).toBeVisible({ timeout: 20_000 });
    await wheelAt(page, vp.width / 2, vp.height / 3, -600); // over the preview
    await wheelAt(page, vp.width / 2, vp.height - 60, -600); // over the panel
    expect(await scrollY(page)).toBe(before);
  });
});
