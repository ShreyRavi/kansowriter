import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type EditorState } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/**
 * Hybrid Markdown (R6, text-only): syntax marks are hidden except on lines the selection
 * touches. Only headings, emphasis, quotes, lists, inline code and links are styled.
 * Nothing here ever creates an element that loads a resource: image syntax stays literal
 * text, links are styled text (never anchors), and there is no math or diagram rendering.
 *
 *   "## Title"  caret elsewhere → "Title" (h2 line class)   caret on line → "## Title"
 */
const hide = Decoration.replace({});
const lineClass = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

const MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'QuoteMark']);

function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) lines.add(n);
  }
  return lines;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const active = activeLines(state);
  const items: { from: number; to: number; deco: Decoration; line?: boolean }[] = [];
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
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
        else if (name === 'InlineCode') items.push({ from: node.from, to: node.to, deco: mark('cm-code') });
        else if (name === 'Link') items.push({ from: node.from, to: node.to, deco: mark('cm-link') });
        else if (name === 'Image') return false; // literal text, never rendered (R6)
        else if (name === 'URL' && node.node.parent?.name === 'Link' && !onActive) {
          items.push({ from: node.from, to: node.to, deco: hide });
        } else if (MARKS.has(name) && !onActive) {
          let end = node.to;
          // hide the space after "#" / ">" too
          if ((name === 'HeaderMark' || name === 'QuoteMark') && state.doc.sliceString(end, end + 1) === ' ') end++;
          if (end > node.from) items.push({ from: node.from, to: end, deco: hide });
        } else if (name === 'ListMark') items.push({ from: node.from, to: node.to, deco: mark('cm-listmark') });
        return undefined;
      },
    });
  }
  items.sort((a, b) => a.from - b.from || (a.line === b.line ? 0 : a.line ? -1 : 1) || a.to - b.to);
  const builder = new RangeSetBuilder<Decoration>();
  let lastHideEnd = -1;
  for (const it of items) {
    if (it.deco === hide) {
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
      if (u.docChanged || u.selectionSet || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
        this.decorations = build(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
