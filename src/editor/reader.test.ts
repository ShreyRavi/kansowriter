// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { ChangeSet, Text } from '@codemirror/state';
import { apply, type Run } from '../core/kop';
import { createReaderView, runsToChanges } from './reader';
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
    const view = createReaderView(host, '# Hi\n\n![x](https://example.com/p.png)\n<img src=https://example.com/a.png>\n<iframe></iframe>\n[a link](https://example.com)', 'Letter');
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
