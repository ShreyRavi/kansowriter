/**
 * KOP v1 and letter v1 golden fixtures (R19). THESE FIXTURES ARE PERMANENT.
 *
 * Letters already sent (links, .kansoletter files) are decoded with exactly these semantics,
 * forever. Never edit, reorder or delete a case in fixtures/kop-v1-golden.json: a format change
 * needs a v2 (new prefix, new decoder), never edits here. Adding cases is fine.
 */
import { describe, expect, it } from 'vitest';
import golden from './fixtures/kop-v1-golden.json';
import { apply, isValidOp, type Op } from './kop';
import { decodeLetter, type Letter } from './letter';

const kop = golden.kop as { name: string; before: string; op: Op; after: string }[];
const letters = golden.letters as { encoded: string; expected: Letter }[];

describe('KOP v1 golden (permanent)', () => {
  it('covers emoji, surrogate pairs and combining marks', () => {
    const all = kop.map((c) => c.before + c.after).join('');
    expect(all).toMatch(/\p{Extended_Pictographic}/u);
    expect(all).toContain('‍'); // ZWJ sequence
    expect(all).toContain('́'); // combining acute
    expect(kop.length).toBeGreaterThanOrEqual(15);
  });

  it.each(kop)('$name', ({ before, op, after }) => {
    expect(isValidOp(op, before.length)).toBe(true);
    expect(apply(before, op)).toBe(after);
  });
});

describe('letter v1 golden (permanent)', () => {
  it.each(letters)('decodes $encoded', async ({ encoded, expected }) => {
    expect(await decodeLetter(encoded)).toEqual(expected);
    expect(await decodeLetter('#' + encoded)).toEqual(expected);
  });
});
