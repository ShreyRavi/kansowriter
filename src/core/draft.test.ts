import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { apply, makeOp, type Op } from './kop';
import { deriveMeta, needsNewSession, opTimes, renameChange, replay, SESSION_GAP_MS, shouldSnapshot, type Session } from './draft';

const arbEdits = fc.array(
  fc.record({ pos: fc.nat(), del: fc.nat({ max: 5 }), ins: fc.string({ maxLength: 6 }) }),
  { maxLength: 60 },
);

function toOps(edits: { pos: number; del: number; ins: string }[]): { ops: Op[]; text: string } {
  let text = '';
  const ops: Op[] = [];
  for (const e of edits) {
    const at = text.length ? e.pos % (text.length + 1) : 0;
    const del = Math.min(e.del, text.length - at);
    if (!del && !e.ins) continue;
    const op = makeOp(1, 0, [at, -del, e.ins, text.length - at - del]);
    text = apply(text, op);
    ops.push(op);
  }
  return { ops, text };
}

describe('replay', () => {
  it('replaying the log reproduces the text (property)', () => {
    fc.assert(
      fc.property(arbEdits, (edits) => {
        const { ops, text } = toOps(edits);
        expect(replay(null, ops)).toBe(text);
      }),
      { numRuns: 300 },
    );
  });

  it('loading from a snapshot equals replaying from zero', () => {
    fc.assert(
      fc.property(arbEdits, fc.nat(), (edits, cut) => {
        const { ops, text } = toOps(edits);
        const k = ops.length ? cut % (ops.length + 1) : 0;
        const snap = { opIndex: k, text: replay(null, ops.slice(0, k)) };
        expect(replay(snap, ops.slice(k))).toBe(text);
      }),
      { numRuns: 200 },
    );
  });
});

describe('sessions (R16)', () => {
  it('starts a session on first op after open or after a >30 min gap', () => {
    expect(needsNewSession(null, 1000, false)).toBe(true);
    expect(needsNewSession(1000, 2000, true)).toBe(true);
    expect(needsNewSession(0, SESSION_GAP_MS - 1000, false)).toBe(false);
    expect(needsNewSession(0, SESSION_GAP_MS + 1000, false)).toBe(true);
  });

  it('derives absolute op times from session starts plus dt and d', () => {
    const sessions: Session[] = [
      { opIndex: 0, at: 1_000_000, tzOffset: 0 },
      { opIndex: 2, at: 5_000_000, tzOffset: 0 },
    ];
    const ops: Op[] = [[0, 300, 'ab'], [200, 0, 2, 'c'], [0, 0, 3, 'd']];
    expect(opTimes(sessions, ops)).toEqual([1_000_000, 1_000_500, 5_000_000]);
  });
});

describe('opTimes across sessions', () => {
  it('restarts the clock at each session start', () => {
    const sessions: Session[] = [{ opIndex: 0, at: 1000, tzOffset: 0 }, { opIndex: 1, at: 9000, tzOffset: 0 }];
    expect(opTimes(sessions, [[0, 50, 'a'], [400, 0, 1, 'b']])).toEqual([1000, 9000]);
  });
});

describe('meta', () => {
  it('derives title, excerpt and word count', () => {
    expect(deriveMeta('# On silence\n\nA few minutes into writing.')).toEqual({
      title: 'On silence',
      excerpt: 'A few minutes into writing.',
      words: 7,
    });
    expect(deriveMeta('').title).toBe('Untitled');
  });
  it('snapshots every 500 ops', () => {
    expect(shouldSnapshot(0)).toBe(false);
    expect(shouldSnapshot(500)).toBe(true);
    expect(shouldSnapshot(501)).toBe(false);
  });
});

describe('renameChange (rename never overwrites the first line of prose)', () => {
  const run = (doc: string, t: string) => {
    const c = renameChange(doc, t);
    return doc.slice(0, c.from) + c.insert + doc.slice(c.to);
  };
  it('replaces an existing heading, keeping its level', () => {
    expect(run('# Old\n\nBody', 'New')).toBe('# New\n\nBody');
    expect(run('\n## Old\nBody', 'New')).toBe('\n## New\nBody');
    expect(run('#\nBody', 'New')).toBe('# New\nBody');
  });
  it('inserts a heading above prose instead of replacing it', () => {
    expect(run('Dear Sam, it has been a while.', 'Letter')).toBe('# Letter\n\nDear Sam, it has been a while.');
    expect(run('#hashtag line', 'T')).toBe('# T\n\n#hashtag line');
  });
  it('an empty draft just gets the heading; a blank title becomes Untitled', () => {
    expect(run('', 'Hi')).toBe('# Hi');
    expect(run('# X', '  ')).toBe('# Untitled');
  });
});
