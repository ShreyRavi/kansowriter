import { Compartment, RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

/**
 * Focus mode: every paragraph except the caret's is set to the muted color; the sentence
 * variant also dims other sentences inside the caret paragraph. Viewport-only.
 */
export type FocusMode = 'off' | 'paragraph' | 'sentence';

const dimLine = Decoration.line({ class: 'cm-dim' });
const dimMark = Decoration.mark({ class: 'cm-dim' });

function paragraphAt(state: EditorState, pos: number): { from: number; to: number } {
  const doc = state.doc;
  let first = doc.lineAt(pos);
  let last = first;
  if (!first.text.trim()) return { from: first.from, to: first.to };
  while (first.number > 1) {
    const prev = doc.line(first.number - 1);
    if (!prev.text.trim()) break;
    first = prev;
  }
  while (last.number < doc.lines) {
    const next = doc.line(last.number + 1);
    if (!next.text.trim()) break;
    last = next;
  }
  return { from: first.from, to: last.to };
}

function sentenceAt(text: string, offset: number): { from: number; to: number } {
  const re = /[^.!?…]+[.!?…]*["'”’)]*\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (offset >= m.index && offset <= m.index + m[0].length) return { from: m.index, to: m.index + m[0].length };
    if (m[0].length === 0) re.lastIndex++;
  }
  return { from: 0, to: text.length };
}

function build(view: EditorView, mode: FocusMode): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  if (mode === 'off') return builder.finish();
  const { state } = view;
  const head = state.selection.main.head;
  const para = paragraphAt(state, head);
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = state.doc.lineAt(pos);
      if (line.to < para.from || line.from > para.to) builder.add(line.from, line.from, dimLine);
      else if (mode === 'sentence' && line.from <= head && head <= line.to) {
        const s = sentenceAt(line.text, head - line.from);
        if (s.from > 0) builder.add(line.from, line.from + s.from, dimMark);
        if (line.from + s.to < line.to) builder.add(line.from + s.to, line.to, dimMark);
      } else if (mode === 'sentence') builder.add(line.from, line.from, dimLine);
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const focusCompartment = new Compartment();

function plugin(mode: FocusMode) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view, mode);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged) this.decorations = build(u.view, mode);
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export function focusMode(mode: FocusMode): Extension {
  return focusCompartment.of(plugin(mode));
}

export function setFocusMode(view: EditorView, mode: FocusMode): void {
  view.dispatch({ effects: focusCompartment.reconfigure(plugin(mode)) });
}

export { paragraphAt, sentenceAt };
