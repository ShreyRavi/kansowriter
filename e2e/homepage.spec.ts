import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { freshStart, mod, startWriting } from './helpers';

const SOURCE = 'https://github.com/ShreyRavi/kansowriter';

/** The homepage with no drafts, scrolled so the demo is in view. */
async function homepage(page: Page) {
  await freshStart(page);
  await page.goto('/about');
  await expect(page.getByRole('button', { name: 'Start writing' })).toBeVisible();
  await page.locator('.demo-frame').scrollIntoViewIfNeeded();
  const video = page.locator('.demo video');
  await expect(video).toBeAttached();
  return video;
}

test.describe('homepage demo', () => {
  test('a silent looping video with both formats, a poster and a text alternative', async ({ page }) => {
    const video = await homepage(page);
    const sources = video.locator('source');
    await expect(sources).toHaveCount(2);
    await expect(sources.nth(0)).toHaveAttribute('type', /video\/webm/);
    await expect(sources.nth(0)).toHaveAttribute('src', /\/assets\/demo-paper-.*\.webm$/);
    await expect(sources.nth(1)).toHaveAttribute('type', 'video/mp4');
    await expect(sources.nth(1)).toHaveAttribute('src', /\/assets\/demo-paper-.*\.mp4$/);
    await expect(video).toHaveAttribute('poster', /\/assets\/demo-paper-.*\.webp$/);
    await expect(video).toHaveAttribute('preload', 'none');
    await expect(video).toHaveAttribute('aria-label', /letter/);
    expect(await video.evaluate((v: HTMLVideoElement) => ({ muted: v.muted, loop: v.loop, inline: v.playsInline }))).toEqual({
      muted: true,
      loop: true,
      inline: true,
    });
    await expect(page.locator('#demo-desc')).toContainText('Hello, old friend');
    // it plays on its own while in view, and the visitor can pause it
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0), { timeout: 15_000 }).toBe(true);
    await page.getByRole('button', { name: 'Pause the demo' }).click();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    await expect(page.getByRole('button', { name: 'Play the demo' })).toBeVisible();
  });

  test('the files are served with media types', async ({ request, page }) => {
    const video = await homepage(page);
    for (const src of await video.locator('source').evaluateAll((s) => s.map((x) => x.getAttribute('src')!))) {
      const r = await request.get(src, { headers: { Range: 'bytes=0-99' } });
      expect(r.status(), src).toBeLessThan(300);
      expect(r.headers()['content-type'], src).toMatch(/^video\/(webm|mp4)/);
    }
  });

  test('the night variant shows in dark mode, and for an explicit Dark theme', async ({ browser }) => {
    const dark = await browser.newPage({ colorScheme: 'dark' });
    const video = await homepage(dark);
    await expect(video).toHaveAttribute('data-theme-variant', 'night');
    await expect(video.locator('source').first()).toHaveAttribute('src', /demo-night-/);
    await expect(video).toHaveAttribute('poster', /demo-night-/);
    await expect(dark.locator('.how img').first()).toHaveAttribute('src', /demo-step-write-night-/);
    await dark.close();

    // the app's own choice wins over the device's light setting
    const light = await browser.newPage({ colorScheme: 'light' });
    await freshStart(light);
    // before any app code runs (a booting store would otherwise write its own choice back)
    await light.addInitScript(() => localStorage.setItem('kansowriter-theme', 'night'));
    await light.goto('/about');
    await light.locator('.demo-frame').scrollIntoViewIfNeeded();
    await expect(light.locator('.demo video')).toHaveAttribute('data-theme-variant', 'night');
    await light.close();
  });

  test('reduced motion: no autoplay, the poster and a Play button', async ({ browser }) => {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    const video = await homepage(page);
    await expect(video).toHaveAttribute('poster', /demo-paper-/);
    await page.waitForTimeout(1500);
    expect(await video.evaluate((v: HTMLVideoElement) => ({ paused: v.paused, autoplay: v.autoplay, t: v.currentTime }))).toEqual({
      paused: true,
      autoplay: false,
      t: 0,
    });
    await page.getByRole('button', { name: 'Play the demo' }).click();
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
    await page.close();
  });

  test('How letters work: three steps, no horizontal overflow, axe passes', async ({ page }) => {
    await homepage(page);
    const how = page.getByRole('region', { name: 'How letters work' });
    await expect(how.getByRole('heading', { level: 2 })).toHaveText('How letters work');
    await expect(how.getByRole('heading', { level: 3 })).toHaveText(['Write', 'Send as letter', 'They watch it unfold']);
    await expect(how).toContainText('anyone with the link can read it');
    for (const img of await how.locator('img').all()) await expect(img).toHaveAttribute('alt', /.+/);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });

  test('the footer links the build’s commit and the source', async ({ page }) => {
    await homepage(page);
    const footer = page.locator('.landing footer');
    await expect(footer.getByRole('link', { name: 'Source' })).toHaveAttribute('href', SOURCE);
    const commit = footer.locator(`a[href^="${SOURCE}/commit/"]`);
    if (await commit.count()) {
      // whatever the commit is: the link holds the full sha, the label its first 7 characters
      const href = (await commit.getAttribute('href'))!;
      const sha = /\/commit\/([0-9a-f]{40})$/.exec(href)?.[1];
      expect(sha, href).toBeTruthy();
      await expect(commit).toHaveText(`v ${sha!.slice(0, 7)}`);
      await expect(commit).toHaveAttribute('target', '_blank');
      await expect(commit).toHaveAttribute('rel', /noopener/);
    } else await expect(footer).toContainText('dev'); // a build that didn't know its commit
  });
});

test('the palette’s About row shows the version and opens the source', async ({ page, context, isMobile }) => {
  await startWriting(page);
  if (isMobile) {
    await page.touchscreen.tap(5, 400);
    await page.getByRole('button', { name: 'Open commands' }).click();
  } else await page.keyboard.press(`${await mod(page)}+k`);
  await page.getByPlaceholder('Search commands and settings').fill('about');
  const row = page.getByRole('option', { name: /About Kansowriter/ });
  await expect(row).toContainText(/(v [0-9a-f]{7}|dev) · Source/);
  await context.route(`${SOURCE}**`, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'source' }));
  const popup = context.waitForEvent('page');
  if (isMobile) await row.click();
  else {
    await expect(page.locator('[cmdk-item][data-selected="true"]')).toContainText('About Kansowriter');
    await page.keyboard.press('Enter');
  }
  expect((await popup).url()).toBe(SOURCE);
});
