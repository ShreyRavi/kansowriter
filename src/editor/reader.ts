import { ChangeSet, Compartment, EditorState, StateEffect, StateField, Text, type ChangeSpec } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { hybridMarkdown, revealSyntax, writingLanguage } from './hybrid';
import type { Run } from '../core/kop';
import type { ReplayStep } from '../core/letter';

/**
 * Letter reader (1A): a read-only CodeMirror view with the editor's text-only Markdown
 * decoration (R6) and a replay player that feeds ReplayStep runs into it over time.
 * No recorder, no history: nothing here writes anywhere.
 *
 *   baseText (instant) ──► steps due by the clock ──► one composed change per frame
 *                          (a paste's characters share one `at`, so they land together)
 *                          backlog (seek, skip, hidden tab) ──► rebuilt off-screen as a Text,
 *                          a few ms per frame, then swapped in with one change
 */

const setCaret = StateEffect.define<number | null>();

class CaretWidget extends WidgetType {
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-reader-caret';
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
  eq() {
    return true;
  }
}
const caretWidget = Decoration.widget({ widget: new CaretWidget(), side: 1 });

/** the replay caret: a drawn 2px mark (a non-editable view has no native caret) */
const caretField = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(setCaret)) pos = e.value;
    if (pos === null) return null;
    return Math.min(tr.docChanged && !tr.effects.some((e) => e.is(setCaret)) ? tr.changes.mapPos(pos, 1) : pos, tr.state.doc.length);
  },
  provide: (f) => EditorView.decorations.from(f, (pos) => (pos === null ? Decoration.none : Decoration.set([caretWidget.range(pos)]))),
});

const revealC = new Compartment();

export function createReaderView(parent: HTMLElement, doc: string, label: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      // positions are UTF-16 offsets into the letter's own text: a "\r" must stay one character
      EditorState.lineSeparator.of('\n'),
      // the editor's language (R6: text only, no embedded languages)
      writingLanguage,
      EditorView.lineWrapping,
      hybridMarkdown,
      revealC.of(revealSyntax.of(true)),
      caretField,
      EditorView.contentAttributes.of({ 'aria-label': label }),
    ],
  });
  return new EditorView({ state, parent });
}

/** KOP runs (against the doc before them) → CodeMirror change specs. */
export function runsToChanges(runs: Run[]): ChangeSpec[] {
  const out: { from: number; to?: number; insert?: string }[] = [];
  let pos = 0;
  for (const r of runs) {
    if (typeof r === 'string') {
      out.push({ from: pos, insert: r });
    } else if (r > 0) pos += r;
    else {
      const last = out[out.length - 1];
      // an insert and a delete at the same point are one replacement
      if (last && last.from === pos && last.to === undefined) last.to = pos - r;
      else out.push({ from: pos, to: pos - r });
      pos -= r;
    }
  }
  return out;
}

const applyToText = (doc: Text, runs: Run[]): Text => ChangeSet.of(runsToChanges(runs), doc.length, '\n').apply(doc);

export interface PlayerState {
  /** replay time, ms */
  t: number;
  duration: number;
  playing: boolean;
  /** every step applied and the clock at the end */
  done: boolean;
}

/** steps applied live per frame before the player switches to the off-screen rebuild */
const LIVE_MAX = 400;
/** off-screen rebuild work per frame, ms (keeps a long letter from blocking the tab) */
const BUDGET_MS = 8;

export class ReplayPlayer {
  readonly duration: number;
  private index = 0;
  private clock = 0;
  private resumedAt = 0;
  private playing = false;
  private finished = false;
  private caret: number;
  private rebuild: Text | null = null;
  private frame = 0;

  constructor(
    private readonly view: EditorView,
    private readonly base: string,
    private readonly steps: ReplayStep[],
    private readonly onState: (s: PlayerState) => void,
  ) {
    this.duration = steps.length ? steps[steps.length - 1]!.at : 0;
    this.caret = base.length;
  }

