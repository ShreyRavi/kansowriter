// Generates src/ui/tokens.css from DESIGN.md front matter (15A). `--check` fails if the file is stale.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';

type Tree = { [k: string]: string | Tree };

const src = readFileSync('DESIGN.md', 'utf8');
const match = src.match(/^---\n([\s\S]*?)\n---/);
if (!match?.[1]) throw new Error('DESIGN.md has no front matter');
const fm = parse(match[1]) as Tree;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

function flatten(tree: Tree, prefix: string, out: string[]) {
  for (const [k, v] of Object.entries(tree)) {
    const name = `${prefix}-${kebab(k)}`;
    if (typeof v === 'string' || typeof v === 'number') out.push(`  ${name}: ${v};`);
    else flatten(v, name, out);
  }
}

const colors = fm.colors as Tree;
const rest: string[] = [];
for (const group of ['type', 'rounded', 'space', 'motion']) flatten(fm[group] as Tree, `--${group}`, rest);
const paper: string[] = [];
flatten(colors.paper as Tree, '--c', paper);
const night: string[] = [];
flatten(colors.night as Tree, '--c', night);

const css = `/* Generated from DESIGN.md by scripts/gen-tokens.ts. Do not edit. */
:root {
${rest.join('\n')}
${paper.join('\n')}
  color-scheme: light;
}
:root[data-theme='night'] {
${night.join('\n')}
  color-scheme: dark;
}
`;

const out = 'src/ui/tokens.css';
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== css) {
    console.error('src/ui/tokens.css is stale. Run `npm run tokens`.');
    process.exit(1);
  }
  console.log('tokens.css up to date');
} else {
  writeFileSync(out, css);
  console.log('wrote', out);
}
