// Generates every icon from one design (DESIGN.md colors), rendered by Chromium so edges are antialiased.
//
//   ┌───────────────┐   two faint lines of writing, the ink caret at the end of the second,
//   │  ▬▬▬▬▬▬▬▬▬▬   │   and the olive goal line partly filled: the app in one glance.
//   │  ▬▬▬▬▬ ▌      │
//   │  ━━━━━━──────  │   favicon.svg drops the writing lines (legible at 16 px) and follows
//   └───────────────┘   the system dark mode; maskable/apple variants are full-bleed.
//
// Outputs (public/): favicon.svg, favicon.ico (32 px PNG inside), icon.svg, icon-192.png,
// icon-512.png, icon-maskable-512.png, apple-touch-icon.png (180). Run: npm run icons
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const PAPER = { ground: '#F5F0E6', ink: '#272320', faint: '#CBBFAA', track: '#E0D6C4', accent: '#5E6E3A' };
const NIGHT = { ground: '#1B1917', ink: '#E8E1D5', faint: '#4A443D', track: '#2E2A26', accent: '#B5BF86' };

/** Marks on a 512 grid, scaled by `s` around the center (maskable/apple keep a safe zone). */
function marks(s: number, writing = true, c = PAPER): string {
  const g = (inner: string) => `<g transform="translate(256 256) scale(${s}) translate(-256 -256)">${inner}</g>`;
  const lines = writing
    ? `<rect x="112" y="128" width="288" height="32" rx="16" fill="${c.faint}"/>
       <rect x="112" y="208" width="172" height="32" rx="16" fill="${c.faint}"/>`
    : '';
  const caret = writing
    ? `<rect x="306" y="180" width="28" height="92" rx="14" fill="${c.ink}"/>`
    : `<rect x="231" y="104" width="50" height="196" rx="25" fill="${c.ink}"/>`;
  const line = writing
    ? `<rect x="112" y="336" width="288" height="28" rx="14" fill="${c.track}"/>
       <rect x="112" y="336" width="188" height="28" rx="14" fill="${c.accent}"/>`
    : `<rect x="96" y="356" width="320" height="44" rx="22" fill="${c.track}"/>
       <rect x="96" y="356" width="208" height="44" rx="22" fill="${c.accent}"/>`;
  return g(lines + caret + line);
}

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${body}</svg>\n`;
const rounded = (c = PAPER) => `<rect width="512" height="512" rx="112" fill="${c.ground}"/>`;
const square = (c = PAPER) => `<rect width="512" height="512" fill="${c.ground}"/>`;

const icon = svg(rounded() + marks(1));
const favicon = svg(
  `<style>.n{display:none}@media (prefers-color-scheme: dark){.p{display:none}.n{display:inline}}</style>` +
    `<g class="p">${rounded()}${marks(1, false)}</g><g class="n">${rounded(NIGHT)}${marks(1, false, NIGHT)}</g>`,
);
const maskable = svg(square() + marks(0.78));
const apple = svg(square() + marks(0.86));

writeFileSync('public/icon.svg', icon);
writeFileSync('public/favicon.svg', favicon);

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(markup: string, size: number): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${markup.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

writeFileSync('public/icon-192.png', await render(icon, 192));
writeFileSync('public/icon-512.png', await render(icon, 512));
writeFileSync('public/icon-maskable-512.png', await render(maskable, 512));
writeFileSync('public/apple-touch-icon.png', await render(apple, 180));

// favicon.ico: one 32 px PNG wrapped in an ICO header (valid since Windows Vista; every browser)
const png32 = await render(svg(rounded() + marks(1, false)), 32);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // one image
ico[6] = 32; // width
ico[7] = 32; // height
ico.writeUInt16LE(1, 10); // planes
ico.writeUInt16LE(32, 12); // bits per pixel
ico.writeUInt32LE(png32.length, 14);
ico.writeUInt32LE(22, 18); // offset of the PNG
writeFileSync('public/favicon.ico', Buffer.concat([ico, png32]));

await browser.close();
console.log('icons written');
