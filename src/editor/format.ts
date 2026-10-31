import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { ChangeSet, EditorSelection, type ChangeSpec, type EditorState, type Line, type TransactionSpec } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';

/**
 * Formatting commands (plain Markdown in, plain Markdown out). Every command is a pure function
 * EditorState → TransactionSpec | null, dispatched as one normal transaction: it is recorded as a
 * KOP op like any edit (so letters replay it) and is one undo step (isolated history).
 *
 *   line styles   title "# "  heading "## "  subheading "### "  bullet "- "  numbered "1. "
 *                 checklist "- [ ] "  quote "> "      (one per line; applying another swaps it)
 *   inline styles bold ** · italic * · underline <u>…</u> · strikethrough ~~
 *
 * Everything toggles: applying a style the selection already has removes it.
 */

export type LineStyle = 'title' | 'heading' | 'subheading' | 'bullet' | 'numbered' | 'check' | 'quote';
export type Paragraph = 'title' | 'heading' | 'subheading' | 'normal';
export type InlineStyle = 'bold' | 'italic' | 'underline' | 'strike';

export interface ActiveFormats {
  /** the caret line's paragraph style (the style menu's value) */
  paragraph: Paragraph;
  bullet: boolean;
  numbered: boolean;
  check: boolean;
  quote: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
}

export const NO_FORMATS: ActiveFormats = {
  paragraph: 'normal',
  bullet: false,
  numbered: false,
  check: false,
  quote: false,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
};

// ---------- line prefixes ----------

type Kind = LineStyle | null;

interface Prefix {
  indent: string;
  kind: Kind;
  /** offset in the line where the text after the marker starts */
  end: number;
  num?: number;
}

const PREFIX = /^([ \t]*)(?:(#{1,6})(?:[ \t]+|$)|>[ \t]?|[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)|[-*+](?:[ \t]+|$)|(\d{1,9})[.)](?:[ \t]+|$))/;

export function parsePrefix(text: string): Prefix {
  const m = PREFIX.exec(text);
  if (!m) return { indent: '', kind: null, end: 0 };
  const indent = m[1]!;
  const body = m[0].slice(indent.length);
  let kind: Kind;
  if (m[2]) kind = m[2].length === 1 ? 'title' : m[2].length === 2 ? 'heading' : 'subheading';
  else if (body.startsWith('>')) kind = 'quote';
  else if (m[3]) kind = 'numbered';
  else if (/^[-*+][ \t]+\[/.test(body)) kind = 'check';
  else kind = 'bullet';
  return { indent, kind, end: m[0].length, num: m[3] ? Number(m[3]) : undefined };
}

const MARKER: Record<Exclude<LineStyle, 'numbered'>, string> = {
  title: '# ',
  heading: '## ',
  subheading: '### ',
  bullet: '- ',
  check: '- [ ] ',
  quote: '> ',
};
const isList = (k: Kind) => k === 'bullet' || k === 'numbered' || k === 'check';
const blank = (l: Line) => !l.text.trim();

/** Lines the selection touches; a range ending at a line's very start doesn't take that line. */
function selectedLines(state: EditorState, limit = Infinity): Line[] {
  const seen = new Set<number>();
  const out: Line[] = [];
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number;
    let last = state.doc.lineAt(r.to).number;
    if (!r.empty && last > first && state.doc.line(last).from === r.to) last--;
    for (let n = first; n <= last && out.length < limit; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(state.doc.line(n));
    }
  }
  return out.sort((a, b) => a.number - b.number);
}

/** the lines a line style applies to: the non-blank ones, or the blank caret line itself */
function targetLines(state: EditorState, limit?: number): Line[] {
  const lines = selectedLines(state, limit);
  const filled = lines.filter((l) => !blank(l));
  return filled.length ? filled : lines;
}

const transaction = (spec: TransactionSpec): TransactionSpec => ({
  ...spec,
  userEvent: 'input.format',
  annotations: isolateHistory.of('full'),
  scrollIntoView: true,
});

/**
 * Numbered runs (consecutive numbered lines at one indent; deeper-indented lines inside don't
 * break them) that touch lines first-1 … last+1 are renumbered from their first number, or from 1
 * when the run starts at, or right after, a line this command changed.
 */
function renumber(state: EditorState, changed: Set<number>, first: number, last: number): ChangeSpec[] {
  const doc = state.doc;
  const out: ChangeSpec[] = [];
  const done = new Set<number>();
  for (let n = Math.max(1, first - 1); n <= Math.min(doc.lines, last + 1); n++) {
    const p = parsePrefix(doc.line(n).text);
    if (p.kind !== 'numbered' || done.has(n)) continue;
    const item = (l: Line) => {
      const q = parsePrefix(l.text);
      return q.kind === 'numbered' && q.indent === p.indent;
    };
    // nested lines (indented deeper) belong to the item above them
    const nested = (l: Line) => !blank(l) && /^[ \t]*/.exec(l.text)![0].length > p.indent.length;
    let start = n;
    for (let k = n - 1; k >= 1; k--) {
      const l = doc.line(k);
      if (item(l)) start = k;
      else if (!nested(l)) break;
    }
    let num = changed.has(start) || changed.has(start - 1) ? 1 : (parsePrefix(doc.line(start).text).num ?? 1);
    for (let k = start; k <= doc.lines; k++) {
      const l = doc.line(k);
      if (item(l)) {
        done.add(k);
        const m = /^([ \t]*)(\d+)/.exec(l.text)!;
        if (m[2] !== String(num)) out.push({ from: l.from + m[1]!.length, to: l.from + m[0].length, insert: String(num) });
        num++;
      } else if (!nested(l)) break;
    }
  }
  return out;
}

/** The line style command: Normal clears; any other style toggles (all lines have it → removed). */
export function setLineStyle(state: EditorState, style: LineStyle | 'normal'): TransactionSpec | null {
  const lines = targetLines(state);
  if (!lines.length) return null;
  const matches = (k: Kind) => k === style;
  const remove = style === 'normal' || lines.every((l) => matches(parsePrefix(l.text).kind));
  const changes: ChangeSpec[] = [];
  const changed = new Set<number>();
  for (const l of lines) {
    const p = parsePrefix(l.text);
    let next: string;
    if (remove) next = p.kind ? '' : l.text.slice(0, p.end);
    else {
      // lists keep their nesting; headings and quotes start at the margin
      const indent = isList(style as Kind) && isList(p.kind) ? p.indent : '';
      next = indent + (style === 'numbered' ? '1. ' : MARKER[style as Exclude<LineStyle, 'numbered'>]);
    }
    const old = l.text.slice(0, p.end);
    if (next === old) continue;
    changes.push({ from: l.from, to: l.from + p.end, insert: next });
    changed.add(l.number);
  }
  const first = changes.length ? state.changes(changes) : ChangeSet.empty(state.doc.length);
  const after = state.update({ changes: first }).state;
  const nums = renumber(after, changed, lines[0]!.number, lines[lines.length - 1]!.number);
  const all = nums.length ? first.compose(after.changes(nums)) : first;
  if (all.empty) return null;
  // a caret at a line start moves past the new marker; a range keeps whole lines selected
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => {
      if (r.empty) return EditorSelection.cursor(all.mapPos(r.head, 1));
      const from = all.mapPos(r.from, -1);
      const to = all.mapPos(r.to, 1);
      return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
    }),
    state.selection.mainIndex,
  );
  return transaction({ changes: all, selection });
}

