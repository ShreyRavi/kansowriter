import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { apply, compose, makeOp, normalize, type Op, type Run } from './kop';
import type { Session } from './draft';
import {
  baseTexts,
  buildLetter,
  decodeLetter,
  defaultStart,
  encodeLetter,
  LETTER_CAP_BYTES,
  LetterError,
  lettersSupported,
  LETTER_MIME,
  MAX_DECOMPRESSED_BYTES,
  MAX_OPS,
  MAX_REPLAY_STEPS,
  letterMeta,
  REPLAY_MAX_OP_MS,
  REPLAY_MAX_STEPS_PER_OP,
  REPLAY_MS_PER_CHAR,
  replaySteps,
  startPoints,
  type Letter,
  type LetterErrorKind,
} from './letter';

async function deflateRaw(s: string): Promise<Uint8Array> {
  const out = new Response(new Blob([new TextEncoder().encode(s)]).stream().pipeThrough(new CompressionStream('deflate-raw')));
  return new Uint8Array(await out.arrayBuffer());
}
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** encode an arbitrary (possibly invalid) payload the way encodeLetter would */
const raw = async (payload: unknown) => 'v1.' + b64url(await deflateRaw(JSON.stringify(payload)));

async function rejects(p: Promise<unknown>, kind: LetterErrorKind) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(LetterError);
  expect((e as LetterError).kind).toBe(kind);
}

/** Apply bare runs (no timing) to text; throws when they don't cover it (see kop.apply). */
const applyRuns = (text: string, runs: Run[]) => apply(text, [0, 0, ...runs]);
const replayAll = (l: Letter) => l.ops.reduce((t, op) => apply(t, op), l.baseText);
const replayStepsText = (l: Letter) => replaySteps(l).reduce((t, s) => applyRuns(t, s.runs), l.baseText);

// ---- generators: edit sequences built with kop helpers -------------------------------------
const PIECES = ['a', 'b', ' ', '\n', 'é', 'e\u0301', '😀', '👩‍💻', 'ñ', '中'];
const arbText = fc.array(fc.constantFrom(...PIECES), { minLength: 1, maxLength: 6 }).map((a) => a.join(''));

function arbEdit(len: number): fc.Arbitrary<Run[]> {
  return fc.tuple(fc.nat({ max: len }), fc.nat({ max: 4 }), fc.option(arbText, { nil: undefined })).map(([pos, del, ins]) => {
    const d = Math.min(del, len - pos);
    return normalize([pos, ...(ins ? [ins] : []), -d, len - pos - d]);
  });
}

const arbOps = (base: string, n: number): fc.Arbitrary<Op[]> =>
  fc
    .array(fc.tuple(fc.nat({ max: 10_000 }), fc.nat({ max: 2000 }), fc.integer({ min: 0, max: 1 }), fc.nat(), fc.nat()), { maxLength: n })
    .map((specs) => {
      // deterministic expansion from seeds so lengths line up
      const ops: Op[] = [];
      let text = base;
      for (const [dt, d, two, s1, s2] of specs) {
        const e1 = fc.sample(arbEdit(text.length), { seed: s1, numRuns: 1 })[0]!;
        let runs = e1;
        if (two) {
          const mid = applyRuns(text, e1);
          runs = compose(e1, fc.sample(arbEdit(mid.length), { seed: s2, numRuns: 1 })[0]!);
        }
        const op = makeOp(dt, d, runs);
        ops.push(op);
        text = apply(text, op);
      }
      return ops;
    });

const arbLetter: fc.Arbitrary<Letter> = fc
  .tuple(
    fc.array(fc.constantFrom(...PIECES), { maxLength: 8 }).map((a) => a.join('')),
    fc.option(fc.record({ writtenAt: fc.nat(), tz: fc.integer({ min: -720, max: 840 }) }), { nil: undefined }),
  )
  .chain(([base, meta]) =>
    arbOps(base, 25).map((ops) => {
      const l: Letter = { v: 1, baseText: base, ops };
      if (meta) l.meta = meta;
      return l;
    }),
  );

