// R11: a new deploy's service worker waits while any Kansowriter tab is open. It never reloads or
// takes over an open page (the writer keeps typing into the version it loaded), and it activates
// once every tab has closed.
// Value: protects=a deploy never reloads or claims an open tab, and the new worker activates after all tabs close;
//   fails_when=skipWaiting/clientsClaim are enabled, registerType becomes autoUpdate, or a reload-on-update is added;
//   why_new=nothing exercised the update path (QA only observed it); seam=none;
//   no_claim=a real CDN deploy (the "deploy" rewrites sw.js in a private copy of dist; Chromium only)
// Isolation: the suite runs fullyParallel against the shared preview, so this test never touches dist/.
// It copies dist into its own output folder and serves that with its own `vite preview` on a free port:
// a different origin, so no other test can see (or install) the changed worker.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { settle, startWriting, write } from './helpers';

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
  cpSync('dist', dist, { recursive: true });
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