// ---------- inline spans ----------

const MARKS: Record<InlineStyle, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['<u>', '</u>'],
  strike: ['~~', '~~'],
};
const NODE: Record<Exclude<InlineStyle, 'underline'>, [string, string]> = {
  bold: ['StrongEmphasis', 'EmphasisMark'],
  italic: ['Emphasis', 'EmphasisMark'],
  strike: ['Strikethrough', 'StrikethroughMark'],
};

/** A styled span: outer bounds (markers included) and its two marker ranges. */
export interface Span {
  from: number;
  to: number;
  open: [number, number];
  close: [number, number];
}

/** commands parse up to what they touch (≤ 200 ms); the toolbar's live state never forces a parse */
const tree = (state: EditorState, upto: number, force: boolean) => (force && ensureSyntaxTree(state, upto, 200)) || syntaxTree(state);

/** `<u>` / `</u>` tags (HTMLTag nodes, so never inside code) paired per line */
function underlineSpans(state: EditorState, from: number, to: number, force: boolean): Span[] {
  const lineFrom = state.doc.lineAt(from).from;
  const lineTo = state.doc.lineAt(to).to;
  const tags: { from: number; to: number; open: boolean; line: number }[] = [];
  tree(state, lineTo, force).iterate({
    from: lineFrom,
    to: lineTo,
    enter: (n) => {
      if (n.name !== 'HTMLTag') return;
      const t = state.doc.sliceString(n.from, n.to).toLowerCase();
      if (t === '<u>' || t === '</u>') tags.push({ from: n.from, to: n.to, open: t === '<u>', line: state.doc.lineAt(n.from).number });
    },
  });
  return pairUnderlines(tags).filter((s) => s.from <= to && s.to >= from);
}

export function pairUnderlines(tags: { from: number; to: number; open: boolean; line: number }[]): Span[] {
  const spans: Span[] = [];
  const stack: typeof tags = [];
  for (const t of tags) {
    if (stack.length && stack[stack.length - 1]!.line !== t.line) stack.length = 0;
    if (t.open) stack.push(t);
    else {
      const o = stack.pop();
      if (o) spans.push({ from: o.from, to: t.to, open: [o.from, o.to], close: [t.from, t.to] });
    }
  }
  return spans.sort((a, b) => a.from - b.from);
}

