// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { createEditor, setReadOnly } from './setup';
import { createReaderView } from './reader';
import type { Change } from '../storage/writer';

const views: { view: EditorView; host: HTMLElement }[] = [];
afterEach(() => {
  for (const { view, host } of views.splice(0)) {
    view.destroy();
    host.remove();
  }
});

function editor(doc: string, readOnly = false) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const changes: Change[] = [];
  const view = createEditor(host, {
    doc,
    readOnly,
    focus: 'off',
    typewriter: false,
    onChange: (c) => changes.push(c),
    onActivity: () => {},
  });
  views.push({ view, host });
  return { view, host, changes };
}

function reader(doc: string) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = createReaderView(host, doc, 'Letter');
  views.push({ view, host });
  return { view, host };
}

const DOC = 'first\n<u>under</u> and ~~gone~~ and <b>bold?</b>\n- [ ] milk\n- [x] eggs\n\nlast';

describe('hybrid rendering: underline, strikethrough, checklist boxes', () => {
  it('styles <u> and ~~ off the caret line, hiding their syntax; other HTML stays text (R6)', () => {
    const { host } = editor(DOC); // caret at 0: line 1
    const line = host.querySelectorAll('.cm-line')[1]!;
    expect(line.querySelector('.cm-u')?.textContent).toBe('under');
    expect(line.querySelector('.cm-strike')?.textContent).toBe('gone');
    expect(line.textContent).toBe('under and gone and <b>bold?</b>');
    expect(host.querySelectorAll('u, s, b, strike, input').length).toBe(0);
  });

  it('shows the syntax on the caret line', () => {
    const { view, host } = editor(DOC);
    view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 2 } });
    expect(host.querySelectorAll('.cm-line')[1]!.textContent).toBe('<u>under</u> and ~~gone~~ and <b>bold?</b>');
  });

  it('draws checklist boxes with a role and name; a click is a recorded edit', () => {
    const { view, host, changes } = editor(DOC);
    const boxes = host.querySelectorAll<HTMLElement>('[role="checkbox"]');
    expect(boxes.length).toBe(2);
    expect(boxes[0]!.getAttribute('aria-checked')).toBe('false');
    expect(boxes[0]!.getAttribute('aria-label')).toBe('milk');
    expect(boxes[1]!.getAttribute('aria-checked')).toBe('true');
    expect(host.querySelectorAll('.cm-line')[2]!.textContent).toBe('milk');
    boxes[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(view.state.doc.line(3).text).toBe('- [x] milk');
    expect(changes.length).toBe(1);
    expect(host.querySelectorAll('[role="checkbox"]')[0]!.getAttribute('aria-checked')).toBe('true');
    // the caret didn't move to the box's line
    expect(view.state.selection.main.head).toBe(0);
  });

  it('a read-only editor shows boxes but never changes them', () => {
    const { view, host, changes } = editor(DOC, true);
    const box = host.querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(box.getAttribute('aria-readonly')).toBe('true');
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(view.state.doc.line(3).text).toBe('- [ ] milk');
    expect(changes.length).toBe(0);
  });

  it('the letter reader renders the same way, display-only', () => {
    const { view, host } = reader(DOC);
    view.dispatch({ selection: { anchor: 0 } });
    expect(host.querySelector('.cm-u')?.textContent).toBe('under');
    expect(host.querySelector('.cm-strike')?.textContent).toBe('gone');
    const box = host.querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(box.getAttribute('aria-readonly')).toBe('true');
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(view.state.doc.line(3).text).toBe('- [ ] milk');
  });

  it('boxes follow the tab turning read-only and back (aria-readonly never goes stale)', () => {
    const { view, host, changes } = editor(DOC);
    const box = () => host.querySelector<HTMLElement>('[role="checkbox"]')!;
    expect(box().hasAttribute('aria-readonly')).toBe(false);
    setReadOnly(view, true);
    expect(box().getAttribute('aria-readonly')).toBe('true');
    box().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(changes.length).toBe(0);
    setReadOnly(view, false);
    expect(box().hasAttribute('aria-readonly')).toBe(false);
    box().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(view.state.doc.line(3).text).toBe('- [x] milk');
  });

  it('bullets show as • off the caret line, the marker back on it', () => {
    const { view, host } = editor('top\n- one\n* two\n1. three');
    const lines = () => [...host.querySelectorAll('.cm-line')].map((l) => l.textContent);
    expect(lines()).toEqual(['top', '• one', '• two', '1. three']);
    view.dispatch({ selection: { anchor: view.state.doc.line(2).to } });
    expect(lines()).toEqual(['top', '- one', '• two', '1. three']);
  });
});
