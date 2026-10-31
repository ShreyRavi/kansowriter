import { Language, syntaxTree } from '@codemirror/language';
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { Strikethrough, TaskList, type MarkdownParser } from '@lezer/markdown';
import { Facet, RangeSetBuilder, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { pairUnderlines, toggleCheckAt } from './format';

/**
 * The writing language, shared by the editor and the letter reader: plain CommonMark plus GFM
 * strikethrough (~~) and task list items (- [ ]). Built directly on the CommonMark language:
 * markdown() would bundle the HTML/CSS/JS parsers for embedded code (R6: text only).
 */
export const writingLanguage = new Language(
  commonmarkLanguage.data,
  (commonmarkLanguage.parser as MarkdownParser).configure([Strikethrough, TaskList]),
  [],
  'markdown',
);

/**
 * Hybrid Markdown (R6, text-only): syntax marks are hidden except on lines the selection
 * touches. Only headings, emphasis, strikethrough, quotes, lists, checklist boxes, inline code,
 * links and `<u>…</u>` underline are styled. `<u>` is the one piece of HTML with a look of its own,
 * and only as a decoration (no element is ever parsed or created from the text); every other tag
 * stays literal text.
 * Nothing here ever creates an element that loads a resource: image syntax stays literal
 * text, links are styled text (never anchors), and there is no math or diagram rendering.
 *
 *   "## Title"  caret elsewhere → "Title" (h2 line class)   caret on line → "## Title"
 *
 * A blank line between two non-blank lines (a paragraph separator) gets `cm-gap`, which
 * styles.css shortens to the paragraph space. Not on a line holding an empty cursor, so typing
 * on a blank line looks normal (a range selection, e.g. ⌘A or a drag, keeps it: selecting never
 * reflows), and not on the last line of the document.
 */
const hide = Decoration.replace({});
const lineClass = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

const gap = lineClass('cm-gap');

const MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'QuoteMark', 'StrikethroughMark']);
const strike = mark('cm-strike');
const underline = mark('cm-u');
const taskDone = lineClass('cm-task-done');

/**
 * A checklist item's box, drawn in place of "[ ]" / "[x]" off the caret line. A click (or Space /
 * Enter once focused, e.g. by a screen reader) flips the character in the text with a normal,
 * recorded transaction. Read-only views (another tab writes, a damaged draft, the letter reader)
 * show it but never change it. It stays out of the Tab order: Tab leaves the editor (17A), and
 * ⌘↵ / Ctrl ↵ toggles the boxes on the caret's lines.
 */
class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly label: string,
    /** part of the identity: a tab turning read-only (or writable) redraws its boxes */
    readonly readOnly: boolean,
  ) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.label === this.label && o.readOnly === this.readOnly;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('span');
    box.className = `cm-task${this.checked ? ' cm-task-checked' : ''}`;
    box.setAttribute('role', 'checkbox');
    box.setAttribute('aria-checked', String(this.checked));
    box.setAttribute('aria-label', this.label);
    box.tabIndex = -1;
    if (this.readOnly) box.setAttribute('aria-readonly', 'true');
    const toggle = () => {
      if (view.state.readOnly) return;
      const spec = toggleCheckAt(view.state, view.posAtDOM(box));
      if (spec) view.dispatch(spec);
    };
    // never move the caret or focus there: the line would show its syntax under the pointer
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => {
      e.preventDefault();
      toggle();
    });
    box.addEventListener('keydown', (e) => {
      if (e.key !== ' ' && e.key !== 'Enter') return;
      e.preventDefault();
      toggle();
    });
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-listmark cm-bullet';
    s.textContent = '•';
    return s;
  }
}
const bullet = Decoration.replace({ widget: new BulletWidget() });

const taskLabel = (text: string) => {
  const t = text.replace(/^(?:[ \t]{0,3}>[ \t]?)*[ \t]*[-*+][ \t]+\[[ xX]\][ \t]*/, '').trim();
  return t ? (t.length > 80 ? `${t.slice(0, 79)}…` : t) : 'Checklist item';
};

/**
 * Whether lines the selection touches show their syntax marks (default on). The letter reader
 * turns it off once the replay ends, so the finished letter shows no marks anywhere.
 */
export const revealSyntax = Facet.define<boolean, boolean>({ combine: (v) => v.every(Boolean) });

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  if (!state.facet(revealSyntax)) return lines;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

