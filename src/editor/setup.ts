import { Compartment, EditorState, Transaction, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { hybridMarkdown, writingLanguage } from './hybrid';
import { formatKeymap } from './keys';
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
  /** every update (selection, text, read-only): drives the formatting toolbar's state */
  onUpdate?(state: EditorState): void;
}

const readOnlyC = new Compartment();
const historyC = new Compartment();
const typewriterC = new Compartment();

/**
 * Typewriter scrolling: keep the caret line at 40% of the viewport height (page scroll).
 * Loads and follower updates (notRecorded) never scroll: a reader's place stays put.
 */
function typewriterExt(on: boolean): Extension {
  if (!on) return [];
  return EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    if (u.transactions.some((tr) => tr.annotation(notRecorded))) return;
    // a checklist box clicked away from the caret: the page stays where the reader is looking
    if (u.transactions.every((tr) => tr.isUserEvent('input.check'))) return;
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
 * recorder, formatting shortcuts (src/editor/keys.ts). Tab is NOT bound, so Tab moves focus out of
 * the editor to the chrome (17A).
 */
export function createEditor(parent: HTMLElement, o: EditorOptions): EditorView {
  const state = EditorState.create({
    doc: o.doc,
    extensions: [
      historyC.of(history()),
      // formatting first: its ⌘I / ⌘U / ⌘↵ replace the default keymap's selectParentSyntax / undoSelection / insertBlankLine
      keymap.of([...formatKeymap, ...defaultKeymap, ...historyKeymap]),
      // CommonMark + strikethrough + task lists, nothing embedded (R6: text only)
      writingLanguage,
      EditorView.lineWrapping,
      hybridMarkdown,
      focusMode(o.focus),
      typewriterC.of(typewriterExt(o.typewriter)),
      readOnlyC.of([EditorState.readOnly.of(o.readOnly), EditorView.editable.of(!o.readOnly)]),
      placeholderExt('Start writing'),
      recorder(o.onChange),
      EditorView.domEventHandlers({ keydown: () => o.onActivity() }),
      o.onUpdate ? EditorView.updateListener.of((u) => o.onUpdate!(u.state)) : [],
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

/**
 * Replace the whole document without recording it (loading a draft or a rebuilt writer).
 * Undo history is reset: old events mapped through the full replace could otherwise
 * reinsert stale pre-handover text, which the recorder would then save. Removing the
 * history field drops its state; adding it back starts empty.
 */
export function loadText(view: EditorView, text: string): void {
  if (view.state.doc.toString() === text) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    effects: historyC.reconfigure([]),
    annotations: [notRecorded.of(true), Transaction.addToHistory.of(false)],
  });
  view.dispatch({ effects: historyC.reconfigure(history()) });
}

/**
 * Bring a read-only view up to `text` with the smallest single change (common prefix/suffix
 * kept), not recorded and not in undo history. Unlike loadText the selection maps through the
 * change and the scroll position stays: a tab following another tab's commits isn't yanked.
 */
export function followText(view: EditorView, text: string): void {
  const cur = view.state.doc.toString();
  if (cur === text) return;
  const max = Math.min(cur.length, text.length);
  let start = 0;
  while (start < max && cur.charCodeAt(start) === text.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && cur.charCodeAt(cur.length - 1 - end) === text.charCodeAt(text.length - 1 - end)) end++;
  view.dispatch({
    changes: { from: start, to: cur.length - end, insert: text.slice(start, text.length - end) },
    annotations: [notRecorded.of(true), Transaction.addToHistory.of(false)],
  });
}

export { setFocusMode };
