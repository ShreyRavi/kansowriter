// Generates src/ui/tokens.css and src/ui/theme-colors.ts from DESIGN.md front matter (15A).
// `--check` fails if either file is stale, or if index.html's theme-color meta isn't the paper ground
// (index.html keeps a literal: the page is hash-pinned by its CSP, so it isn't generated).
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

const ground = (t: string) => (colors[t] as Tree).ground as string;
const themeColors = `// Generated from DESIGN.md by scripts/gen-tokens.ts. Do not edit.
/** Browser chrome and manifest color per theme: the paper / night ground. */
export const THEME_COLOR = { paper: '${ground('paper')}', night: '${ground('night')}' } as const;
`;

const outputs: [string, string][] = [
  ['src/ui/tokens.css', css],
  ['src/ui/theme-colors.ts', themeColors],
];
if (process.argv.includes('--check')) {
  let ok = true;
  for (const [out, content] of outputs) {
    if (!existsSync(out) || readFileSync(out, 'utf8') !== content) {
      console.error(`${out} is stale. Run \`npm run tokens\`.`);
      ok = false;
    }
  }
  const meta = readFileSync('index.html', 'utf8').match(/<meta name="theme-color" content="([^"]*)"/)?.[1];
  if (meta !== ground('paper')) {
    console.error(`index.html theme-color is ${meta ?? 'missing'}; set it to the paper ground ${ground('paper')}.`);
    ok = false;
  }
  if (!ok) process.exit(1);
  console.log('tokens.css, theme-colors.ts and index.html theme-color up to date');
} else {
  for (const [out, content] of outputs) {
    writeFileSync(out, content);
    console.log('wrote', out);
  }
}
