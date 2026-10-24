// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { apply } from '../core/kop';
import { kindOf, runsFromTransaction } from './recorder';
import { createEditor, loadText } from './setup';
import { paragraphAt, sentenceAt } from './focus';
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

  it('classifies typing, autocorrect and paste', () => {
    const s = EditorState.create({ doc: 'teh ' });
    expect(kindOf(s.update({ changes: { from: 4, insert: 'a' }, userEvent: 'input.type' }))).toBe('type');
    expect(kindOf(s.update({ changes: { from: 0, to: 3, insert: 'the' }, userEvent: 'input.type' }))).toBe('compose');
    expect(kindOf(s.update({ changes: { from: 0, insert: 'あ' }, userEvent: 'input.type.compose' }))).toBe('compose');
    expect(kindOf(s.update({ changes: { from: 0, insert: 'pasted text' }, userEvent: 'input.paste' }))).toBe('other');
  });
});

function mount(doc: string, cursor: number) {
  const changes: Change[] = [];
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = createEditor(parent, {
    doc,
    onChange: (c) => changes.push(c),
    onActivity: () => {},
    focus: 'paragraph',
    typewriter: false,
    readOnly: false,
  });
  view.dispatch({ selection: { anchor: cursor } });
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
  });
});

describe('loading text', () => {
  it('is not recorded and not undoable', () => {
    const { view, changes } = mount('', 0);
    loadText(view, 'loaded draft');
    expect(changes).toHaveLength(0);
    expect(view.state.doc.toString()).toBe('loaded draft');
  });

  it('records real edits', () => {
    const { view, changes } = mount('ab', 2);
    view.dispatch({ changes: { from: 2, insert: 'c' }, userEvent: 'input.type' });
    expect(changes).toEqual([{ runs: [2, 'c'], at: expect.any(Number), kind: 'type' }]);
    expect(view).toBeInstanceOf(EditorView);
  });
});

describe('loadText', () => {
  it('is not recorded and cannot be undone back to the previous document', async () => {
    const { undo } = await import('@codemirror/commands');
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
});
