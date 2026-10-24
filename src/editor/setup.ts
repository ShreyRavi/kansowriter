import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { commonmarkLanguage } from '@codemirror/lang-markdown';
import { hybridMarkdown } from './hybrid';
import { focusMode, setFocusMode, type FocusMode } from './focus';
import { notRecorded, recorder } from './recorder';
import type { Change } from '../storage/writer';

export interface EditorOptions {
  doc: string;
  onChange(c: Change): void;
  /** any keystroke in the editor (drives the chrome fade) */
  onActivity(): void;
  focus: FocusMode;
  typewriter: boolean;
  readOnly: boolean;
}

const readOnlyC = new Compartment();
const typewriterC = new Compartment();

/** Typewriter scrolling: keep the caret line at 40% of the viewport height (page scroll). */
function typewriterExt(on: boolean): Extension {
  if (!on) return [];
  return EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    const view = u.view;
    view.requestMeasure({
      key: 'typewriter', // one measure per frame, however many updates arrive
      read: () => view.coordsAtPos(view.state.selection.main.head),
      write: (coords) => {
        if (!coords) return;
        const target = window.innerHeight * 0.4;
        const delta = coords.top - target;
        if (Math.abs(delta) > 2) window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
      },
    });
  });
}

/**
 * CodeMirror setup: markdown, hybrid text-only decorations, focus dimming, typewriter scroll,
 * recorder. Tab is NOT bound, so Tab moves focus out of the editor to the chrome (17A).
 */
export function createEditor(parent: HTMLElement, o: EditorOptions): EditorView {
  const state = EditorState.create({
    doc: o.doc,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      // plain CommonMark: markdown() would bundle the HTML/CSS/JS parsers for embedded code (R6: text only)
      commonmarkLanguage,
      EditorView.lineWrapping,
      hybridMarkdown,
      focusMode(o.focus),
      typewriterC.of(typewriterExt(o.typewriter)),
      readOnlyC.of([EditorState.readOnly.of(o.readOnly), EditorView.editable.of(!o.readOnly)]),
      placeholderExt('Start writing'),
      recorder(o.onChange),
      EditorView.domEventHandlers({ keydown: () => o.onActivity() }),
      EditorView.contentAttributes.of({ 'aria-label': 'Draft', 'aria-multiline': 'true', spellcheck: 'true', autocorrect: 'on' }),
    ],
  });
  return new EditorView({ state, parent });
}

export function setReadOnly(view: EditorView, ro: boolean): void {
  view.dispatch({ effects: readOnlyC.reconfigure([EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]) });
}

export function setTypewriter(view: EditorView, on: boolean): void {
  view.dispatch({ effects: typewriterC.reconfigure(typewriterExt(on)) });
}

/** Replace the whole document without recording it (loading a draft or a rebuilt writer). */
export function loadText(view: EditorView, text: string): void {
  if (view.state.doc.toString() === text) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: [notRecorded.of(true), Transaction.addToHistory.of(false)] });
}

export { setFocusMode };
