// R11: a new deploy's service worker waits while any Kansowriter tab is open. It never reloads or
// takes over an open page (the writer keeps typing into the version it loaded), and it activates
// once every tab has closed.
// Value: protects=a deploy never reloads or claims an open tab, and the new worker activates after all tabs close;
//   fails_when=skipWaiting/clientsClaim are enabled, registerType becomes autoUpdate, or a reload-on-update is added;
//   why_new=nothing exercised the update path (QA only observed it); seam=none;
//   no_claim=a real CDN deploy (the "deploy" rewrites dist/sw.js under the local preview; Chromium only)
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { settle, startWriting, write } from './helpers';

test('a new service worker waits for every tab to close and never reloads the page (R11)', async ({
  page,
  context,
  browserName,
  isMobile,
}) => {
  test.skip(browserName !== 'chromium' || !!isMobile, 'one engine is enough for the update policy; desktop Chromium');
  test.skip(!!process.env.BASE_URL, 'needs the local preview: the "deploy" rewrites dist/sw.js');
  const editor = await startWriting(page);
  await write(page, editor, 'mid-sentence when the deploy lands');
  await settle(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  // the first load is uncontrolled (clientsClaim off); reload once so this tab runs under the worker
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const firstWorker = await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL);
  await page.evaluate(() => ((window as unknown as { __loadMarker: number }).__loadMarker = 42));

  // "deploy": the preview now serves a changed sw.js (restored at the end)
  const original = readFileSync('dist/sw.js', 'utf8');
  writeFileSync('dist/sw.js', `${original}\n// deploy ${Date.now()}\n`);
  try {
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());

    // the new worker installs and then waits: the open tab keeps its page and its old controller
    await expect
      .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), { timeout: 15_000 })
      .toBe(true);
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => (window as unknown as { __loadMarker?: number }).__loadMarker)).toBe(42);
    await expect(page.getByRole('textbox', { name: 'Draft' })).toContainText('mid-sentence when the deploy lands');
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveAttribute('contenteditable', 'true');
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(firstWorker);

    // once the last tab closes, the waiting worker activates for the next visit
    const origin = new URL(page.url()).origin;
    await page.close();
    const next = await context.newPage();
    await next.goto(`${origin}/about`);
    await expect
      .poll(
        () =>
          next.evaluate(async () => {
            const r = await navigator.serviceWorker.getRegistration();
            return !!r?.active && !r.waiting;
          }),
        { timeout: 15_000 },
      )
      .toBe(true);
  } finally {
    writeFileSync('dist/sw.js', original);
  }
});