  private now(): number {
    return Math.min(this.duration, this.playing ? this.clock + (performance.now() - this.resumedAt) : this.clock);
  }

  /** index of the first step not yet due at time t */
  private dueBy(t: number): number {
    let lo = this.index;
    let hi = this.steps.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.steps[mid]!.at <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private schedule() {
    if (!this.frame)
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.tick();
      });
  }

  private tick() {
    const t = this.now();
    const upto = this.dueBy(t);
    const { view } = this;
    if (this.rebuild || upto - this.index > LIVE_MAX) {
      let doc = this.rebuild ?? view.state.doc;
      const stop = performance.now() + BUDGET_MS;
      while (this.index < upto) {
        const s = this.steps[this.index++]!;
        doc = applyToText(doc, s.runs);
        this.caret = s.caret;
        if ((this.index & 63) === 0 && performance.now() > stop) break;
      }
      this.rebuild = doc;
      if (this.index === upto) {
        this.rebuild = null;
        const caret = Math.min(this.caret, doc.length);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: doc },
          selection: { anchor: caret },
          effects: setCaret.of(caret),
          scrollIntoView: this.playing,
        });
      }
    } else if (upto > this.index) {
      let cs = ChangeSet.empty(view.state.doc.length);
      for (; this.index < upto; this.index++) {
        const s = this.steps[this.index]!;
        cs = cs.compose(ChangeSet.of(runsToChanges(s.runs), cs.newLength, '\n'));
        this.caret = s.caret;
      }
      const caret = Math.min(this.caret, cs.newLength);
      // the page follows the pen while it plays (never while skipping or showing the end at once)
      view.dispatch({ changes: cs, selection: { anchor: caret }, effects: setCaret.of(caret), scrollIntoView: this.playing });
    }
    const caughtUp = !this.rebuild && this.index === upto;
    const done = caughtUp && this.index === this.steps.length && t >= this.duration;
    if (done && !this.finished) this.finish();
    this.onState({ t, duration: this.duration, playing: this.playing && !done, done });
    if (done) this.playing = false;
    else if (this.playing || !caughtUp) this.schedule();
  }

  /** end state (1A): caret gone, no syntax marks on any line */
  private finish() {
    this.finished = true;
    this.clock = this.duration;
    this.view.dispatch({ effects: [setCaret.of(null), revealC.reconfigure(revealSyntax.of(false))] });
  }

  private unfinish() {
    if (!this.finished) return;
    this.finished = false;
    this.view.dispatch({ effects: [revealC.reconfigure(revealSyntax.of(true))] });
  }

  isPlaying(): boolean {
    return this.playing;
  }

  play() {
    if (this.finished) this.seek(0);
    if (this.playing) return;
    this.clock = this.now();
    this.resumedAt = performance.now();
    this.playing = true;
    if (!this.finished) this.view.dispatch({ effects: setCaret.of(Math.min(this.caret, this.view.state.doc.length)) });
    this.schedule();
  }

  pause() {
    if (!this.playing) return;
    this.clock = this.now();
    this.playing = false;
    this.onState({ t: this.clock, duration: this.duration, playing: false, done: this.finished });
  }

  /**
   * Jump to replay time t: forward continues from here; backward rebuilds from baseText, but only
   * when a step past t was already applied (so a drag's run of backward seeks restarts the
   * rebuild only when it overshoots, and otherwise just retargets it).
   */
  seek(t: number) {
    const target = Math.max(0, Math.min(this.duration, t));
    if (this.finished && target >= this.duration) return;
    if (this.finished || (this.index > 0 && this.steps[this.index - 1]!.at > target)) {
      this.unfinish();
      this.index = 0;
      this.caret = this.base.length;
      this.rebuild = Text.of(this.base.split('\n'));
    }
    this.clock = target;
    this.resumedAt = performance.now();
    if (target < this.duration) this.view.dispatch({ effects: setCaret.of(Math.min(this.caret, this.view.state.doc.length)) });
    this.schedule();
  }

  skipToEnd() {
    this.seek(this.duration);
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.playing = false;
  }
}
