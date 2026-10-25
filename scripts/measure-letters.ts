// Measures encoded letter sizes for realistic drafting, to tune LINK_THRESHOLD_BYTES.
// Simulates three ~300-word sessions through the real DraftWriter merge rules (per-character
// 'type' changes, word gaps, typos fixed with backspace, rewritten words, a few long pauses),
// then encodes letters from the default start (R16) in replay and final-text modes.
// Seeded RNG: the numbers are reproducible. Run: npm run measure:letters
import { DraftWriter, type Change } from '../src/storage/writer';
import { newDraft, replay } from '../src/core/draft';
import type { Op } from '../src/core/kop';
import type { AppendBatch, StorageAdapter } from '../src/core/storage';
import {
  buildLetter,
  defaultStart,
  encodeLetter,
  letterMeta,
  LETTER_CAP_BYTES,
  LINK_THRESHOLD_BYTES,
  type Letter,
} from '../src/core/letter';

// mulberry32
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261023);
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

const WORDS = (
  'the a of and to in that it was for on with as his her they at be this from had by not but what all were when ' +
  'we there can an your which their said if do will each about how up out them then she many some so these would ' +
  'other into has more two time could no make than first been its who now people my made over did down only way find ' +
  'use may water long little very after words called just where most know light morning letter window quiet street ' +
  'remember writing slowly garden kitchen evening coffee season winter summer river train station walked thought ' +
  'something everything nothing honest strange gentle careful afternoon November mother brother friend promise'
).split(' ');

/** in-memory StorageAdapter: only append is exercised by DraftWriter */
function memoryStorage(ops: Op[]): StorageAdapter {
  const append = async (b: AppendBatch) => {
    if (b.baseHead !== ops.length) return { ok: false as const, reason: 'stale' as const };
    ops.push(...b.ops);
    return { ok: true as const, head: ops.length };
  };
  return { append } as unknown as StorageAdapter;
}

async function main() {
  const T0 = Date.UTC(2026, 9, 20, 7, 30);
  const ops: Op[] = [];
  const w = new DraftWriter(
    memoryStorage(ops),
    newDraft('m', T0),
    '',
    {
      onStale: () => {
        throw new Error('stale');
      },
      onCommit: () => {},
    },
    () => -60,
  );
  let now = T0;

  const len = () => w.currentText.length;
  const typeChar = (ch: string) => {
    const n = len();
    w.push({ runs: [n, ch], at: now, kind: 'type' } satisfies Change);
  };
  const backspace = () => {
    const n = len();
    w.push({ runs: [n - 1, -1], at: now, kind: 'other' });
  };
  const typeWord = (word: string) => {
    for (const ch of word) {
      now += between(120, 250);
      typeChar(ch);
    }
  };

  for (let session = 0; session < 3; session++) {
    if (session > 0) {
      now += between(2, 20) * 3600_000; // next morning-ish: well over the 30-min gap
      w.markOpened();
    }
    let words = 0;
    const longPauses = new Set([between(3, 12), between(14, 24)]); // sentence indices
    let sentence = 0;
    while (words < 300) {
      const n = between(8, 18);
      for (let i = 0; i < n && words < 300; i++) {
        let word = pick(WORDS);
        if (i === 0) word = word[0]!.toUpperCase() + word.slice(1);
        const lead = i === 0 ? (words === 0 ? '' : ' ') : ' ';
        if (lead) {
          now += between(150, 550); // word gap
          typeChar(lead);
        }
        if (rand() < 0.05) {
          // typo: a wrong letter, noticed, backspaced
          typeWord(word.slice(0, Math.max(1, word.length >> 1)));
          now += between(120, 250);
          typeChar(pick(['q', 'x', 'z', 'j']));
          now += between(300, 700);
          backspace();
          typeWord(word.slice(Math.max(1, word.length >> 1)));
        } else typeWord(word);
        if (rand() < 0.03) {
          // rewrite: delete the whole word, think, type another
          now += between(600, 1500);
          for (let k = 0; k < word.length; k++) {
            now += between(60, 110);
            backspace();
          }
          now += between(800, 2500);
          typeWord(pick(WORDS));
        }
        words++;
      }
      now += between(150, 300);
      typeChar('.');
      sentence++;
      if (sentence % 5 === 0 && words < 300) {
        now += between(300, 800);
        typeChar('\n');
        now += between(150, 300);
        typeChar('\n');
      }
      if (longPauses.has(sentence)) now += between(5_000, 20_000);
      else now += between(400, 2000);
      await w.flush(false, now);
    }
    await w.flush(true, now);
  }
  await w.flush(true, now + 5000);

  const text = w.savedText;
  if (replay(null, ops) !== text) throw new Error('replay mismatch');
  const sessions = w.draft.sessions;
  const start = defaultStart(sessions, ops.length);

  const row = async (label: string, letter: Letter) => {
    const enc = await encodeLetter(letter);
    const json = new TextEncoder().encode(JSON.stringify(letter)).byteLength;
    const verdict =
      enc.length <= LINK_THRESHOLD_BYTES ? 'link' : enc.length <= LETTER_CAP_BYTES ? 'over link threshold (trim/file)' : 'over cap';
    console.log(
      `${label.padEnd(34)} ops ${String(letter.ops.length).padStart(5)}  json ${String(json).padStart(7)} B  encoded ${String(enc.length).padStart(6)} B  ${(enc.length / 1024).toFixed(1).padStart(5)} KB  → ${verdict}`,
    );
  };

  console.log(
    `draft: ${text.split(/\s+/).filter(Boolean).length} words, ${text.length} chars, ${ops.length} ops, sessions at ops [${sessions.map((s) => s.opIndex).join(', ')}]`,
  );
  console.log(
    `LINK_THRESHOLD_BYTES = ${LINK_THRESHOLD_BYTES} (${LINK_THRESHOLD_BYTES / 1024} KB), LETTER_CAP_BYTES = ${LETTER_CAP_BYTES}\n`,
  );
  await row(`replay from default start (op ${start})`, buildLetter('', ops, start, 'replay', letterMeta(sessions, ops, start)));
  await row('final text only', buildLetter('', ops, start, 'final', letterMeta(sessions, ops, ops.length), text));
  await row('replay whole draft (op 0)', buildLetter('', ops, 0, 'replay', letterMeta(sessions, ops, 0)));
  for (const s of sessions) {
    const end = sessions.find((x) => x.opIndex > s.opIndex)?.opIndex ?? ops.length;
    await row(`  one session alone (ops ${s.opIndex}-${end})`, buildLetter('', ops.slice(0, end), s.opIndex, 'replay'));
  }
}

void main();
