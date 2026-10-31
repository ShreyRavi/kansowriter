// Fails if a CSP's script-src hash doesn't match the inline theme bootstrap in index.html (21A/R7):
// the web app's (vercel.json) and the macOS app's webview (src-tauri/tauri.conf.json).
// Pass the built page to check what ships: npm run csp:check -- dist/web/index.html
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync(process.argv[2] ?? 'index.html', 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const hashes = inline.map((s) => createHash('sha256').update(s).digest('base64'));
let failed = false;
for (const file of ['vercel.json', 'src-tauri/tauri.conf.json']) {
  const csp = readFileSync(file, 'utf8');
  const missing = hashes.filter((h) => !csp.includes(`'sha256-${h}'`));
  if (missing.length) {
    console.error(`${file}: CSP is missing inline script hashes: ${missing.join(', ')}`);
    failed = true;
  }
}
if (failed) process.exit(1);
console.log(`CSP covers ${hashes.length} inline script(s) in vercel.json and src-tauri/tauri.conf.json`);
