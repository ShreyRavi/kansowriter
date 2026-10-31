// R11: a new deploy's service worker waits while any Kansowriter tab is open. It never reloads or
// takes over an open page (the writer keeps typing into the version it loaded), and it activates
// once every tab has closed.
// Value: protects=a deploy never reloads or claims an open tab, and the new worker activates after all tabs close;
//   fails_when=skipWaiting/clientsClaim are enabled, registerType becomes autoUpdate, or a reload-on-update is added;
//   why_new=nothing exercised the update path (QA only observed it); seam=none;
//   no_claim=a real CDN deploy (the "deploy" rewrites sw.js in a private copy of dist; Chromium only)
// Isolation: the suite runs fullyParallel against the shared preview, so this test never touches dist/web.
// It copies dist/web into its own output folder and serves that with its own `vite preview` on a free port:
// a different origin, so no other test can see (or install) the changed worker.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { failIdb, openDrafts, removeDraftsUnderneath, settle, startWriting, write } from './helpers';

const freePort = () =>
  new Promise<number>((done, fail) => {
    const srv = createServer();
    srv.once('error', fail);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => done(port));
    });
  });

async function privatePreview(outDir: string): Promise<{ url: string; server: ChildProcess }> {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  const server = spawn(
    resolve('node_modules/.bin/vite'),
    ['preview', '--outDir', outDir, '--port', String(port), '--strictPort', '--host', 'localhost'],
    { stdio: 'ignore', detached: process.platform !== 'win32' },
  );
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`private vite preview exited (${server.exitCode})`);
    const ok = await fetch(`${url}/about`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return { url, server };
    if (Date.now() > deadline) throw new Error('private vite preview never answered');
    await new Promise((r) => setTimeout(r, 250));
  }
}

function stop(server: ChildProcess) {
  if (server.exitCode !== null || !server.pid) return;
  try {
    if (process.platform === 'win32') server.kill();
    else process.kill(-server.pid, 'SIGTERM'); // the whole group: vite may run under a shell shim
  } catch {
    server.kill();
  }
}

test('a new service worker waits for every tab to close and never reloads the page (R11)', async ({
  browser,
  browserName,
  isMobile,
}, testInfo) => {
  test.skip(browserName !== 'chromium' || !!isMobile, 'one engine is enough for the update policy; desktop Chromium');
  test.skip(!!process.env.BASE_URL, 'needs a local build: the "deploy" rewrites sw.js in a private copy of dist');
  test.setTimeout(120_000);
  const dist = testInfo.outputPath('dist');
  cpSync('dist/web', dist, { recursive: true });
  const { url, server } = await privatePreview(dist);
  const context = await browser.newContext({ baseURL: url });
  try {
    const page = await context.newPage();
    const editor = await startWriting(page);
    await write(page, editor, 'mid-sentence when the deploy lands');
    await settle(page);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // the first load is uncontrolled (clientsClaim off); reload once so this tab runs under the worker
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    const firstWorker = await page.evaluate(() => navigator.serviceWorker.controller!.scriptURL);
    await page.evaluate(() => ((window as unknown as { __loadMarker: number }).__loadMarker = 42));

    // "deploy": the private preview now serves a changed sw.js
    const sw = resolve(dist, 'sw.js');
    writeFileSync(sw, `${readFileSync(sw, 'utf8')}\n// deploy ${Date.now()}\n`);
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
    await context.close();
    stop(server);
  }
});

// "Update ready · Reload" (R11): the notice is the only way a tab takes the new version, and only the
// tab that clicked reloads. Same private-preview isolation as above; desktop Chromium only.

/** Run `body` against a private preview of a copy of dist, in a fresh context on its origin. */
async function withPrivatePreview(browser: Browser, testInfo: TestInfo, body: (context: BrowserContext, dist: string) => Promise<void>) {
  const dist = testInfo.outputPath('dist');
  cpSync('dist/web', dist, { recursive: true });
  const { url, server } = await privatePreview(dist);
  const context = await browser.newContext({ baseURL: url });
  try {
    await body(context, dist);
  } finally {
    await context.close();
    stop(server);
  }
}

/** The first load is uncontrolled (clientsClaim off): reload once so the tab runs under the worker. */
async function underWorker(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Draft' })).toBeVisible();
}

const setMarker = (page: Page) => page.evaluate(() => ((window as unknown as { __loadMarker: number }).__loadMarker = 42));
/** 42 until this page reloads, then null; 'reloading' while the old document is being torn down. */
const marker = (page: Page) =>
  page
    .evaluate(() => (window as unknown as { __loadMarker?: number }).__loadMarker ?? null)
    .catch((e: Error) => {
      if (/context was destroyed|navigat/i.test(e.message)) return 'reloading' as const;
      throw e;
    });

/** "Deploy": the private copy serves a changed sw.js that answers 'version?' with 'v2'; `page` checks for it. */
async function deploy(dist: string, page: Page) {
  const sw = resolve(dist, 'sw.js');
  writeFileSync(
    sw,
    `${readFileSync(sw, 'utf8')}\nself.addEventListener('message', (e) => { if (e.data === 'version?') e.source.postMessage('v2'); });\n`,
  );
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())!.update());
  await expect
    .poll(() => page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting), { timeout: 15_000 })
    .toBe(true);
}

/** 'v2' when the deployed worker controls the page; null under the old one (it never answers). */
const controllerVersion = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string | null>((done) => {
        const c = navigator.serviceWorker.controller;
        if (!c) return done(null);
        const t = setTimeout(() => done(null), 1000);
        navigator.serviceWorker.addEventListener('message', function on(e) {
          if (e.data !== 'v2') return;
          clearTimeout(t);
          navigator.serviceWorker.removeEventListener('message', on);
          done('v2');
        });
        c.postMessage('version?');
      }),
  );

