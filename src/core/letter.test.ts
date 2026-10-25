import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { apply, compose, makeOp, normalize, type Op, type Run } from './kop';
import type { Session } from './draft';
import {
  applyRuns,
  buildLetter,
  decodeLetter,
  defaultStart,
  encodeLetter,
  LETTER_CAP_BYTES,
  LetterError,
  lettersSupported,
  MAX_OPS,
  letterMeta,
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
  });

  it('property: decode(encode(l)) == l, and replay steps reach the same text as the ops', async () => {
    await fc.assert(
      fc.asyncProperty(arbLetter, async (l) => {
        expect(await decodeLetter(await encodeLetter(l))).toEqual(l);
        expect(replayStepsText(l)).toBe(replayAll(l));
      }),
      { numRuns: 200 },
    );
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
    const t = Date.now();
    await rejects(decodeLetter(enc), 'too-large');
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('more than MAX_OPS ops → too-large', async () => {
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
    const steps = replaySteps({ v: 1, baseText: 'ac', ops: [[0, 0, 1, 'bb', 1]] });
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

  it('multi-insert ops are a single step; d = 0 puts all characters at the same time', () => {
    const multi = replaySteps({ v: 1, baseText: 'ab', ops: [[0, 50, 'x', 1, 'y', 1]] });
    expect(multi).toEqual([{ at: 0, runs: ['x', 1, 'y', 1], caret: 3 }]);
    const paste = replaySteps({ v: 1, baseText: '', ops: [[7, 0, 'abc']] });
    expect(paste.map((s) => s.at)).toEqual([7, 7, 7]);
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

  it('buildLetter final mode = final text only', () => {
    expect(buildLetter('', ops, 2, 'final')).toEqual({ v: 1, baseText: 'One tw three', ops: [] });
  });

  it('letterMeta dates the first replayed op', () => {
    expect(letterMeta(sessions, ops, 5)).toEqual({ writtenAt: 20_000_000, tz: -60 });
    expect(letterMeta(sessions, ops, 4)).toEqual({ writtenAt: 10_000_050, tz: -60 });
    expect(letterMeta(sessions, ops, 0)).toEqual({ writtenAt: 1000, tz: 0 });
    expect(letterMeta([], ops, 0)).toEqual({});
  });
});