describe('letter codec', () => {
  it('is supported in this runtime', () => {
    expect(lettersSupported()).toBe(true);
  });

  it('round trips', async () => {
    const l: Letter = {
      v: 1,
      baseText: 'Dear 👩‍💻,\n',
      ops: [
        [0, 400, 12, 'café'],
        [5000, 0, 14, -2],
        [10, 0, 'e\u0301', 14],
      ],
      meta: { writtenAt: 1_761_000_000_000, tz: -60 },
    };
    const enc = await encodeLetter(l);
    expect(enc.startsWith('v1.')).toBe(true);
    expect(enc).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(await decodeLetter(enc)).toEqual(l);
    expect(await decodeLetter('#' + enc)).toEqual(l);
    expect(LETTER_MIME).toBe('application/x-kansoletter');
  });

  it('every encoded link ends in [A-Za-z0-9] and still round trips (D3)', async () => {
    await fc.assert(
      fc.asyncProperty(arbLetter, async (l) => {
        const enc = await encodeLetter(l);
        expect(enc).toMatch(/[A-Za-z0-9]$/);
        expect(await decodeLetter(enc)).toEqual(l);
      }),
      { numRuns: 400 },
    );
  });

  it('pads the letters whose bare encoding would end in - or _ (prose-sized letters, seeded)', async () => {
    // fixed-Huffman (tiny) payloads can't end in '-' or '_'; prose-sized ones do, ~4% of the time
    const words = 'the quiet letter morning window garden coffee river'.split(' ');
    let x = 7;
    const next = () => (x = (x * 48271) % 2147483647);
    let padded = 0;
    for (let i = 0; i < 300; i++) {
      const n = 20 + (next() % 400);
      const l: Letter = { v: 1, baseText: Array.from({ length: n }, () => words[next() % words.length]).join(' '), ops: [] };
      const bare = 'v1.' + b64url(await deflateRaw(JSON.stringify(l)));
      if (/[-_]$/.test(bare)) padded++;
      const enc = await encodeLetter(l);
      expect(enc).toMatch(/[A-Za-z0-9]$/);
      expect(await decodeLetter(enc)).toEqual(l);
    }
    expect(padded).toBeGreaterThan(0);
  });
});

describe('letter caps', () => {
  it('encoded payload over LETTER_CAP_BYTES → too-large', async () => {
    await rejects(decodeLetter('v1.' + 'A'.repeat(LETTER_CAP_BYTES)), 'too-large');
    // incompressible text forces the encoder over the cap too
    let x = 1;
    const noise = Array.from({ length: 400_000 }, () => String.fromCharCode(33 + ((x = (x * 48271) % 2147483647) % 90))).join('');
    await rejects(encodeLetter({ v: 1, baseText: noise, ops: [] }), 'too-large');
  });

  it('a deflate bomb stops at the decompression cap', async () => {
    const bomb = '{"v":1,"baseText":"' + '0'.repeat(3 * 1024 * 1024) + '","ops":[]}';
    const enc = 'v1.' + b64url(await deflateRaw(bomb));
    expect(enc.length).toBeLessThan(LETTER_CAP_BYTES);
    await rejects(decodeLetter(enc), 'too-large');
  }, 10_000);

  it('encodeLetter refuses a payload over MAX_DECOMPRESSED_BYTES', async () => {
    const baseText = '0'.repeat(3 * 1024 * 1024);
    expect(baseText.length).toBeGreaterThan(MAX_DECOMPRESSED_BYTES);
    await rejects(encodeLetter({ v: 1, baseText, ops: [] }), 'too-large');
  });

  it('more than MAX_OPS ops → too-large', async () => {
    expect(MAX_REPLAY_STEPS).toBeLessThanOrEqual(MAX_OPS); // so this also covers the step cap
    const ops = Array.from({ length: MAX_OPS + 1 }, () => [0, 0]);
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops })), 'too-large');
    await rejects(encodeLetter({ v: 1, baseText: '', ops: ops as Op[] }), 'too-large');
  });
});

