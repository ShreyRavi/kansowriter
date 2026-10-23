import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { apply, compose, insertionOf, isValidOp, makeOp, normalize, runsOf, type Op, type Run } from './kop';

// Golden fixtures: the v1 format. Changing any of these breaks letters already sent (R19 freeze).
const GOLDEN: { before: string; op: Op; after: string }[] = [
  { before: '', op: [0, 0, 'Hello'], after: 'Hello' },
  { before: 'Hello world', op: [120, 0, 6, -5, 'there'], after: 'Hello there' },
  { before: 'abc', op: [5, 300, 3, 'def'], after: 'abcdef' },
  // surrogate pair: 😀 is 2 UTF-16 code units
  { before: 'a😀b', op: [0, 0, 1, -2, 1], after: 'ab' },
  { before: 'ab', op: [0, 0, 1, '😀', 1], after: 'a😀b' },
  // combining mark: e + U+0301 is 2 code units
  { before: 'café!', op: [0, 0, 5, -1], after: 'café' },
];

describe('KOP v1 golden fixtures', () => {
  it.each(GOLDEN)('$before → $after', ({ before, op, after }) => {
    expect(isValidOp(op, before.length)).toBe(true);
    expect(apply(before, op)).toBe(after);
  });

  it('serializes as plain JSON arrays', () => {
    expect(JSON.stringify(GOLDEN[1]!.op)).toBe('[120,0,6,-5,"there"]');
  });
});

describe('isValidOp', () => {
  it('rejects runs that do not cover the document', () => {
    expect(isValidOp([0, 0, 3], 4)).toBe(false);
    expect(isValidOp([0, 0, 5], 4)).toBe(false);
  });
  it('rejects malformed values', () => {
    for (const bad of [null, [], [0], [-1, 0], [0, 0, 0], [0, 0, ''], [0, 0, 1.5], [0, 0, {}], [0, 'x'], 'op']) {
      expect(isValidOp(bad, 0)).toBe(false);
    }
  });
});

const arbDoc = fc.string({ maxLength: 30 });

function arbRuns(len: number): fc.Arbitrary<Run[]> {
  // random edit over a document of length `len`
  return fc
    .array(fc.tuple(fc.integer({ min: 0, max: 3 }), fc.string({ minLength: 1, maxLength: 4 })), { maxLength: 6 })
    .map((steps) => {
      const runs: Run[] = [];
      let left = len;
      for (const [kind, s] of steps) {
        if (kind === 0) runs.push(s);
        else if (left > 0) {
          const n = 1 + (s.charCodeAt(0) % left);
          runs.push(kind === 1 ? -n : n);
          left -= n;
        }
      }
      if (left > 0) runs.push(left);
      return normalize(runs);
    });
}

describe('compose', () => {
  it('apply(apply(d, a), b) === apply(d, compose(a, b))', () => {
    fc.assert(
      fc.property(
        arbDoc.chain((d) => arbRuns(d.length).chain((a) => {
          const mid = apply(d, [0, 0, ...a]);
          return arbRuns(mid.length).map((b) => ({ d, a, b, mid }));
        })),
        ({ d, a, b, mid }) => {
          const direct = apply(mid, [0, 0, ...b]);
          expect(apply(d, [0, 0, ...compose(a, b)])).toBe(direct);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('helpers', () => {
  it('normalize merges and orders runs', () => {
    expect(normalize([2, 3, 'a', 'b', -1, -2, 0, ''])).toEqual([5, 'ab', -3]);
    expect(normalize([1, -2, 'x'])).toEqual([1, 'x', -2]);
  });
  it('insertionOf detects pure inserts', () => {
    expect(insertionOf([3, 'ab', 2])).toEqual({ at: 3, text: 'ab' });
    expect(insertionOf([3, -1, 'ab'])).toBeNull();
    expect(insertionOf([3])).toBeNull();
  });
  it('makeOp rounds timing and normalizes', () => {
    const op = makeOp(10.6, -4, [1, 1, 'x']);
    expect(op).toEqual([11, 0, 2, 'x']);
    expect(runsOf(op)).toEqual([2, 'x']);
  });
});
