// Fails if vercel.json's script-src hash doesn't match the inline theme bootstrap in index.html (21A/R7).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const html = readFileSync(process.argv[2] ?? 'index.html', 'utf8');
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const hashes = inline.map((s) => createHash('sha256').update(s).digest('base64'));
const csp = readFileSync('vercel.json', 'utf8');
const missing = hashes.filter((h) => !csp.includes(`'sha256-${h}'`));
if (missing.length) {
  console.error(`CSP is missing inline script hashes: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`CSP covers ${hashes.length} inline script(s)`);
