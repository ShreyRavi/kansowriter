// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { redoDepth, undo, undoDepth } from '@codemirror/commands';
import { apply } from '../core/kop';
import { kindOf, runsFromTransaction } from './recorder';
import { createEditor, loadText } from './setup';
import { paragraphAt, sentenceAt, type FocusMode } from './focus';
import type { Change } from '../storage/writer';

describe('recorder: ChangeSet → KOP', () => {
  it('runs replay the transaction exactly (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.nat(), fc.nat({ max: 5 }), fc.string({ maxLength: 5 }), (doc, p, del, ins) => {
        const state = EditorState.create({ doc });
        const from = doc.length ? p % (doc.length + 1) : 0;
        const to = Math.min(doc.length, from + del);
        const tr = state.update({ changes: { from, to, insert: ins } });
        expect(apply(doc, [0, 0, ...runsFromTransaction(tr)])).toBe(tr.newDoc.toString());
      }),
      { numRuns: 300 },
    );
  });

  it('multi-range transactions replay exactly, astral chars and newlines included (property)', () => {
    const unit = fc.constantFrom('a', 'b', ' ', '\n', '😀', 'é');
    const text = (max: number) => fc.array(unit, { maxLength: max }).map((a) => a.join(''));
    const edit = fc.record({ p: fc.nat(), del: fc.nat({ max: 4 }), ins: text(4) });
    fc.assert(
      fc.property(text(20), fc.array(edit, { minLength: 1, maxLength: 3 }), (doc, edits) => {
        const state = EditorState.create({ doc });
        // sorted, non-overlapping ranges (positions may split a surrogate pair: UTF-16 units, as in CodeMirror)
        const changes: { from: number; to: number; insert: string }[] = [];
        let min = 0;
        for (const e of [...edits].sort((a, b) => (a.p % (doc.length + 1)) - (b.p % (doc.length + 1)))) {
          const from = Math.max(min, e.p % (doc.length + 1));
          if (from > doc.length) break;
          const to = Math.min(doc.length, from + e.del);
          changes.push({ from, to, insert: e.ins });
          min = to + 1;
        }
        const tr = state.update({ changes });
        expect(apply(doc, [0, 0, ...runsFromTransaction(tr)])).toBe(tr.newDoc.toString());
      }),
      { numRuns: 300 },
    );
  });

  it('classifies typing, autocorrect and paste', () => {
    const s = EditorState.create({ doc: 'teh ' });
    expect(kindOf(s.update({ changes: { from: 4, insert: 'a' }, userEvent: 'input.type' }))).toBe('type');
    expect(kindOf(s.update({ changes: { from: 0, to: 3, insert: 'the' }, userEvent: 'input.type' }))).toBe('compose');
    expect(kindOf(s.update({ changes: { from: 0, insert: 'あ' }, userEvent: 'input.type.compose' }))).toBe('compose');
    expect(kindOf(s.update({ changes: { from: 0, insert: 'pasted text' }, userEvent: 'input.paste' }))).toBe('other');
  });
});

const mounted: { view: EditorView; parent: HTMLElement }[] = [];
afterEach(() => {
  for (const { view, parent } of mounted.splice(0)) {
    view.destroy();
    parent.remove();
  }
});

function mount(doc: string, cursor: number, focus: FocusMode = 'paragraph') {
  const changes: Change[] = [];
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = createEditor(parent, {
    doc,
    onChange: (c) => changes.push(c),
    onActivity: () => {},
    focus,
    typewriter: false,
    readOnly: false,
  });
  view.dispatch({ selection: { anchor: cursor } });
  mounted.push({ view, parent });
  return { view, changes, parent };
}

describe('hybrid markdown (R6, text-only)', () => {
  it('hides heading marks off the caret line and shows them on it', () => {
    const doc = '# Title\n\nbody text';
    const { view } = mount(doc, doc.length);
    expect(view.contentDOM.textContent).not.toContain('# ');
    expect(view.contentDOM.querySelector('.cm-h1')).not.toBeNull();
    view.dispatch({ selection: { anchor: 3 } });
    expect(view.contentDOM.textContent).toContain('# Title');
  });

  it('letter-style hostile content never creates img, iframe or anchor elements', () => {
    const doc =
      '![x](https://example.com/p.png)\n\n<img src="https://example.com/a.png">\n<iframe src="https://example.com"></iframe>\n[link](https://example.com)\n\nend';
    const { parent } = mount(doc, doc.length);
    expect(parent.querySelectorAll('img, iframe, a, object, embed, video, audio, link').length).toBe(0);
  });

  it('marks blank separator lines with cm-gap, except the caret line', () => {
    const doc = 'one\n\ntwo\n\nthree';
    const { view } = mount(doc, 0);
    const gaps = () => [...view.contentDOM.querySelectorAll('.cm-line')].map((l) => l.classList.contains('cm-gap'));
    expect(gaps()).toEqual([false, true, false, true, false]);
    view.dispatch({ selection: { anchor: 4 } }); // caret on the first blank line
    expect(gaps()).toEqual([false, false, false, true, false]);
  });

  it('does not mark double blanks, a leading blank or the last line', () => {
    const { view } = mount('\none\n\n\ntwo\n', 1);
    const gaps = [...view.contentDOM.querySelectorAll('.cm-line')].map((l) => l.classList.contains('cm-gap'));
    expect(gaps).toEqual([false, false, false, false, false, false]);
  });
});