/** spans of `style` overlapping (or touching) from…to */
export function spansIn(state: EditorState, style: InlineStyle, from: number, to: number, force = true): Span[] {
  if (style === 'underline') return underlineSpans(state, from, to, force);
  const [name, markName] = NODE[style];
  const out: Span[] = [];
  const line = state.doc.lineAt(to);
  tree(state, line.to, force).iterate({
    from: Math.max(0, from - 1),
    to: Math.min(state.doc.length, to + 1),
    enter: (n) => {
      if (n.name !== name || n.from > to || n.to < from) return;
      const first = n.node.firstChild;
      const last = n.node.lastChild;
      if (!first || !last || first === last || first.name !== markName || last.name !== markName) return;
      out.push({ from: n.from, to: n.to, open: [first.from, first.to], close: [last.from, last.to] });
    },
  });
  return out;
}

/** `**|**`-style empty pairs around an empty caret: the marker lengths to remove each side, or 0 */
function emptyPair(state: EditorState, style: InlineStyle, pos: number): number {
  const doc = state.doc;
  if (style === 'bold' || style === 'italic') {
    let l = 0;
    while (pos - l > 0 && doc.sliceString(pos - l - 1, pos - l) === '*') l++;
    let r = 0;
    while (pos + r < doc.length && doc.sliceString(pos + r, pos + r + 1) === '*') r++;
    if (l !== r || l === 0 || l > 3) return 0;
    if (style === 'bold') return l >= 2 ? 2 : 0;
    return l === 1 || l === 3 ? 1 : 0;
  }
  const [o, c] = MARKS[style];
  return doc.sliceString(pos - o.length, pos) === o && doc.sliceString(pos, pos + c.length) === c ? 1 : 0;
}

/** the text segments of a range, line by line: past each line's marker, trimmed of spaces */
function segments(state: EditorState, from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  for (let n = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number; n <= last; n++) {
    const l = state.doc.line(n);
    let a = Math.max(from, l.from + parsePrefix(l.text).end);
    let b = Math.min(to, l.to);
    while (a < b && /\s/.test(state.doc.sliceString(a, a + 1))) a++;
    while (b > a && /\s/.test(state.doc.sliceString(b - 1, b))) b--;
    if (b > a) out.push([a, b]);
  }
  return out;
}

const covering = (spans: Span[], a: number, b: number) => spans.filter((s) => s.from <= a && s.to >= b);
/** a caret inside a span's text (between its markers, either end included) */
const around = (spans: Span[], pos: number) => spans.filter((s) => s.open[1] <= pos && pos <= s.close[0]);
const innermost = (spans: Span[]) => spans.reduce<Span | undefined>((a, s) => (!a || s.to - s.from < a.to - a.from ? s : a), undefined);

/** Toggle an inline style over every selection range. */
export function toggleInline(state: EditorState, style: InlineStyle): TransactionSpec | null {
  const [open, close] = MARKS[style];
  const changes: ChangeSpec[] = [];
  const del = new Set<string>();
  const remove = (s: Span) => {
    for (const [a, b] of [s.open, s.close]) {
      const k = `${a}:${b}`;
      if (del.has(k)) continue;
      del.add(k);
      changes.push({ from: a, to: b });
    }
  };
  /** carets get explicit places; ranges are mapped (inner text stays selected) */
  const carets = new Map<number, number>();
  const ranges = state.selection.ranges;
  ranges.forEach((r, i) => {
    if (r.empty) {
      const pos = r.head;
      const pair = emptyPair(state, style, pos);
      if (pair) {
        const n = style === 'bold' ? 2 : style === 'italic' ? 1 : open.length;
        const m = style === 'bold' ? 2 : style === 'italic' ? 1 : close.length;
        changes.push({ from: pos - n, to: pos }, { from: pos, to: pos + m });
        return;
      }
      const span = innermost(around(spansIn(state, style, pos, pos), pos));
      if (span) return remove(span);
      changes.push({ from: pos, insert: open + close });
      carets.set(i, pos);
      return;
    }
    const segs = segments(state, r.from, r.to);
    if (!segs.length) return;
    const spans = spansIn(state, style, r.from, r.to);
    const styled = segs.map(([a, b]) => covering(spans, a, b));
    if (styled.every((c) => c.length)) {
      for (const c of styled) remove(innermost(c)!);
      return;
    }
    segs.forEach(([a, b], k) => {
      if (styled[k]!.length) return;
      // merge with spans it overlaps: one span over the union, their inner markers dropped
      const overlap = spans.filter((s) => s.from < b && s.to > a);
      const from = Math.min(a, ...overlap.map((s) => s.from));
      const to = Math.max(b, ...overlap.map((s) => s.to));
      for (const s of overlap) {
        if (s.from !== from) changes.push({ from: s.open[0], to: s.open[1] });
        if (s.to !== to) changes.push({ from: s.close[0], to: s.close[1] });
      }
      if (!overlap.some((s) => s.from === from)) changes.push({ from, insert: open });
      if (!overlap.some((s) => s.to === to)) changes.push({ from: to, insert: close });
    });
  });
  if (!changes.length) return null;
  const set = state.changes(changes);
  const selection = EditorSelection.create(
    ranges.map((r, i) => {
      const caret = carets.get(i);
      if (caret !== undefined) return EditorSelection.cursor(set.mapPos(caret, -1) + open.length);
      if (r.empty) return EditorSelection.cursor(set.mapPos(r.head, -1));
      const from = set.mapPos(r.from, 1);
      const to = Math.max(from, set.mapPos(r.to, -1));
      return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
    }),
    state.selection.mainIndex,
  );
  return transaction({ changes: set, selection });
}

