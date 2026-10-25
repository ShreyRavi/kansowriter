// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { ChangeSet, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { apply, type Op, type Run } from '../core/kop';
import { replaySteps, type Letter, type ReplayStep } from '../core/letter';
import { createReaderView, ReplayPlayer, runsToChanges, type PlayerState } from './reader';
import { revealSyntax } from './hybrid';
import { writtenLine } from '../ui/Replay';

const runsFor = (doc: string, p: number, del: number, ins: string): Run[] => {
  const from = doc.length ? p % (doc.length + 1) : 0;
  const n = Math.min(doc.length - from, del);
  return [from, ins, -n, doc.length - from - n].filter((r) => r !== 0 && r !== '');
};

describe('reader: KOP runs → CodeMirror', () => {
  it('runsToChanges matches apply (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.nat(), fc.nat({ max: 5 }), fc.string({ maxLength: 5 }), (doc, p, del, ins) => {
        const runs = runsFor(doc, p, del, ins);
        const cs = ChangeSet.of(runsToChanges(runs), doc.length, '\n');
        const out = cs.apply(Text.of(doc.split('\n'))).toString();
        expect(out).toBe(apply(doc, [0, 0, ...runs]));
      }),
      { numRuns: 300 },
    );
  });

  it('letter content never creates a loading or clickable element (R6)', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = createReaderView(
      host,
      '# Hi\n\n![x](https://example.com/p.png)\n<img src=https://example.com/a.png>\n<iframe></iframe>\n[a link](https://example.com)',
      'Letter',
    );
    expect(host.querySelectorAll('img, iframe, a, object, embed, video, audio, link, script').length).toBe(0);
    expect(view.state.doc.toString()).toContain('![x](https://example.com/p.png)');
    view.destroy();
  });

  it('writtenLine: writer-local day, omitted without meta', () => {
    expect(writtenLine(undefined)).toBeNull();
    expect(writtenLine({})).toBeNull();
    // 2026-10-23 02:00 UTC, written at UTC−7 (tz 420): still Oct 22 for the writer
    const at = Date.UTC(2026, 9, 23, 2);
    expect(writtenLine({ writtenAt: at, tz: 420 }, at)).toMatch(/^A letter, written .*22/);
  });
});

// ---- ReplayPlayer: a fake clock and a manual animation-frame queue ---------------------------
let now = 0;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
/** performance.now advances this much on every call (exercises the rebuild's frame budget) */
let drift = 0;

// jsdom has no layout: CodeMirror's scrollIntoView measures ranges
if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}