/** lines holding an empty cursor: the only blank lines that lose cm-gap */
function cursorLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) if (r.empty) lines.add(state.doc.lineAt(r.head).number);
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const cursors = cursorLines(state);
  const items: { from: number; to: number; deco: Decoration; line?: boolean; replace?: boolean }[] = [];
  const tags: { from: number; to: number; open: boolean; line: number }[] = [];
  const tree = syntaxTree(state);
  const blank = (n: number) => !state.doc.line(n).text.trim();
  for (const { from, to } of view.visibleRanges) {
    for (let n = state.doc.lineAt(from).number, end = state.doc.lineAt(to).number; n <= end; n++) {
      if (n > 1 && n < state.doc.lines && !cursors.has(n) && blank(n) && !blank(n - 1) && !blank(n + 1)) {
        const l = state.doc.line(n);
        items.push({ from: l.from, to: l.from, deco: gap, line: true });
      }
    }
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        const line = state.doc.lineAt(node.from);
        const onActive = active.has(line.number);
        const h = /^ATXHeading(\d)$/.exec(name);
        if (h) items.push({ from: line.from, to: line.from, deco: lineClass(`cm-h${h[1]}`), line: true });
        else if (name === 'Blockquote') {
          // only the lines inside this visible range (a pasted 5,000-line quote stays cheap)
          const last = state.doc.lineAt(Math.min(node.to, to)).number;
          for (let n = state.doc.lineAt(Math.max(node.from, from)).number; n <= last; n++) {
            const l = state.doc.line(n);
            items.push({ from: l.from, to: l.from, deco: lineClass('cm-quote'), line: true });
          }
        } else if (name === 'Emphasis') items.push({ from: node.from, to: node.to, deco: mark('cm-em') });
        else if (name === 'StrongEmphasis') items.push({ from: node.from, to: node.to, deco: mark('cm-strong') });
        else if (name === 'Strikethrough') items.push({ from: node.from, to: node.to, deco: strike });
        else if (name === 'HTMLTag') {
          const t = state.doc.sliceString(node.from, node.to).toLowerCase();
          if (t === '<u>' || t === '</u>') tags.push({ from: node.from, to: node.to, open: t === '<u>', line: line.number });
        } else if (name === 'TaskMarker') {
          const checked = state.doc.sliceString(node.from + 1, node.from + 2) !== ' ';
          if (checked) items.push({ from: line.from, to: line.from, deco: taskDone, line: true });
          if (!onActive) {
            const end = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            const widget = Decoration.replace({ widget: new CheckboxWidget(checked, taskLabel(line.text), state.readOnly) });
            items.push({ from: node.from, to: end, deco: widget, replace: true });
          }
        } else if (name === 'InlineCode') items.push({ from: node.from, to: node.to, deco: mark('cm-code') });
        else if (name === 'Link') items.push({ from: node.from, to: node.to, deco: mark('cm-link') });
        else if (name === 'Image')
          return false; // literal text, never rendered (R6)
        else if (name === 'URL' && node.node.parent?.name === 'Link' && !onActive) {
          items.push({ from: node.from, to: node.to, deco: hide });
        } else if (MARKS.has(name) && !onActive) {
          let end = node.to;
          // hide the space after "#" / ">" too
          if ((name === 'HeaderMark' || name === 'QuoteMark') && state.doc.sliceString(end, end + 1) === ' ') end++;
          if (end > node.from) items.push({ from: node.from, to: end, deco: hide });
        } else if (name === 'ListMark') {
          // a checklist item off the caret line shows just its box: the "- " goes too
          if (!onActive && node.node.parent?.getChild('Task')) {
            const end = state.doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to;
            items.push({ from: node.from, to: end, deco: hide });
          } else if (!onActive && node.node.parent?.parent?.name === 'BulletList') {
            // a bullet off the caret line is drawn as a bullet; the "-" / "*" / "+" comes back on the caret line
            items.push({ from: node.from, to: node.to, deco: bullet, replace: true });
          } else items.push({ from: node.from, to: node.to, deco: mark('cm-listmark') });
        }
        return undefined;
      },
    });
  }
  for (const u of pairUnderlines(tags)) {
    items.push({ from: u.from, to: u.to, deco: underline });
    if (!active.has(state.doc.lineAt(u.from).number)) {
      items.push({ from: u.open[0], to: u.open[1], deco: hide });
      items.push({ from: u.close[0], to: u.close[1], deco: hide });
    }
  }
  items.sort((a, b) => a.from - b.from || (a.line === b.line ? 0 : a.line ? -1 : 1) || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastHideEnd = -1;
  for (const it of items) {
    if (it.deco === hide || it.replace) {
      if (it.from < lastHideEnd) continue; // no overlapping replaces
      lastHideEnd = it.to;
    }
    builder.add(it.from, it.to, it.deco);
  }
  return builder.finish();
}

export const hybridMarkdown = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (
        u.docChanged ||
        u.selectionSet ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.startState.facet(revealSyntax) !== u.state.facet(revealSyntax) ||
        u.startState.readOnly !== u.state.readOnly
      ) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