// ---------- checklist boxes ----------

const BOX = /^([ \t]*[-*+][ \t]+)\[([ xX])\]/;

/** Toggle the box of the checklist item starting at line `from` (a click on the drawn box). */
export function toggleCheckAt(state: EditorState, lineFrom: number): TransactionSpec | null {
  const l = state.doc.lineAt(lineFrom);
  const m = BOX.exec(l.text);
  if (!m) return null;
  const at = l.from + m[1]!.length + 1;
  // its own user event: typewriter scrolling leaves the page where it is for a box clicked away from the caret
  return {
    ...transaction({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' } }),
    userEvent: 'input.check',
    scrollIntoView: false,
  };
}

/** ⌘↵ on checklist lines: check them all, or uncheck them all when every one is checked. */
export function toggleChecks(state: EditorState): TransactionSpec | null {
  const lines = targetLines(state).filter((l) => BOX.test(l.text));
  if (!lines.length) return null;
  const check = lines.some((l) => BOX.exec(l.text)![2] === ' ');
  const changes = lines.map((l) => {
    const at = l.from + BOX.exec(l.text)![1]!.length + 1;
    return { from: at, to: at + 1, insert: check ? 'x' : ' ' };
  });
  return transaction({ changes });
}

// ---------- active state ----------

/** what the toolbar shows pressed: lines judged over at most 500 selected lines */
export function activeFormats(state: EditorState): ActiveFormats {
  const head = state.doc.lineAt(state.selection.main.head);
  const headKind = parsePrefix(head.text).kind;
  const lines = targetLines(state, 500);
  const all = (k: Kind) => lines.length > 0 && lines.every((l) => parsePrefix(l.text).kind === k);
  const main = state.selection.main;
  const inline = (style: InlineStyle): boolean => {
    if (main.empty) {
      if (emptyPair(state, style, main.head)) return true;
      return around(spansIn(state, style, main.head, main.head, false), main.head).length > 0;
    }
    if (state.doc.lineAt(main.to).number - state.doc.lineAt(main.from).number > 500) return false;
    const segs = segments(state, main.from, main.to);
    if (!segs.length) return false;
    const spans = spansIn(state, style, main.from, main.to, false);
    return segs.every(([a, b]) => covering(spans, a, b).length > 0);
  };
  return {
    paragraph: headKind === 'title' || headKind === 'heading' || headKind === 'subheading' ? headKind : 'normal',
    bullet: all('bullet'),
    numbered: all('numbered'),
    check: all('check'),
    quote: all('quote'),
    bold: inline('bold'),
    italic: inline('italic'),
    underline: inline('underline'),
    strike: inline('strike'),
  };
}

export const sameFormats = (a: ActiveFormats, b: ActiveFormats) => (Object.keys(a) as (keyof ActiveFormats)[]).every((k) => a[k] === b[k]);

// ---------- commands ----------

/** Run a formatting spec on a view. Read-only views take the key (nothing happens) so it never falls through. */
export function runFormat(view: EditorView, f: (s: EditorState) => TransactionSpec | null): boolean {
  if (view.state.readOnly) return true;
  const spec = f(view.state);
  if (spec) view.dispatch(spec);
  return true;
}

export const lineCommand =
  (style: LineStyle | 'normal'): Command =>
  (view) =>
    runFormat(view, (s) => setLineStyle(s, style));
export const inlineCommand =
  (style: InlineStyle): Command =>
  (view) =>
    runFormat(view, (s) => toggleInline(s, style));
/** ⌘↵ toggles checklist boxes; on other lines it falls through to the default (insert a blank line) */
export const toggleChecksCommand: Command = (view) => {
  if (view.state.readOnly) return false;
  const spec = toggleChecks(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
};
