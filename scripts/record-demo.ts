// Records the homepage demo: a short letter typed into the real built app, sent as a letter link,
// and replayed in the reader. One take per theme (paper, night), captured as CDP screencast frames
// at 2x device scale, assembled by ffmpeg at a steady frame rate (the writing and the replay are
// sped up), then encoded to the files the homepage and README ship:
//
//   src/ui/demo/demo-{paper,night}.mp4    H.264, +faststart (Safari)
//   src/ui/demo/demo-{paper,night}.webm   VP9 (Chrome, Firefox)
//   src/ui/demo/demo-{paper,night}.webp   poster (the finished letter in the reader)
//   src/ui/demo/demo-step-{write,send,read}-{paper,night}.webp   "How letters work" screenshots (1140 × 713)
//   docs/demo.gif                         README GIF (paper, 640px)
//
// Run: npm run build && npm run record:demo   (needs ffmpeg and cwebp on PATH: brew install ffmpeg webp)
// Options: --base-url http://localhost:4317 (use a running preview instead of starting one),
//          --theme paper|night (one take only), --keep (keep the raw frames in .demo-frames/).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'src/ui/demo');
const GIF = join(ROOT, 'docs/demo.gif');
const WORK = join(ROOT, '.demo-frames');
/** the page as recorded (CSS px); frames are twice this */
const VIEW = { width: 960, height: 600 };
const SCALE = 2;
/** encoded width: 4/3 of the CSS width, so 21px body text is 28px in the file */
const ENCODE_WIDTH = 1280;
const FPS = 30;
/** the "How letters work" screenshots: 760 × 475 CSS px around the text column, from `y` down */
const STEP_CLIP = (y: number) => ({ x: 100, y, width: 760, height: 475 });

type Theme = 'paper' | 'night';
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const themes: Theme[] = opt('theme') ? [opt('theme') as Theme] : ['paper', 'night'];

// The letter: typed with a pause, an italic touch (⌘I) and one rewritten word.
// `[i]` toggles italic; `{back:N}` deletes N characters; `{pause:ms}` waits.
const SCRIPT = [
  'Hello, old friend,',
  '\n\n',
  'The tomatoes finally came in. I ate the first one standing in the garden, [i]still warm[i] from the sun.',
  '\n\n',
  '{pause:2400}',
  'I keep thinking about our walk by the river last spring. Let’s do it again soon.',
  '{pause:900}',
  '{back:5}',
  '{pause:500}',
  'before the leaves turn.',
  '\n\n',
  'Write back when you can. No hurry.',
];

/** seeded RNG (mulberry32): the same take every run */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a human-feeling gap after typing `ch` */
function gap(rand: () => number, ch: string): number {
  if (/[.,!?]/.test(ch)) return 220 + rand() * 260;
  if (ch === ' ') return 70 + rand() * 120;
  return 55 + rand() * 75 + (rand() < 0.06 ? 200 : 0);
}

async function typeLetter(page: Page, mod: string) {
  const rand = rng(20261031);
  for (const part of SCRIPT) {
    const pause = /^\{pause:(\d+)\}$/.exec(part);
    const back = /^\{back:(\d+)\}$/.exec(part);
    if (pause) await page.waitForTimeout(Number(pause[1]));
    else if (back)
      for (let i = 0; i < Number(back[1]); i++) {
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(90 + rand() * 40);
      }
    else if (part === '\n\n') {
      await page.waitForTimeout(350);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(120);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700 + rand() * 300);
    } else {
      for (const piece of part.split(/(\[i\])/)) {
        if (piece === '[i]') {
          await page.keyboard.press(`${mod}+i`);
          await page.waitForTimeout(160);
          continue;
        }
        for (const ch of piece) {
          await page.keyboard.type(ch);
          await page.waitForTimeout(gap(rand, ch));
        }
      }
    }
  }
}

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => res(port));
    });
  });