beforeEach(() => {
  now = 0;
  drift = 0;
  frames = new Map();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.set(nextFrame, cb);
    return nextFrame++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.spyOn(performance, 'now').mockImplementation(() => (now += drift));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** run the frames queued right now (one animation frame) */
function frame() {
  const due = [...frames];
  frames.clear();
  for (const [, cb] of due) cb(now);
}
/** advance the clock in 16 ms frames */
function advance(ms: number) {
  for (let left = ms; left > 0; left -= 16) {
    now += Math.min(16, left);
    frame();
  }
}
/** run frames without moving the clock until nothing is scheduled */
function settle(max = 10_000) {
  for (let i = 0; i < max && frames.size; i++) frame();
  expect(frames.size).toBe(0);
}

const applyRuns = (text: string, runs: Run[]) => apply(text, [0, 0, ...runs]);
const textAt = (base: string, steps: ReplayStep[], t: number) =>
  steps.filter((s) => s.at <= t).reduce((x, s) => applyRuns(x, s.runs), base);

function setup(letter: Letter) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const view = createReaderView(host, letter.baseText, 'Letter');
  const steps = replaySteps(letter);
  const states: PlayerState[] = [];
  const player = new ReplayPlayer(view, letter.baseText, steps, (s) => states.push(s));
  const final = letter.ops.reduce((t, op) => apply(t, op), letter.baseText);
  return { view, player, steps, states, final, last: () => states[states.length - 1]! };
}
const doc = (v: EditorView) => v.state.doc.toString();
const revealed = (v: EditorView) => v.state.facet(revealSyntax);

/** "Hello world, again" typed word by word: steps spread over ~6 s */
const typed: Letter = {
  v: 1,
  baseText: 'Dear you,\n',
  ops: [
    [0, 800, 10, 'Hello'],
    [300, 1000, 15, ' world,'],
    [3000, 900, 22, ' again'],
    [500, 0, 24, -2, 2],
  ],
};

describe('ReplayPlayer', () => {
  it('plays live to the exact final text; finishing hides syntax and the caret', () => {
    const { view, player, final, last } = setup(typed);
    expect(revealed(view)).toBe(true);
    player.play();
    advance(1000);
    expect(doc(view)).toBe(textAt(typed.baseText, replaySteps(typed), 1000));
    advance(player.duration);
    expect(doc(view)).toBe(final);
    expect(last()).toMatchObject({ done: true, playing: false, t: player.duration });
    expect(player.isPlaying()).toBe(false);
    expect(revealed(view)).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('more than LIVE_MAX steps due at once take the off-screen rebuild, across frames, to the exact text', () => {
    const ops: Op[] = [];
    let len = 0;
    for (let i = 0; i < 2000; i++) {
      const ch = i % 50 === 49 ? '\n' : String.fromCharCode(97 + (i % 26));
      ops.push(len ? [0, 0, len, ch] : [0, 0, ch]);
      len++;
    }
    const letter: Letter = { v: 1, baseText: '', ops };
    const { view, player, final, last } = setup(letter);
    const dispatch = vi.spyOn(view, 'dispatch');
    drift = 1; // every performance.now() call costs 1 ms: the 8 ms budget splits the rebuild
    player.play();
    frame();
    expect(doc(view)).toBe(''); // still rebuilding off-screen: nothing shown half-done
    settle();
    expect(doc(view)).toBe(final);
    expect(last().done).toBe(true);
    // the whole backlog landed as one change
    expect(dispatch.mock.calls.filter(([spec]) => spec && 'changes' in spec)).toHaveLength(1);
  });

  it('skip to end from paused shows the final text and stays not playing', () => {
    const { view, player, final, last } = setup(typed);
    player.skipToEnd();
    settle();
    expect(doc(view)).toBe(final);
    expect(last()).toMatchObject({ done: true, playing: false });
    expect(revealed(view)).toBe(false);
    player.skipToEnd(); // already at the end: nothing to do
    expect(frames.size).toBe(0);
  });

  it('seek back while paused rebuilds from baseText and stays paused', () => {
    const { view, player, steps, last } = setup(typed);
    player.play();
    advance(4000);
    player.pause();
    const at = doc(view);
    expect(at).toBe(textAt(typed.baseText, steps, 4000));
    player.seek(900);
    settle();
    expect(doc(view)).toBe(textAt(typed.baseText, steps, 900));
    expect(player.isPlaying()).toBe(false);
    expect(last()).toMatchObject({ t: 900, playing: false, done: false });
    advance(2000); // the clock doesn't run while paused
    expect(doc(view)).toBe(textAt(typed.baseText, steps, 900));
  });

  it('seek back while playing keeps playing to the end', () => {
    const { view, player, steps, final } = setup(typed);
    player.play();
    advance(4000);
    player.seek(500);
    frame();
    expect(doc(view)).toBe(textAt(typed.baseText, steps, 500));
    expect(player.isPlaying()).toBe(true);
    advance(player.duration);
    expect(doc(view)).toBe(final);
  });

  it('backward seeks that no applied step passes just retarget (a drag never restarts the rebuild needlessly)', () => {
    const { view, player, steps } = setup(typed);
    player.play();
    advance(2200); // 'Hello world,' done; the next op starts at 5100
    player.pause();
    const dispatch = vi.spyOn(view, 'dispatch');
    player.seek(2150);
    settle();
    expect(dispatch.mock.calls.filter(([spec]) => spec && 'changes' in spec)).toHaveLength(0);
    expect(doc(view)).toBe(textAt(typed.baseText, steps, 2150));
    // a drag: two backward seeks before a frame rebuild once, toward the latest target
    player.seek(1000);
    player.seek(300);
    settle();
    expect(doc(view)).toBe(textAt(typed.baseText, steps, 300));
    expect(dispatch.mock.calls.filter(([spec]) => spec && 'changes' in spec)).toHaveLength(1);
  });

  it('play() after finishing restarts from baseText with syntax revealed again', () => {
    const { view, player, final } = setup(typed);
    player.skipToEnd();
    settle();
    expect(revealed(view)).toBe(false);
    player.play();
    expect(revealed(view)).toBe(true);
    expect(player.isPlaying()).toBe(true);
    frame();
    expect(doc(view)).toBe(typed.baseText + 'H');
    advance(player.duration);
    expect(doc(view)).toBe(final);
    expect(revealed(view)).toBe(false);
  });
});
