import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import {
  ChangeSet,
  EditorSelection,
  EditorState,
  type ChangeSpec,
  type Line,
  type Text,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import { notRecorded } from './recorder';

/**
 * Formatting commands (plain Markdown in, plain Markdown out). Every command is a pure function
 * EditorState → TransactionSpec | null, dispatched as one normal transaction: it is recorded as a
 * KOP op like any edit (so letters replay it) and is one undo step (isolated history).
 *
 *   paragraph     title "# "  heading "## "  subheading "### "  (Normal: none)
 *   lists         bullet "- "  numbered "1. "  checklist "- [ ] "   (one per line; another swaps it)
 *   quote         "> ": a container, so a quoted line keeps its list or heading marker ("> - item")
 *   inline        bold ** · italic * · underline <u>…</u> · strikethrough ~~
 *
 * Toggling: applying a style the selection already has removes it (the style menu instead sets:
 * picking the current style changes nothing). With an empty caret, inline styles behave as in
 * Notes: the first press opens a pair to type into, the second steps out of it again, so
 * "⌘B loud ⌘B now" writes "**loud** now". Nothing is ever formatted inside code.
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

/** the marker inside any quote container: a heading or a list item */
type Kind = Exclude<LineStyle, 'quote'> | null;

export interface Prefix {
  /** the quote container ("> ", "> > "), or "" */
  quote: string;
  /** spaces before the list marker (after the quote) */
  indent: string;
  kind: Kind;
  /** offset where this line's own marker (heading / list, with its indent) ends */
  markerEnd: number;
  /** offset where the text starts: past the quote and every marker ("> - [ ] " or "- - ") */
  end: number;
  num?: number;
}

const QUOTE = /^(?:[ \t]{0,3}>[ \t]?)+/;
const MARK = /^([ \t]*)(?:(#{1,6})(?:[ \t]+|$)|[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)|[-*+](?:[ \t]+|$)|(\d{1,9})[.)](?:[ \t]+|$))/;
const LIST_MARK = /^[ \t]*(?:[-*+][ \t]+\[[ xX]\](?:[ \t]+|$)|[-*+](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$))/;

/** past any further list markers and quote markers from `at` */
function contentStart(text: string, at: number): number {
  for (;;) {
    const n = LIST_MARK.exec(text.slice(at)) ?? QUOTE.exec(text.slice(at));
    if (!n || !n[0].length) return at;
    at += n[0].length;
  }
}

export function parsePrefix(text: string): Prefix {
  const quote = QUOTE.exec(text)?.[0] ?? '';
  const rest = text.slice(quote.length);
  const m = MARK.exec(rest);
  if (!m) return { quote, indent: '', kind: null, markerEnd: quote.length, end: quote.length };
  const body = m[0].slice(m[1]!.length);
  let kind: Kind;
  if (m[2]) kind = m[2].length === 1 ? 'title' : m[2].length === 2 ? 'heading' : 'subheading';
  else if (m[3]) kind = 'numbered';
  else if (/^[-*+][ \t]+\[/.test(body)) kind = 'check';
  else kind = 'bullet';
  const markerEnd = quote.length + m[0].length;
  // nested containers on one line ("- - item", "- > quote") all come before the text
  const end = m[2] ? markerEnd : contentStart(text, markerEnd);
  return { quote, indent: m[1]!, kind, markerEnd, end, num: m[3] ? Number(m[3]) : undefined };
}

const MARKER: Record<Exclude<Kind, null | 'numbered'>, string> = {
  title: '# ',
  heading: '## ',
  subheading: '### ',
  bullet: '- ',
  check: '- [ ] ',
};
const isList = (k: Kind) => k === 'bullet' || k === 'numbered' || k === 'check';
const isHeading = (k: Kind) => k === 'title' || k === 'heading' || k === 'subheading';
const blank = (l: Line) => !l.text.trim();

/** commands parse up to what they touch (≤ 200 ms); the toolbar's live state never forces a parse */
const tree = (state: EditorState, upto: number, force: boolean) => (force && ensureSyntaxTree(state, upto, 200)) || syntaxTree(state);

const CODE_BLOCK = new Set(['FencedCode', 'CodeBlock']);
const CODE = new Set(['FencedCode', 'CodeBlock', 'InlineCode']);
function within(state: EditorState, pos: number, side: -1 | 1, names: Set<string>, force = true): boolean {
  for (let n: { name: string; parent: unknown } | null = tree(state, pos, force).resolveInner(pos, side); n; n = n.parent as typeof n)
    if (names.has(n.name)) return true;
  return false;
}
/** a line inside a fenced or indented code block (formatting never touches it) */
const codeLine = (state: EditorState, l: Line, force = true) =>
  within(state, l.from + /^[ \t]*/.exec(l.text)![0].length, 1, CODE_BLOCK, force);

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

/** the lines a line style applies to: the non-blank ones (or the blank caret line), never code */
function targetLines(state: EditorState, limit?: number, force = true): Line[] {
  const lines = selectedLines(state, limit).filter((l) => !codeLine(state, l, force));
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
 * Numbered runs (numbered lines with one container and indent; deeper-indented lines and blank
 * lines between items don't break them) touching lines first-1 … last+1 are renumbered from their first number,
 * or from 1 when `restart` holds the run's first line or the line before it (lines a format
 * command changed). Ordinary edits pass no `restart`: a list keeps the number it starts with.
 */
export function renumber(doc: Text, first: number, last: number, restart?: Set<number>): ChangeSpec[] {
  const out: ChangeSpec[] = [];
  const done = new Set<number>();
  for (let n = Math.max(1, first - 1); n <= Math.min(doc.lines, last + 1); n++) {
    const p = parsePrefix(doc.line(n).text);
    if (p.kind !== 'numbered' || done.has(n)) continue;
    const item = (l: Line) => {
      const q = parsePrefix(l.text);
      return q.kind === 'numbered' && q.quote === p.quote && q.indent === p.indent;
    };
    // nested lines (indented deeper) belong to the item above them
    const nested = (l: Line) => {
      if (blank(l)) return false;
      const q = parsePrefix(l.text);
      return q.quote === p.quote && /^[ \t]*/.exec(l.text.slice(q.quote.length))![0].length > p.indent.length;
    };
    // blank lines between items keep one (loose) list, as CommonMark reads it
    const gapTo = (k: number, dir: 1 | -1) => {
      let j = k;
      while (j >= 1 && j <= doc.lines && blank(doc.line(j))) j += dir;
      return j >= 1 && j <= doc.lines && j !== k && item(doc.line(j)) ? j : 0;
    };
    let start = n;
    for (let k = n - 1; k >= 1; k--) {
      const l = doc.line(k);
      if (item(l)) start = k;
      else if (blank(l) && gapTo(k, -1)) k = gapTo(k, -1) + 1;
      else if (!nested(l)) break;
    }
    let num = restart && (restart.has(start) || restart.has(start - 1)) ? 1 : (parsePrefix(doc.line(start).text).num ?? 1);
    for (let k = start; k <= doc.lines; k++) {
      const l = doc.line(k);
      if (item(l)) {
        done.add(k);
        const q = parsePrefix(l.text);
        const m = /^([ \t]*)(\d+)/.exec(l.text.slice(q.quote.length))!;
        const from = l.from + q.quote.length + m[1]!.length;
        if (m[2] !== String(num)) out.push({ from, to: from + m[2]!.length, insert: String(num) });
        num++;
      } else if (blank(l) && gapTo(k, 1)) k = gapTo(k, 1) - 1;
      else if (!nested(l)) break;
    }
  }
  return out;
}

/** an ATX heading's closing "#"s ("# Title #"), past the marker: [from, to) in the line, or null */
function closingHashes(text: string, markerEnd: number): [number, number] | null {
  const m = /[ \t]+#+[ \t]*$/.exec(text);
  return m && m.index >= markerEnd ? [m.index, text.length] : null;
}

/**
 * The line style command. `toggle` (shortcuts, toolbar buttons): when every line already has the
 * style it is removed. Without it (the style menu) the style is set, so picking the current one
 * changes nothing. Normal clears headings and list markers (a quote stays). Quote toggles the
 * container and keeps what is inside it.
 */
export function setLineStyle(state: EditorState, style: LineStyle | 'normal', toggle = true): TransactionSpec | null {
  const lines = targetLines(state);
  if (!lines.length) return null;
  const changes: ChangeSpec[] = [];
  const changed = new Set<number>();
  if (style === 'quote') {
    const remove = lines.every((l) => parsePrefix(l.text).quote);
    if (remove && !toggle) return null;
    for (const l of lines) {
      const q = parsePrefix(l.text).quote;
      if (remove) changes.push({ from: l.from, to: l.from + q.length });
      else if (!q) changes.push({ from: l.from, insert: '> ' });
      else continue;
      changed.add(l.number);
    }
  } else {
    const all = style !== 'normal' && lines.every((l) => parsePrefix(l.text).kind === style);
    if (all && !toggle) return null;
    const remove = style === 'normal' || all;
    for (const l of lines) {
      const p = parsePrefix(l.text);
      const at = p.quote.length;
      let next: string;
      if (remove) next = '';
      else {
        // lists keep their nesting; headings start at the container's margin
        const indent = isList(style) && isList(p.kind) ? p.indent : '';
        next = indent + (style === 'numbered' ? '1. ' : MARKER[style]);
      }
      const old = l.text.slice(at, p.kind ? p.markerEnd : at);
      if (next === old) continue;
      changes.push({ from: l.from + at, to: l.from + (p.kind ? p.markerEnd : at), insert: next });
      // a heading becoming anything else loses its closing "#"s too
      const close = isHeading(p.kind) && !(next && isHeading(style as Kind)) ? closingHashes(l.text, p.markerEnd) : null;
      if (close) changes.push({ from: l.from + close[0], to: l.from + close[1] });
      changed.add(l.number);
    }
  }
  const first = changes.length ? state.changes(changes) : ChangeSet.empty(state.doc.length);
  const after = first.apply(state.doc);
  const nums = renumber(after, lines[0]!.number, lines[lines.length - 1]!.number, changed);
  const all = nums.length ? first.compose(ChangeSet.of(nums, after.length, state.lineBreak)) : first;
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

/**
 * Keeps numbered lists counting after ordinary edits that add or remove lines (Enter, Backspace
 * joining lines, deleting an item): the touched run is renumbered in the same transaction, so it
 * is recorded and undone with the edit. Only the affected run is read.
 */
export const renumberOnEdit = EditorState.transactionFilter.of((tr: Transaction) => {
  if (!tr.docChanged || tr.annotation(notRecorded) || tr.isUserEvent('input.format') || tr.isUserEvent('input.type.compose')) return tr;
  if (tr.startState.readOnly || tr.startState.doc.lines === tr.newDoc.lines) return tr;
  let first = Infinity;
  let last = 0;
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    first = Math.min(first, tr.newDoc.lineAt(fromB).number);
    last = Math.max(last, tr.newDoc.lineAt(toB).number);
  });
  if (!last) return tr;
  const nums = renumber(tr.newDoc, first, last);
  return nums.length ? [tr, { changes: nums, sequential: true }] : tr;
});

// ---------- Enter / Backspace on list items (Notes) ----------

/** the single empty caret on a list item or quote line, outside code, with its prefix */
function caretItem(state: EditorState): { l: Line; p: Prefix; pos: number } | null {
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty || state.readOnly) return null;
  const pos = sel.main.head;
  const l = state.doc.lineAt(pos);
  const p = parsePrefix(l.text);
  if ((!isList(p.kind) && !p.quote) || codeLine(state, l)) return null;
  return { l, p, pos };
}

/** drop a line's innermost list marker (or its quote, when it holds no list), renumbering what follows */
function dropMarker(state: EditorState, l: Line, p: Prefix, userEvent: string): TransactionSpec {
  const [from, to] = isList(p.kind) ? [p.quote.length, p.markerEnd] : [0, p.quote.length];
  const first = state.changes({ from: l.from + from, to: l.from + to });
  const after = first.apply(state.doc);
  const nums = renumber(after, l.number, l.number, new Set([l.number]));
  const all = nums.length ? first.compose(ChangeSet.of(nums, after.length, state.lineBreak)) : first;
  return { changes: all, selection: { anchor: all.mapPos(state.selection.main.head, -1) }, userEvent, scrollIntoView: true };
}

/** Enter on an empty item ends the list (the marker goes, no new item); other Enters continue it */
export function endEmptyItem(state: EditorState): TransactionSpec | null {
  const c = caretItem(state);
  if (!c || c.l.text.slice(c.p.end).trim() || c.pos !== c.l.to) return null;
  return dropMarker(state, c.l, c.p, 'delete');
}

/** Backspace right after an item's marker removes the marker (the item's text stays, as plain text) */
export function deleteMarkerBackward(state: EditorState): TransactionSpec | null {
  const c = caretItem(state);
  if (!c || c.pos !== c.l.from + c.p.end) return null;
  return dropMarker(state, c.l, c.p, 'delete.backward');
}

// ---------- inline spans ----------

const MARKS: Record<InlineStyle, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  underline: ['<u>', '</u>'],
  strike: ['~~', '~~'],
};
/** next to a "*" run a new "**" or "*" would glue onto it: the underscore forms are used instead */
const ALT: Partial<Record<InlineStyle, [string, string]>> = { bold: ['__', '__'], italic: ['_', '_'] };
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

const charAt = (state: EditorState, pos: number) => (pos >= 0 && pos < state.doc.length ? state.doc.sliceString(pos, pos + 1) : '');

/** `**|**`-style empty pairs around an empty caret: the marker lengths to remove each side, or 0 */
function emptyPair(state: EditorState, style: InlineStyle, pos: number): number {
  if (style === 'bold' || style === 'italic') {
    for (const ch of ['*', '_']) {
      let l = 0;
      while (charAt(state, pos - l - 1) === ch) l++;
      let r = 0;
      while (charAt(state, pos + r) === ch) r++;
      if (l !== r || l === 0 || l > 3) continue;
      if (style === 'bold') return l >= 2 ? 2 : 0;
      return l === 1 || l === 3 ? 1 : 0;
    }
    return 0;
  }
  const [o, c] = MARKS[style];
  return state.doc.sliceString(pos - o.length, pos) === o && state.doc.sliceString(pos, pos + c.length) === c ? o.length : 0;
}

/** the text segments of a range, line by line: past each line's markers, trimmed of spaces, never code */
function segments(state: EditorState, from: number, to: number, force = true): [number, number][] {
  const out: [number, number][] = [];
  for (let n = state.doc.lineAt(from).number, last = state.doc.lineAt(to).number; n <= last; n++) {
    const l = state.doc.line(n);
    if (codeLine(state, l, force)) continue;
    let a = Math.max(from, l.from + parsePrefix(l.text).end);
    let b = Math.min(to, l.to);
    while (a < b && /\s/.test(charAt(state, a))) a++;
    while (b > a && /\s/.test(charAt(state, b - 1))) b--;
    if (b > a && !within(state, a, 1, CODE, force) && !within(state, b, -1, CODE, force)) out.push([a, b]);
  }
  return out;
}

const covering = (spans: Span[], a: number, b: number) => spans.filter((s) => s.from <= a && s.to >= b);
/** a caret inside a span's text (between its markers, either end included) */
const around = (spans: Span[], pos: number) => spans.filter((s) => s.open[1] <= pos && pos <= s.close[0]);
const innermost = (spans: Span[]) => spans.reduce<Span | undefined>((a, s) => (!a || s.to - s.from < a.to - a.from ? s : a), undefined);

/** a caret in code: both sides inside (just past a closing backtick still formats) */
const caretInCode = (state: EditorState, pos: number) =>
  within(state, pos, -1, CODE_BLOCK) || (within(state, pos, -1, CODE) && within(state, pos, 1, CODE));

/**
 * Toggle an inline style over every selection range.
 *  - empty caret: an empty pair is removed; at a span's inner edge the caret steps out past the
 *    marker; just outside a span it steps in; inside a span's text the span is removed; else a
 *    pair is inserted with the caret between (underscore forms next to a "*" run)
 *  - selection: unstyled text is wrapped (one span per line, merged with spans it overlaps, their
 *    inner markers dropped, so "a **b** c" bold-all → "**a b c**" → unbold-all → "a b c"); text
 *    already styled is unstyled, splitting the span around it ("**very bold words**" → "**very
 *    bold** words")
 */
export function toggleInline(state: EditorState, style: InlineStyle): TransactionSpec | null {
  const changes: ChangeSpec[] = [];
  const del = new Set<string>();
  const drop = (a: number, b: number) => {
    const k = `${a}:${b}`;
    if (del.has(k)) return;
    del.add(k);
    changes.push({ from: a, to: b });
  };
  const remove = (s: Span) => {
    drop(...s.open);
    drop(...s.close);
  };
  const markersFor = (a: number, b: number): [string, string] =>
    ALT[style] && (charAt(state, a - 1) === '*' || charAt(state, b) === '*') ? ALT[style]! : MARKS[style];
  /** where each empty caret goes: a position in the old doc and which side of an insert there */
  const carets = new Map<number, { pos: number; assoc: -1 | 1; plus?: number }>();
  const ranges = state.selection.ranges;
  ranges.forEach((r, i) => {
    if (r.empty) {
      const pos = r.head;
      if (caretInCode(state, pos)) return;
      const pair = emptyPair(state, style, pos);
      if (pair) {
        const right = style === 'underline' ? 4 : style === 'strike' ? 2 : pair;
        changes.push({ from: pos - pair, to: pos }, { from: pos, to: pos + right });
        return;
      }
      const spans = spansIn(state, style, pos, pos);
      const full = spans.filter((s) => s.close[0] > s.open[1]);
      const exit = full.find((s) => pos === s.close[0]) ?? full.find((s) => pos === s.open[1]);
      if (exit) return void carets.set(i, pos === exit.close[0] ? { pos: exit.close[1], assoc: 1 } : { pos: exit.open[0], assoc: -1 });
      const enter = full.find((s) => pos === s.to) ?? full.find((s) => pos === s.from);
      if (enter) return void carets.set(i, pos === enter.to ? { pos: enter.close[0], assoc: -1 } : { pos: enter.open[1], assoc: 1 });
      const inside = innermost(around(spans, pos));
      if (inside) return remove(inside);
      const [open, close] = markersFor(pos, pos);
      changes.push({ from: pos, insert: open + close });
      carets.set(i, { pos, assoc: -1, plus: open.length });
      return;
    }
    const segs = segments(state, r.from, r.to);
    if (!segs.length) return;
    const spans = spansIn(state, style, r.from, r.to);
    const styled = segs.map(([a, b]) => covering(spans, a, b));
    if (styled.every((c) => c.length)) {
      segs.forEach(([a, b], k) => unstyle(innermost(styled[k]!)!, a, b));
      return;
    }
    segs.forEach(([a, b], k) => {
      if (styled[k]!.length) return;
      // merge with spans it overlaps: one span over the union, their inner markers dropped
      const overlap = spans.filter((s) => s.from < b && s.to > a);
      const from = Math.min(a, ...overlap.map((s) => s.from));
      const to = Math.max(b, ...overlap.map((s) => s.to));
      const kept = overlap.find((s) => s.from === from || s.to === to);
      const [open, close] = kept ? [state.doc.sliceString(...kept.open), state.doc.sliceString(...kept.close)] : markersFor(from, to);
      for (const s of overlap) {
        if (s.from !== from) drop(...s.open);
        if (s.to !== to) drop(...s.close);
      }
      if (!overlap.some((s) => s.from === from)) changes.push({ from, insert: open });
      if (!overlap.some((s) => s.to === to)) changes.push({ from: to, insert: close });
    });
  });

  /** take `style` off a…b inside span s: the whole span, or split it around the text */
  function unstyle(s: Span, a: number, b: number) {
    const [in0, in1] = [s.open[1], s.close[0]];
    let left = Math.max(a, in0);
    while (left > in0 && /\s/.test(charAt(state, left - 1))) left--;
    let right = Math.min(b, in1);
    while (right < in1 && /\s/.test(charAt(state, right))) right++;
    const openText = state.doc.sliceString(...s.open);
    const closeText = state.doc.sliceString(...s.close);
    // only other spans' markers between the text and this span's own ("***x***"): the whole side is covered
    const markup = (from: number, to: number) => !state.doc.sliceString(from, to).replace(/<\/?u>|[*_~\s]/gi, '');
    if (markup(in0, left)) left = in0;
    if (markup(right, in1)) right = in1;
    if (left <= in0) drop(...s.open);
    else changes.push({ from: left, insert: closeText });
    if (right >= in1) drop(...s.close);
    else changes.push({ from: right, insert: openText });
  }

  if (!changes.length && !carets.size) return null;
  const set = state.changes(changes);
  const selection = EditorSelection.create(
    ranges.map((r, i) => {
      const caret = carets.get(i);
      if (caret) return EditorSelection.cursor(set.mapPos(caret.pos, caret.assoc) + (caret.plus ?? 0));
      if (r.empty) return EditorSelection.cursor(set.mapPos(r.head, -1));
      const from = set.mapPos(r.from, 1);
      const to = Math.max(from, set.mapPos(r.to, -1));
      return r.anchor <= r.head ? EditorSelection.range(from, to) : EditorSelection.range(to, from);
    }),
    state.selection.mainIndex,
  );
  if (set.empty) return { selection, userEvent: 'select', scrollIntoView: true };
  return transaction({ changes: set, selection });
}

// ---------- checklist boxes ----------

const BOX = /^((?:[ \t]{0,3}>[ \t]?)*[ \t]*[-*+][ \t]+)\[([ xX])\]/;

/** Toggle the box of the checklist item on the line at `lineFrom` (a click on the drawn box). */
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

/** what the toolbar shows pressed: lines judged over at most 500 selected lines; never forces a parse */
export function activeFormats(state: EditorState): ActiveFormats {
  const head = state.doc.lineAt(state.selection.main.head);
  const headKind = parsePrefix(head.text).kind;
  const lines = targetLines(state, 500, false);
  const prefixes = lines.map((l) => parsePrefix(l.text));
  const all = (k: Kind) => prefixes.length > 0 && prefixes.every((p) => p.kind === k);
  const main = state.selection.main;
  const inline = (style: InlineStyle): boolean => {
    if (main.empty) {
      if (within(state, main.head, -1, CODE, false) && within(state, main.head, 1, CODE, false)) return false;
      if (emptyPair(state, style, main.head)) return true;
      return around(spansIn(state, style, main.head, main.head, false), main.head).length > 0;
    }
    if (state.doc.lineAt(main.to).number - state.doc.lineAt(main.from).number > 500) return false;
    const segs = segments(state, main.from, main.to, false);
    if (!segs.length) return false;
    const spans = spansIn(state, style, main.from, main.to, false);
    return segs.every(([a, b]) => covering(spans, a, b).length > 0);
  };
  return {
    paragraph: isHeading(headKind) && !codeLine(state, head, false) ? (headKind as Paragraph) : 'normal',
    bullet: all('bullet'),
    numbered: all('numbered'),
    check: all('check'),
    quote: prefixes.length > 0 && prefixes.every((p) => p.quote),
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
/** the style menu: sets a paragraph style (picking the current one changes nothing) */
export const setParagraphCommand =
  (style: Paragraph): Command =>
  (view) =>
    runFormat(view, (s) => setLineStyle(s, style, false));
/** ⌘↵ toggles checklist boxes; on other lines it falls through to the default (insert a blank line) */
export const toggleChecksCommand: Command = (view) => {
  if (view.state.readOnly) return false;
  const spec = toggleChecks(view.state);
  if (!spec) return false;
  view.dispatch(spec);
  return true;
};