async function waitFor(url: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no server at ${url}`);
}

interface Frame {
  file: string;
  at: number;
}
/** a stretch of the take played at `speed` (2 = twice as fast) */
interface Segment {
  from: number;
  speed: number;
}

async function record(base: string, theme: Theme) {
  const dir = join(WORK, theme);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: SCALE,
    colorScheme: theme === 'night' ? 'dark' : 'light',
    reducedMotion: 'no-preference',
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  const mod = (await page.evaluate(() => /Mac/.test(navigator.platform))) ? 'Meta' : 'Control';

  await page.goto(`${base}/about`);
  await page.getByRole('button', { name: 'Start writing' }).click();
  const editor = page.getByRole('textbox', { name: 'Draft' });
  await editor.waitFor();
  await page.evaluate(() => document.fonts.ready);
  await editor.click();
  // the pointer rests out of the way (headless draws no cursor); chrome fades as typing starts
  await page.mouse.move(VIEW.width - 2, VIEW.height / 2);
  await page.waitForTimeout(600);

  const cdp = await context.newCDPSession(page);
  const frames: Frame[] = [];
  const pending: Promise<unknown>[] = [];
  let n = 0;
  cdp.on('Page.screencastFrame', (e) => {
    const file = join(dir, `f${String(++n).padStart(5, '0')}.jpg`);
    frames.push({ file, at: e.metadata.timestamp ?? Date.now() / 1000 });
    writeFileSync(file, Buffer.from(e.data, 'base64'));
    pending.push(cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {}));
  });
  const now = () => Date.now() / 1000;
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 95,
    maxWidth: VIEW.width * SCALE,
    maxHeight: VIEW.height * SCALE,
  });
  const segments: Segment[] = [{ from: now(), speed: 1 }];
  await page.waitForTimeout(1200);

  // 1. write
  segments.push({ from: now(), speed: 2.5 });
  await typeLetter(page, mod);
  segments.push({ from: now(), speed: 1 });
  await page.waitForTimeout(1500);
  // the "Write" step screenshot: the finished draft
  await page.screenshot({ path: join(dir, 'step-write.png'), clip: STEP_CLIP(110) });
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  // 2. send as letter: the envelope's shortcut, the live preview, Copy link
  await page.keyboard.press(`${mod}+Shift+L`);
  const dialog = page.getByRole('dialog', { name: 'Send as letter' });
  await dialog.getByText(/Fits in a link/).waitFor();
  // the dialog focuses its Close button (a focus ring and tooltip after a shortcut): not in the film
  await blur();
  await page.waitForTimeout(3400);
  await dialog.getByRole('button', { name: 'Copy link' }).click();
  await dialog.getByRole('button', { name: 'Copied' }).waitFor();
  await page.waitForTimeout(1400);
  const link = await page.evaluate(() => navigator.clipboard.readText());
  if (!link.includes('/l#v1.')) throw new Error(`unexpected letter link: ${link.slice(0, 60)}`);

  // 3. the reader: production links use the canonical origin; open the same letter here
  segments.push({ from: now(), speed: 1 });
  await page.goto(`${base}/l${link.slice(link.indexOf('#'))}`);
  await page.getByRole('textbox', { name: 'Letter' }).waitFor();
  await page.mouse.move(VIEW.width - 2, VIEW.height - 2);
  segments.push({ from: now(), speed: 4 });
  await page.locator('.replay.ended').waitFor({ timeout: 120_000 });
  segments.push({ from: now(), speed: 1 });
  await page.waitForTimeout(3200);
  const end = now();

  await cdp.send('Page.stopScreencast');
  await Promise.all(pending);

  // off camera: the send panel and the reader screenshots, each once its replay is well along
  const shot = await context.newPage();
  await shot.goto(`${base}/`);
  await shot.getByRole('textbox', { name: 'Draft' }).waitFor();
  await shot.keyboard.press(`${mod}+Shift+L`);
  await shot
    .getByRole('dialog', { name: 'Send as letter' })
    .getByText(/Fits in a link/)
    .waitFor();
  await shot.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await shot
    .locator('.send-preview')
    .getByText(/river last spring/)
    .waitFor({ timeout: 60_000 });
  await shot.screenshot({ path: join(dir, 'step-send.png'), clip: STEP_CLIP(125) });
  await shot.goto(`${base}/l${link.slice(link.indexOf('#'))}`);
  await shot.getByText(/our walk by the/).waitFor({ timeout: 60_000 });
  await shot.screenshot({ path: join(dir, 'step-read.png'), clip: STEP_CLIP(110) });
  await browser.close();
  return { dir, frames, segments, end };
}

/** concat-demuxer list: each frame held for its (speed-scaled) share of the take */
function timeline(frames: Frame[], segments: Segment[], end: number): { list: string; seconds: number } {
  const speedAt = (t: number) => [...segments].reverse().find((s) => t >= s.from)?.speed ?? 1;
  // scaled duration of [a, b): integrate across segment boundaries
  const scaled = (a: number, b: number) => {
    let total = 0;
    let t = a;
    while (t < b) {
      const next = Math.min(b, segments.find((s) => s.from > t)?.from ?? b);
      total += (next - t) / speedAt(t);
      t = next;
    }
    return total;
  };
  const start = segments[0]!.from;
  const kept = frames.filter((f) => f.at >= start - 0.5).sort((a, b) => a.at - b.at);
  let list = '';
  let seconds = 0;
  kept.forEach((f, i) => {
    const d = scaled(Math.max(start, f.at), i + 1 < kept.length ? kept[i + 1]!.at : end);
    seconds += d;
    list += `file '${f.file}'\nduration ${d.toFixed(4)}\n`;
  });
  list += `file '${kept[kept.length - 1]!.file}'\n`;
  return { list, seconds };
}

const ff = (...a: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const kb = (f: string) => `${(statSync(f).size / 1024).toFixed(0)} KB`;

function encode(theme: Theme, dir: string, list: string) {
  const listFile = join(dir, 'list.txt');
  writeFileSync(listFile, list);
  const master = join(dir, 'master.mkv');
  // a steady 30 fps, downscaled once with lanczos (2x capture → crisp text), lossless intermediate
  ff(
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-vf',
    `fps=${FPS},scale=${ENCODE_WIDTH}:-2:flags=lanczos,format=yuv444p`,
    '-c:v',
    'libx264',
    '-qp',
    '0',
    '-preset',
    'ultrafast',
    master,
  );
  const mp4 = join(OUT, `demo-${theme}.mp4`);
  const webm = join(OUT, `demo-${theme}.webm`);
  ff(
    '-i',
    master,
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryslow',
    '-tune',
    'animation',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-movflags',
    '+faststart',
    mp4,
  );
  ff(
    '-i',
    master,
    '-an',
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '30',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-deadline',
    'good',
    '-cpu-used',
    '1',
    '-pix_fmt',
    'yuv420p',
    webm,
  );
  // poster: the finished letter in the reader (the take's last frame)
  const posterPng = join(dir, 'poster.png');
  ff('-sseof', '-0.5', '-i', master, '-frames:v', '1', '-update', '1', posterPng);
  const poster = join(OUT, `demo-${theme}.webp`);
  execFileSync('cwebp', ['-quiet', '-q', '82', '-m', '6', posterPng, '-o', poster]);
  for (const step of ['write', 'send', 'read']) {
    const out = join(OUT, `demo-step-${step}-${theme}.webp`);
    execFileSync('cwebp', ['-quiet', '-q', '84', '-m', '6', '-resize', '1140', '0', join(dir, `step-${step}.png`), '-o', out]);
  }
  if (theme === 'paper') {
    const palette = join(dir, 'palette.png');
    const vf = 'fps=12,scale=640:-2:flags=lanczos';
    ff('-i', master, '-vf', `${vf},palettegen=max_colors=64:stats_mode=diff`, palette);
    ff('-i', master, '-i', palette, '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=none:diff_mode=rectangle`, GIF);
    console.log(`  ${GIF}: ${kb(GIF)}`);
  }
  console.log(`  ${mp4}: ${kb(mp4)}\n  ${webm}: ${kb(webm)}\n  ${poster}: ${kb(poster)}`);
}

async function main() {
  for (const tool of ['ffmpeg', 'cwebp'])
    try {
      execFileSync(tool, tool === 'ffmpeg' ? ['-version'] : ['-version'], { stdio: 'ignore' });
    } catch {
      throw new Error(`${tool} not found (brew install ffmpeg webp)`);
    }
  mkdirSync(OUT, { recursive: true });
  let base = opt('base-url');
  let server: ReturnType<typeof spawn> | null = null;
  if (!base) {
    if (!existsSync(join(ROOT, 'dist/web/index.html'))) throw new Error('no build: run npm run build first');
    const port = await freePort();
    server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { cwd: ROOT, stdio: 'ignore' });
    base = `http://localhost:${port}`;
  }
  try {
    await waitFor(base);
    for (const theme of themes) {
      console.log(`recording ${theme}…`);
      const { dir, frames, segments, end } = await record(base, theme);
      const { list, seconds } = timeline(frames, segments, end);
      console.log(`  ${frames.length} frames → ${seconds.toFixed(1)} s`);
      encode(theme, dir, list);
    }
  } finally {
    server?.kill();
    if (!args.includes('--keep')) rmSync(WORK, { recursive: true, force: true });
  }
}

await main();
