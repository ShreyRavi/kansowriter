import { Annotation, type Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { Run } from '../core/kop';
import type { Change } from '../storage/writer';

/** Marks doc replacements that must not be recorded (loading a draft into the view). */
export const notRecorded = Annotation.define<boolean>();

/** CodeMirror ChangeSet → KOP runs (UTF-16 positions, same unit as CodeMirror). */
export function runsFromTransaction(tr: Transaction): Run[] {
  const runs: Run[] = [];
  let pos = 0;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (fromA > pos) runs.push(fromA - pos);
    const text = inserted.toString();
    if (text) runs.push(text);
    if (toA > fromA) runs.push(-(toA - fromA));
    pos = toA;
  });
  const len = tr.startState.doc.length;
  if (len > pos) runs.push(len - pos);
  return runs;
}

/**
 * Classify a change for merging (R22):
 *  - one typed character → 'type'
 *  - IME composition or autocorrect/replace inside a word → 'compose'
 *  - everything else (paste, delete, undo, multi-cursor) → 'other'
 */
export function kindOf(tr: Transaction): Change['kind'] {
  if (tr.isUserEvent('input.type.compose') || tr.isUserEvent('input.complete')) return 'compose';
  if (tr.isUserEvent('input.type')) {
    let single = true;
    let replaced = false;
    let count = 0;
    tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
      count++;
      if (toA > fromA) replaced = true;
      if (inserted.length !== 1) single = false;
    });
    if (count === 1 && single && !replaced) return 'type';
    if (count === 1 && replaced) return 'compose'; // autocorrect replacing a word
  }
  return 'other';
}

/** Feeds every recorded document change to `onChange`. */
export function recorder(onChange: (c: Change) => void) {
  return EditorView.updateListener.of((u) => {
    for (const tr of u.transactions) {
      if (!tr.docChanged || tr.annotation(notRecorded)) continue;
      onChange({ runs: runsFromTransaction(tr), at: Date.now(), kind: kindOf(tr) });
    }
  });
}