describe('letter schema (R24)', () => {
  it('accepts and drops unknown meta keys', async () => {
    const l = await decodeLetter(
      await raw({ v: 1, baseText: 'x', ops: [], meta: { writtenAt: 5, tz: 0, signature: 'S', nested: { a: 1 } } }),
    );
    expect(l).toEqual({ v: 1, baseText: 'x', ops: [], meta: { writtenAt: 5, tz: 0 } });
    const empty = await decodeLetter(await raw({ v: 1, baseText: 'x', ops: [], meta: { future: true } }));
    expect(empty.meta).toEqual({});
  });

  it('rejects bad known meta fields and non-object meta', async () => {
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops: [], meta: { writtenAt: 'today' } })), 'damaged');
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops: [], meta: { tz: null } })), 'damaged');
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops: [], meta: [] })), 'damaged');
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops: [], meta: null })), 'damaged');
  });

  it('rejects unknown top-level keys', async () => {
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops: [], extra: 1 })), 'damaged');
    await rejects(decodeLetter('v1.' + b64url(await deflateRaw('{"v":1,"baseText":"","ops":[],"__proto__":{}}'))), 'damaged');
  });

  it('inner v other than 1 under the v1 prefix is damaged (the prefix is the version gate)', async () => {
    await rejects(decodeLetter(await raw({ v: 2, baseText: '', ops: [] })), 'damaged');
    await rejects(decodeLetter(await raw({ baseText: '', ops: [] })), 'damaged');
  });

  it('rejects wrong types', async () => {
    for (const p of [null, [], 'x', { v: 1, baseText: 3, ops: [] }, { v: 1, baseText: '', ops: {} }, { v: 1, ops: [] }]) {
      await rejects(decodeLetter(await raw(p)), 'damaged');
    }
  });

  it('rejects runs that do not cover the document', async () => {
    await rejects(decodeLetter(await raw({ v: 1, baseText: 'abc', ops: [[0, 0, 2]] })), 'damaged');
    await rejects(
      decodeLetter(
        await raw({
          v: 1,
          baseText: 'abc',
          ops: [
            [0, 0, 3, 'x'],
            [0, 0, 3],
          ],
        }),
      ),
      'damaged',
    );
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops: [[-1, 0, 'x']] })), 'damaged');
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops: [[0, 0, '']] })), 'damaged');
  });

  it('bad prefix → unsupported; garbage → damaged', async () => {
    await rejects(decodeLetter('v2.abc'), 'unsupported');
    await rejects(decodeLetter(''), 'unsupported');
    await rejects(decodeLetter('hello'), 'unsupported');
    await rejects(decodeLetter('v1.'), 'damaged');
    await rejects(decodeLetter('v1.!!!not*base64'), 'damaged');
    await rejects(decodeLetter('v1.A'), 'damaged');
    await rejects(decodeLetter('v1.' + b64url(new Uint8Array([1, 2, 3, 4, 5, 250, 251]))), 'damaged');
    await rejects(decodeLetter('v1.' + b64url(await deflateRaw('{not json'))), 'damaged');
    const good = await encodeLetter({ v: 1, baseText: 'hello there', ops: [] });
    await rejects(decodeLetter(good.slice(0, good.length - 4)), 'damaged'); // truncated
  });

  it('rejects carriage returns', async () => {
    await rejects(decodeLetter(await raw({ v: 1, baseText: 'a\r\nb', ops: [] })), 'damaged');
    await rejects(decodeLetter(await raw({ v: 1, baseText: '', ops: [[0, 0, 'a\rb']] })), 'damaged');
  });
});

