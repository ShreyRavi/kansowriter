import { describe, expect, it } from 'vitest';
import { apply, type Op } from './kop';
import { applyDelta, countWords, dayKey, emptyDay, resetDay, wordDelta, wordsToday } from './words';

describe('countWords', () => {
  it.each([
    ['', 0],
    ['one', 1],
    ['two words', 2],
    ["don't stop", 2],
    ['  spaced   out  ', 2],
    ['# Heading\n\n- item', 2],
    ['日本語', 3],
    ['naïve café', 2],
  ])('%j → %i', (text, n) => expect(countWords(text)).toBe(n));
});

function delta(before: string, op: Op) {
  return wordDelta(before, apply(before, op), op);
}

describe('wordDelta (document delta, R2-2)', () => {
  it.each<[string, string, Op, number]>([
    ['type a new word', 'hello', [0, 0, 5, ' world'], 1],
    ['partial word insert counts as one when complete', 'hel', [0, 0, 3, 'lo'], 0],
    ['in-word correction', 'helo', [0, 0, 3, 'l', 1], 0],
    ['space splits one word into two', 'helloworld', [0, 0, 5, ' ', 5], 1],
    ['deleting a space joins two words', 'hello world', [0, 0, 5, -1, 5], -1],
    ['delete a word', 'one two', [0, 0, 3, -4], -1],
    ['paste a paragraph', 'a', [0, 0, 1, '\nthree more words'], 3],
    ['edit inside second line only', 'first line\nsecond', [0, 0, 17, ' line'], 1],
  ])('%s', (_name, before, op, expected) => expect(delta(before, op)).toBe(expected));
});

describe('day ledger (R20)', () => {
  it('words today is the peak of the running balance', () => {
    let d = emptyDay('2026-10-23');
    d = applyDelta(d, 5); // type five
    d = applyDelta(d, -5); // delete them
    expect(wordsToday(d)).toBe(5); // typing still counts
    d = applyDelta(d, 3); // retype below peak
    expect(wordsToday(d)).toBe(5);
    d = applyDelta(d, 4); // pass the peak
    expect(wordsToday(d)).toBe(7);
  });
  it('cut then paste nets zero', () => {
    let d = applyDelta(emptyDay('k'), 10);
    d = applyDelta(d, -4);
    d = applyDelta(d, 4);
    expect(wordsToday(d)).toBe(10);
  });
  it('reset stores an offset', () => {
    let d = resetDay(applyDelta(emptyDay('k'), 10));
    expect(wordsToday(d)).toBe(0);
    d = applyDelta(d, 3);
    expect(wordsToday(d)).toBe(3);
  });
  it('dayKey uses the timezone offset at write time', () => {
    const at = Date.UTC(2026, 9, 23, 2, 0); // 02:00 UTC
    expect(dayKey(at, 0)).toBe('2026-10-23');
    expect(dayKey(at, 300)).toBe('2026-10-22'); // UTC-5 → 21:00 previous day
    expect(dayKey(at, -600)).toBe('2026-10-23'); // UTC+10 → 12:00
  });
});