const updateReady = (page: Page) => page.getByRole('status').filter({ hasText: 'Update ready' });

test.describe('Update ready · Reload', () => {
  test.beforeEach(({ browserName, isMobile }) => {
    test.skip(browserName !== 'chromium' || !!isMobile, 'one engine is enough for the update policy; desktop Chromium');
    test.skip(!!process.env.BASE_URL, 'needs a local build: the "deploy" rewrites sw.js in a private copy of dist');
    test.setTimeout(120_000);
  });

  test('clean: Reload reloads this tab under the new worker; another open tab is not reloaded', async ({ browser }, testInfo) => {
    await withPrivatePreview(browser, testInfo, async (context, dist) => {
      const page = await context.newPage();
      const editor = await startWriting(page);
      await write(page, editor, 'the older draft');
      await settle(page);
      await openDrafts(page);
      await page.getByRole('dialog', { name: 'Drafts' }).getByRole('button', { name: 'New draft' }).click();
      await expect(page.getByRole('textbox', { name: 'Draft' })).not.toContainText('the older draft');
      await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveAttribute('contenteditable', 'true');
      await write(page, page.getByRole('textbox', { name: 'Draft' }), 'kept across the update');
      await settle(page);
      await underWorker(page);
      await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveText('kept across the update');

      // a second tab writes the other draft (no notice of its own, so it can show Update ready too)
      const second = await context.newPage();
      await second.goto('/');
      await expect(second.getByText('Open in another tab.')).toBeVisible();
      await openDrafts(second);
      await second
        .getByRole('dialog', { name: 'Drafts' })
        .getByRole('button', { name: /the older draft/ })
        .click();
      await expect(second.getByRole('textbox', { name: 'Draft' })).toHaveAttribute('contenteditable', 'true');
      await expect(second.getByRole('textbox', { name: 'Draft' })).toHaveText('the older draft');
      expect(await second.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
      await setMarker(page);
      await setMarker(second);

      await deploy(dist, page);
      await expect(updateReady(page)).toBeVisible({ timeout: 10_000 });
      await expect(updateReady(second)).toBeVisible({ timeout: 10_000 });
      expect(await marker(page)).toBe(42); // the notice alone never reloads

      await updateReady(page).getByRole('button', { name: 'Reload' }).click();
      await expect.poll(() => marker(page), { timeout: 15_000 }).toBeNull();
      await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveText('kept across the update');
      await expect.poll(() => controllerVersion(page), { timeout: 10_000 }).toBe('v2');
      await expect(updateReady(page)).toHaveCount(0);

      // the other tab keeps its page (and its words); the new worker now controls it without a reload
      await expect.poll(() => controllerVersion(second), { timeout: 10_000 }).toBe('v2');
      expect(await marker(second)).toBe(42);
      await expect(second.getByRole('textbox', { name: 'Draft' })).toHaveText('the older draft');
      await expect(second.getByRole('textbox', { name: 'Draft' })).toHaveAttribute('contenteditable', 'true');
      await expect(updateReady(second)).toBeVisible();
    });
  });

  test('dirty (saves failing): Reload asks first and reloads only on Leave anyway', async ({ browser }, testInfo) => {
    await withPrivatePreview(browser, testInfo, async (context, dist) => {
      const page = await context.newPage();
      const editor = await startWriting(page);
      await write(page, editor, 'first words');
      await settle(page);
      await underWorker(page);
      await setMarker(page);
      await deploy(dist, page);
      const reload = updateReady(page).getByRole('button', { name: 'Reload' });
      await expect(reload).toBeVisible({ timeout: 10_000 });

      await failIdb(page, ['add', 'put']);
      const draft = page.getByRole('textbox', { name: 'Draft' });
      await draft.click();
      await page.keyboard.press('End');
      // one open word (no space after it): nothing is written until Reload's flush, which fails
      await draft.pressSequentially(' unsaved');
      await reload.click();
      await expect(page.getByText('Your newest words aren’t saved.')).toBeVisible();
      await expect(draft).toContainText('first words unsaved');
      await page.waitForTimeout(1000); // "never reloads" needs a moment to have had the chance
      expect(await marker(page)).toBe(42);

      await page.getByRole('button', { name: 'Leave anyway' }).click();
      await expect.poll(() => marker(page), { timeout: 15_000 }).toBeNull();
      await expect.poll(() => controllerVersion(page), { timeout: 10_000 }).toBe('v2');
      await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveText('first words');
    });
  });

  test('stale: the update notice stays hidden while "This tab stopped saving." is up', async ({ browser }, testInfo) => {
    await withPrivatePreview(browser, testInfo, async (context, dist) => {
      const page = await context.newPage();
      const editor = await startWriting(page);
      await write(page, editor, 'first words');
      await settle(page);
      await underWorker(page);
      await removeDraftsUnderneath(page);
      const draft = page.getByRole('textbox', { name: 'Draft' });
      await draft.click();
      await page.keyboard.press('End');
      await draft.pressSequentially(' second');
      await expect(page.getByText('This tab stopped saving.')).toBeVisible({ timeout: 10_000 });
      await setMarker(page);

      await deploy(dist, page);
      await page.waitForTimeout(1500); // the waiting worker is there; give onNeedRefresh time to have rendered
      await expect(updateReady(page)).toHaveCount(0);
      await expect(page.getByText('This tab stopped saving.')).toBeVisible();
      await expect(draft).toHaveText('first words second');
      expect(await marker(page)).toBe(42);
    });
  });
});