describe('replay pacing (R12, R18)', () => {
  it('caps pauses over 4 s at 1.5 s, keeps shorter ones', () => {
    const steps = replaySteps({
      v: 1,
      baseText: '',
      ops: [
        [10_000, 0, 'a'],
        [3000, 0, 1, 'b'],
        [4001, 0, 2, -1],
      ],
    });
    expect(steps.map((s) => s.at)).toEqual([1500, 4500, 6000]);
    expect(steps[2]!.caret).toBe(2);
  });

  it('spreads a merged word evenly over d, one step per character', () => {
    const steps = replaySteps({
      v: 1,
      baseText: 'x',
      ops: [
        [200, 400, 1, 'Hello'],
        [100, 0, 6, ' '],
      ],
    });
    expect(steps.map((s) => s.at)).toEqual([200, 300, 400, 500, 600, 700]);
    expect(steps.map((s) => s.caret)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(steps[0]!.runs).toEqual([1, 'H']);
    expect(steps[1]!.runs).toEqual([2, 'e']);
  });

  it('inserts in the middle cover the evolving document', () => {
    const steps = replaySteps({ v: 1, baseText: 'ac', ops: [[0, 100, 1, 'bb', 1]] });
    expect(steps.map((s) => s.runs)).toEqual([
      [1, 'b', 1],
      [2, 'b', 1],
    ]);
  });

  it('never splits a surrogate pair; ZWJ sequences may be several steps', () => {
    const steps = replaySteps({ v: 1, baseText: '', ops: [[0, 100, '😀a']] });
    expect(steps.map((s) => s.runs)).toEqual([['😀'], [2, 'a']]);
    expect(steps.map((s) => s.at)).toEqual([0, 100]);
    expect(steps[0]!.caret).toBe(2);
    for (const s of replaySteps({ v: 1, baseText: '', ops: [[0, 300, '👩‍💻e\u0301']] })) {
      const ins = s.runs.find((r) => typeof r === 'string') as string;
      expect(ins.isWellFormed()).toBe(true);
    }
  });

  it('a replace emits its delete first, then the characters', () => {
    const steps = replaySteps({ v: 1, baseText: 'teh end', ops: [[0, 200, 'the', -3, 4]] });
    expect(steps.map((s) => s.runs)).toEqual([
      [-3, 4],
      ['t', 4],
      [1, 'h', 4],
      [2, 'e', 4],
    ]);
    expect(steps.map((s) => s.at)).toEqual([0, 0, 100, 200]);
    expect(steps[0]!.caret).toBe(0);
  });

  it('multi-insert ops are a single step; d = 0 or one character is one step for the whole op', () => {
    const multi = replaySteps({ v: 1, baseText: 'ab', ops: [[0, 50, 'x', 1, 'y', 1]] });
    expect(multi).toEqual([{ at: 0, runs: ['x', 1, 'y', 1], caret: 3 }]);
    const paste = replaySteps({ v: 1, baseText: '', ops: [[7, 0, 'abc']] });
    expect(paste).toEqual([{ at: 7, runs: ['abc'], caret: 3 }]);
    const replace = replaySteps({ v: 1, baseText: 'teh end', ops: [[0, 0, 'the', -3, 4]] });
    expect(replace).toEqual([{ at: 0, runs: ['the', -3, 4], caret: 3 }]);
    const one = replaySteps({ v: 1, baseText: 'ab', ops: [[0, 300, 1, '😀', -1]] });
    expect(one).toEqual([{ at: 0, runs: [1, '😀', -1], caret: 3 }]);
  });

  it('long inserts land in at most REPLAY_MAX_STEPS_PER_OP chunks, spread over d, pairs intact', () => {
    const text = '😀x'.repeat(1000);
    const l: Letter = { v: 1, baseText: 'ab', ops: [[0, 10_000, 1, text, 1]] };
    const steps = replaySteps(l);
    expect(steps.length).toBe(REPLAY_MAX_STEPS_PER_OP);
    expect(steps[0]!.at).toBe(0);
    expect(steps[steps.length - 1]!.at).toBe(10_000);
    for (const s of steps) expect((s.runs.find((r) => typeof r === 'string') as string).isWellFormed()).toBe(true);
    expect(replayStepsText(l)).toBe(replayAll(l));
    expect(steps[steps.length - 1]!.caret).toBe(1 + text.length);
  });

  it('DoS: a 1.9M-character single-op letter decodes and replays in a few hundred steps', async () => {
    const l: Letter = { v: 1, baseText: '', ops: [[0, 1_000_000_000, 'ab'.repeat(950_000)]] };
    const decoded = await decodeLetter(await encodeLetter(l));
    const t = performance.now();
    const steps = replaySteps(decoded);
    const ms = performance.now() - t;
    expect(steps.length).toBeLessThanOrEqual(REPLAY_MAX_STEPS_PER_OP);
    expect(ms).toBeLessThan(200);
    expect(replayStepsText(decoded)).toBe(replayAll(decoded));
    // d is capped per op
    expect(steps[steps.length - 1]!.at).toBe(REPLAY_MAX_OP_MS);
  }, 20_000);

  it('total steps stay within MAX_REPLAY_STEPS: near the cap, ops stop being split', () => {
    const n = MAX_REPLAY_STEPS - 10;
    const ops: Op[] = [[0, 1000, 'hello world']];
    for (let i = 1; i < n; i++) ops.push([0, 0, 11]);
    const l: Letter = { v: 1, baseText: '', ops };
    const steps = replaySteps(l);
    expect(steps.length).toBeLessThanOrEqual(MAX_REPLAY_STEPS);
    expect(steps.length).toBe(n + 10); // the first op got exactly the 10 + 1 steps left over
    expect(replayStepsText(l)).toBe('hello world');
  });

  it("caps an op's d: REPLAY_MS_PER_CHAR per character typed, REPLAY_MAX_OP_MS per op", () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const steps = replaySteps({
      v: 1,
      baseText: '',
      ops: [
        [0, huge, 'ab'], // 2 chars → 2 s
        [0, huge, 2, 'c'], // one step; the op still lasts 1 s
        [0, huge, 3, 'x'.repeat(500)], // 500 chars → capped at 60 s
        [0, huge, 503], // retains only: lasts 0
        [0, 5, 503, 'z'],
      ],
    });
    const at = steps.map((s) => s.at);
    expect(at.slice(0, 3)).toEqual([0, 2 * REPLAY_MS_PER_CHAR, 2 * REPLAY_MS_PER_CHAR]);
    expect(at[3]).toBe(3 * REPLAY_MS_PER_CHAR); // after 'ab' (2 s) and 'c' (1 s)
    expect(at[at.length - 1]).toBe(3 * REPLAY_MS_PER_CHAR + REPLAY_MAX_OP_MS);
    for (const t of at) expect(Number.isSafeInteger(t)).toBe(true);
  });
});