describe('focus mode', () => {
  it('dims every paragraph except the caret paragraph', () => {
    const doc = 'first para\n\nsecond para\n\nthird para';
    const { view } = mount(doc, 14);
    const dimmed = [...view.contentDOM.querySelectorAll('.cm-line.cm-dim')].map((l) => l.textContent);
    expect(dimmed).toContain('first para');
    expect(dimmed).toContain('third para');
    expect(dimmed).not.toContain('second para');
  });

  it('finds paragraphs and sentences', () => {
    const state = EditorState.create({ doc: 'a\nb\n\nc' });
    expect(paragraphAt(state, 0)).toEqual({ from: 0, to: 3 });
    expect(sentenceAt('One. Two three. Four', 7)).toEqual({ from: 5, to: 16 });
    expect(sentenceAt('One. Two three. Four', 0)).toEqual({ from: 0, to: 5 });
    expect(sentenceAt('One. Two three. Four', 20)).toEqual({ from: 16, to: 20 });
    expect(sentenceAt('no punctuation here', 6)).toEqual({ from: 0, to: 19 });
  });

  it('sentence mode dims the other sentences of the caret line', () => {
    const doc = 'One. Two three. Four';
    const { view } = mount(doc, 9, 'sentence');
    const dimmed = [...view.contentDOM.querySelectorAll('.cm-dim')].map((e) => e.textContent).join('|');
    expect(dimmed).toBe('One. |Four');
  });

  it('paragraphAt stays fast and correct within bounds on a doc without blank lines', () => {
    const doc = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join('\n');
    const state = EditorState.create({ doc });
    const pos = state.doc.line(25_000).from;
    const t0 = performance.now();
    let r = { from: 0, to: 0 };
    for (let i = 0; i < 100; i++) r = paragraphAt(state, pos, 24_950, 25_050);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(r).toEqual({ from: state.doc.line(24_950).from, to: state.doc.line(25_050).to });
  });
});

describe('loading text', () => {
  it('records real edits', () => {
    const { view, changes } = mount('ab', 2);
    view.dispatch({ changes: { from: 2, insert: 'c' }, userEvent: 'input.type' });
    expect(changes).toEqual([{ runs: [2, 'c'], at: expect.any(Number), kind: 'type' }]);
    expect(view).toBeInstanceOf(EditorView);
  });
});

describe('loadText', () => {
  it('is not recorded and cannot be undone back to the previous document', () => {
    const changes: Change[] = [];
    const view = createEditor(document.createElement('div'), {
      doc: 'old',
      onChange: (c) => changes.push(c),
      onActivity: () => {},
      focus: 'off',
      typewriter: false,
      readOnly: false,
    });
    loadText(view, 'loaded from storage');
    expect(changes).toHaveLength(0);
    undo(view);
    expect(view.state.doc.toString()).toBe('loaded from storage');
    view.destroy();
  });

  it('resets undo history so stale pre-handover text cannot come back', () => {
    // a deletion: its undo is an insertion, which survives mapping through the full replace
    const { view, changes } = mount('mine stale', 10);
    view.dispatch({ changes: { from: 4, to: 10 }, userEvent: 'delete.backward' });
    expect(undoDepth(view.state)).toBe(1);
    changes.length = 0;
    loadText(view, 'their newer text');
    expect(undoDepth(view.state)).toBe(0);
    expect(redoDepth(view.state)).toBe(0);
    undo(view);
    expect(view.state.doc.toString()).toBe('their newer text');
    expect(changes).toHaveLength(0);

    view.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
    expect(undoDepth(view.state)).toBe(1);
    undo(view);
    expect(view.state.doc.toString()).toBe('their newer text');
  });
});