describe('letter range', () => {
  const sessions: Session[] = [
    { opIndex: 0, at: 1000, tzOffset: 0 },
    { opIndex: 3, at: 10_000_000, tzOffset: -60 },
    { opIndex: 5, at: 20_000_000, tzOffset: -60 },
  ];
  const ops: Op[] = [
    [0, 200, 'One'],
    [100, 0, 3, ' '],
    [100, 300, 4, 'two'],
    [0, 0, 7, '.'],
    [50, 0, 6, -2],
    [0, 400, 6, ' three'],
  ];

  it('defaultStart = last session with ops; 0 without sessions', () => {
    expect(defaultStart(sessions, 6)).toBe(5);
    expect(defaultStart(sessions, 5)).toBe(3); // session at 5 has no ops yet
    expect(defaultStart([], 6)).toBe(0);
    expect(defaultStart(sessions, 0)).toBe(0);
  });

  it('startPoints are sorted, unique and include 0', () => {
    expect(startPoints(sessions, 6)).toEqual([0, 3, 5]);
    expect(startPoints(sessions, 4)).toEqual([0, 3]);
    expect(startPoints([sessions[2]!, sessions[1]!], 6)).toEqual([0, 3, 5]);
    expect(startPoints([], 0)).toEqual([0]);
  });

  it('buildLetter replay mode starts mid-history with the right baseText', () => {
    const l = buildLetter('', ops, 3, 'replay');
    expect(l).toEqual({ v: 1, baseText: 'One two', ops: ops.slice(3) });
    expect(replayAll(l)).toBe('One tw three');
    expect(buildLetter('', ops, 0, 'replay').baseText).toBe('');
    expect(buildLetter('Base:', [[0, 0, 5, '!']], 0, 'replay').baseText).toBe('Base:');
  });

  it('buildLetter clamps start and carries meta', () => {
    expect(buildLetter('', ops, -4, 'replay').ops).toHaveLength(6);
    expect(buildLetter('', ops, 99, 'replay')).toEqual({ v: 1, baseText: 'One tw three', ops: [] });
    expect(buildLetter('', ops, 2, 'replay', { tz: 0 }).meta).toEqual({ tz: 0 });
  });

  it('buildLetter final mode = final text only; finalText skips the replay', () => {
    expect(buildLetter('', ops, 2, 'final')).toEqual({ v: 1, baseText: 'One tw three', ops: [] });
    expect(buildLetter('', ops, 2, 'final', { tz: 0 }, 'given')).toEqual({ v: 1, baseText: 'given', ops: [], meta: { tz: 0 } });
    // finalText is for 'final' only
    expect(buildLetter('', ops, 3, 'replay', undefined, 'given').baseText).toBe('One two');
  });

  it('buildLetter throws on an op that does not apply (as string replay did)', () => {
    expect(() => buildLetter('ab', [[0, 0, 5]], 1, 'replay')).toThrow();
    expect(() => buildLetter('ab', [[0, 0, -5]], 1, 'replay')).toThrow();
  });

  it('buildLetter matches string replay (property)', () => {
    fc.assert(
      fc.property(arbLetter, fc.nat({ max: 30 }), (l, start) => {
        const from = Math.min(start, l.ops.length);
        const expected = l.ops.slice(0, from).reduce((t, op) => apply(t, op), l.baseText);
        expect(buildLetter(l.baseText, l.ops, start, 'replay').baseText).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });

  it('baseTexts gives the text at every start point in one pass, as ropes buildLetter takes', () => {
    const m = baseTexts('', ops, [5, 0, 3, 99, -1, 3]);
    expect([...m.keys()].sort((a, b) => a - b)).toEqual([-1, 0, 3, 5, 99]);
    const at = (p: number) => m.get(p)!.toString();
    expect(at(0)).toBe('');
    expect(at(-1)).toBe('');
    expect(at(3)).toBe('One two');
    expect(at(5)).toBe(buildLetter('', ops, 5, 'replay').baseText);
    expect(at(99)).toBe('One tw three');
    expect(baseTexts('x', [], [0]).get(0)!.toString()).toBe('x');
    // a rope base gives the same letter as the string it stands for
    expect(buildLetter(m.get(3)!, ops.slice(3), 0, 'replay')).toEqual(buildLetter('', ops, 3, 'replay'));
    expect(buildLetter(m.get(3)!, ops.slice(3), 1, 'replay')).toEqual(buildLetter('', ops, 4, 'replay'));
  });

  it('letterMeta dates the first replayed op', () => {
    expect(letterMeta(sessions, ops, 5)).toEqual({ writtenAt: 20_000_000, tz: -60 });
    expect(letterMeta(sessions, ops, 4)).toEqual({ writtenAt: 10_000_050, tz: -60 });
    expect(letterMeta(sessions, ops, 0)).toEqual({ writtenAt: 1000, tz: 0 });
    expect(letterMeta([], ops, 0)).toEqual({});
    expect(letterMeta(sessions, [], 0)).toEqual({});
  });

  it("letterMeta 'final' branch: start at or past the end dates the last op's end", () => {
    // last op [0, 400, ...] starts at 20_000_000 and lasts 400 ms
    expect(letterMeta(sessions, ops, ops.length)).toEqual({ writtenAt: 20_000_400, tz: -60 });
    expect(letterMeta(sessions, ops, ops.length + 50)).toEqual({ writtenAt: 20_000_400, tz: -60 });
    expect(letterMeta(sessions, ops, Infinity)).toEqual({ writtenAt: 1000, tz: 0 }); // non-finite → 0
  });

  it('letterMeta omits writtenAt when no session starts at or before the op (never 1970)', () => {
    const late: Session[] = [{ opIndex: 3, at: 10_000_000, tzOffset: -60 }];
    const m = letterMeta(late, ops, 1);
    expect(m.writtenAt).toBeUndefined();
    expect(m).toEqual({ tz: -60 });
    expect(letterMeta(late, ops, 3)).toEqual({ writtenAt: 10_000_000, tz: -60 });
    expect(letterMeta(late, ops, ops.length).writtenAt).toBe(10_000_000 + 50 + 400);
    // only a session after the whole log: nothing dates even the final text
    expect(letterMeta([{ opIndex: 9, at: 5, tzOffset: 0 }], ops, ops.length)).toEqual({ tz: 0 });
  });
});
