import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { history, undo, undoDepth } from '@codemirror/commands';
import { apply as applyKop } from '../core/kop';
import { writingLanguage } from './hybrid';
import { runsFromTransaction } from './recorder';
import {
  activeFormats,
  parsePrefix,
  setLineStyle,
  toggleCheckAt,
  toggleChecks,
  toggleInline,
  type InlineStyle,
  type LineStyle,
} from './format';
import { shortcutLabel } from './keys';

/** "^" is a caret; "{…}" a selection (anchor at "{", head at "}"); "}…{" a backwards one */
function make(src: string, extra: Extension = []): EditorState {
  const ranges: { anchor: number; head: number }[] = [];
  let doc = '';
  let open: number | null = null;
  let close: number | null = null;
  for (const ch of src) {
    if (ch === '^') ranges.push({ anchor: doc.length, head: doc.length });
    else if (ch === '{') {
      if (close !== null) {
        ranges.push({ anchor: doc.length, head: close });
        close = null;
      } else open = doc.length;
    } else if (ch === '}') {
      if (open !== null) {
        ranges.push({ anchor: open, head: doc.length });
        open = null;
      } else close = doc.length;
    } else doc += ch;
  }
  return EditorState.create({
    doc,
    selection: ranges.length ? EditorSelection.create(ranges.map((r) => EditorSelection.range(r.anchor, r.head))) : undefined,
    extensions: [writingLanguage, EditorState.allowMultipleSelections.of(true), extra],
  });
}

function show(state: EditorState): string {
  const doc = state.doc.toString();
  const marks: [number, string][] = [];
  for (const r of state.selection.ranges) {
    if (r.empty) marks.push([r.head, '^']);
    else if (r.anchor < r.head) marks.push([r.anchor, '{'], [r.head, '}']);
    else marks.push([r.head, '}'], [r.anchor, '{']);
  }
  marks.sort((a, b) => b[0] - a[0]);
  let out = doc;
  for (const [p, m] of marks) out = out.slice(0, p) + m + out.slice(p);
  return out;
}

const step = (s: EditorState, spec: TransactionSpec | null) => (spec ? s.update(spec).state : s);
const line = (src: string, style: LineStyle | 'normal') => show(step(make(src), setLineStyle(make(src), style)));
const inline = (src: string, style: InlineStyle) => show(step(make(src), toggleInline(make(src), style)));

describe('line styles', () => {
  it('parses prefixes', () => {
    expect(parsePrefix('# Title').kind).toBe('title');
    expect(parsePrefix('## H').kind).toBe('heading');
    expect(parsePrefix('#### H').kind).toBe('subheading');
    expect(parsePrefix('#hashtag').kind).toBe(null);
    expect(parsePrefix('- [ ] x').kind).toBe('check');
    expect(parsePrefix('* [X] x').kind).toBe('check');
    expect(parsePrefix('- x').kind).toBe('bullet');
    expect(parsePrefix('---').kind).toBe(null);
    expect(parsePrefix('*em*').kind).toBe(null);
    expect(parsePrefix('12) x')).toMatchObject({ kind: 'numbered', num: 12 });
    expect(parsePrefix('> q').kind).toBe('quote');
  });

  it('applies and removes each style on the caret line', () => {
    expect(line('Hello^', 'title')).toBe('# Hello^');
    expect(line('# Hello^', 'title')).toBe('Hello^');
    expect(line('Hel^lo', 'heading')).toBe('## Hel^lo');
    expect(line('Hello^', 'subheading')).toBe('### Hello^');
    expect(line('Hello^', 'bullet')).toBe('- Hello^');
    expect(line('- Hello^', 'bullet')).toBe('Hello^');
    expect(line('Hello^', 'check')).toBe('- [ ] Hello^');
    expect(line('- [x] Hello^', 'check')).toBe('Hello^');
    expect(line('Hello^', 'quote')).toBe('> Hello^');
    expect(line('> Hello^', 'quote')).toBe('Hello^');
    expect(line('Hello^', 'numbered')).toBe('1. Hello^');
    expect(line('1. Hello^', 'numbered')).toBe('Hello^');
  });

  it('puts a caret at the line start after the new marker', () => {
    expect(line('^Hello', 'bullet')).toBe('- ^Hello');
    expect(line('^', 'check')).toBe('- [ ] ^');
  });

  it('replaces one line style with another', () => {
    expect(line('- Hello^', 'numbered')).toBe('1. Hello^');
    expect(line('1. Hello^', 'bullet')).toBe('- Hello^');
    expect(line('- Hello^', 'check')).toBe('- [ ] Hello^');
    expect(line('# Hello^', 'heading')).toBe('## Hello^');
    expect(line('> Hello^', 'title')).toBe('# Hello^');
    expect(line('## Hello^', 'bullet')).toBe('- Hello^');
    // nesting stays when a list item becomes another kind of list item
    expect(line('  - Hello^', 'numbered')).toBe('  1. Hello^');
  });

  it('Normal clears any line style and leaves plain lines alone', () => {
    expect(line('### Hello^', 'normal')).toBe('Hello^');
    expect(line('- [ ] Hello^', 'normal')).toBe('Hello^');
    expect(step(make('Hello^'), setLineStyle(make('Hello^'), 'normal')).doc.toString()).toBe('Hello');
    expect(setLineStyle(make('Hello^'), 'normal')).toBeNull();
  });

  it('applies to every selected line, skipping blank ones', () => {
    expect(line('{one\n\ntwo\nthree}', 'bullet')).toBe('{- one\n\n- two\n- three}');
    // a selection ending at a line start doesn't take that line
    expect(line('{one\ntwo\n}three', 'quote')).toBe('{> one\n> two\n}three');
  });

  it('mixed selections get the style everywhere; all styled → removed everywhere', () => {
    expect(line('{- one\ntwo\n1. three}', 'bullet')).toBe('{- one\n- two\n- three}');
    expect(line('{- one\n- two}', 'bullet')).toBe('{one\ntwo}');
  });

  it('numbers consecutive items and renumbers the list around them', () => {
    expect(line('{a\nb\nc}', 'numbered')).toBe('{1. a\n2. b\n3. c}');
    expect(line('1. a\n2. b\nc^', 'numbered')).toBe('1. a\n2. b\n3. c^');
    expect(line('1. a\nb^\n2. c', 'numbered')).toBe('1. a\n2. b^\n3. c');
    // taking an item out splits the list: the rest starts again at 1
    expect(line('1. a\n2. b^\n3. c\n4. d', 'numbered')).toBe('1. a\nb^\n1. c\n2. d');
    // a list that starts elsewhere keeps its first number
    expect(line('5. a\nb^', 'numbered')).toBe('5. a\n6. b^');
    // nested lines don't break the run
    expect(line('1. a\n   - sub\nb^', 'numbered')).toBe('1. a\n   - sub\n2. b^');
  });

  it('works on lines holding surrogate pairs', () => {
    expect(line('😀 hi^', 'check')).toBe('- [ ] 😀 hi^');
    expect(line('- 😀^', 'numbered')).toBe('1. 😀^');
  });
});

describe('inline styles', () => {
  it('wraps a selection and keeps the inner text selected', () => {
    expect(inline('a {word} b', 'bold')).toBe('a **{word}** b');
    expect(inline('a {word} b', 'italic')).toBe('a *{word}* b');
    expect(inline('a {word} b', 'underline')).toBe('a <u>{word}</u> b');
    expect(inline('a {word} b', 'strike')).toBe('a ~~{word}~~ b');
    expect(inline('a }word{ b', 'bold')).toBe('a **}word{** b');
  });

  it('removes the style from styled text (selection inside or including the markers)', () => {
    expect(inline('a **{word}** b', 'bold')).toBe('a {word} b');
    expect(inline('a {**word**} b', 'bold')).toBe('a {word} b');
    expect(inline('a *{word}* b', 'italic')).toBe('a {word} b');
    expect(inline('a <u>{word}</u> b', 'underline')).toBe('a {word} b');
    expect(inline('a ~~{word}~~ b', 'strike')).toBe('a {word} b');
  });

  it('keeps markers off surrounding spaces and line prefixes', () => {
    expect(inline('a{ word }b', 'bold')).toBe('a{ **word** }b');
    expect(inline('{- item}', 'bold')).toBe('{- **item}**');
    expect(inline('{## Head}', 'strike')).toBe('{## ~~Head}~~');
  });

  it('wraps each line of a multi-line selection', () => {
    expect(inline('{one\n\ntwo}', 'bold')).toBe('**{one**\n\n**two}**');
    expect(inline('{**one**\n**two**}', 'bold')).toBe('{one\ntwo}');
  });

  it('mixed selections: styles the rest, merging spans it overlaps', () => {
    expect(inline('{**one**\ntwo}', 'bold')).toBe('{**one**\n**two}**');
    expect(inline('**bo{ld** text}', 'bold')).toBe('**bo{ld text}**');
  });

  it('empty selection: inserts a pair with the caret between, or toggles it off', () => {
    expect(inline('a ^b', 'bold')).toBe('a **^**b');
    expect(inline('a **^**b', 'bold')).toBe('a ^b');
    expect(inline('a ^b', 'underline')).toBe('a <u>^</u>b');
    expect(inline('a <u>^</u>b', 'underline')).toBe('a ^b');
    expect(inline('a ~~^~~b', 'strike')).toBe('a ^b');
    expect(inline('a *^*b', 'italic')).toBe('a ^b');
    // bold then italic nests; italic off again leaves the bold pair
    expect(inline('a **^**b', 'italic')).toBe('a ***^***b');
    expect(inline('a ***^***b', 'italic')).toBe('a **^**b');
    // a caret inside a styled word turns that span off
    expect(inline('a **wo^rd** b', 'bold')).toBe('a wo^rd b');
    expect(inline('a <u>wo^rd</u> b', 'underline')).toBe('a wo^rd b');
    // other styles around the caret are left alone
    expect(inline('a **wo^rd** b', 'italic')).toBe('a **wo*^*rd** b');
  });

  it('never splits a surrogate pair', () => {
    expect(inline('{😀}', 'bold')).toBe('**{😀}**');
    expect(inline('**{😀}**', 'bold')).toBe('{😀}');
    expect(inline('😀^😀', 'italic')).toBe('😀*^*😀');
  });

  it('leaves code alone when looking for underline tags', () => {
    expect(inline('`<u>{x}</u>`', 'underline')).toBe('`<u><u>{x}</u></u>`');
  });

  it('handles several carets at once', () => {
    expect(inline('a^ b^', 'bold')).toBe('a**^** b**^**');
  });
});

describe('checklist boxes', () => {
  it('a click flips its box', () => {
    const s = make('- [ ] milk\n- [x] eggs');
    const a = step(s, toggleCheckAt(s, 0));
    expect(a.doc.toString()).toBe('- [x] milk\n- [x] eggs');
    const b = step(a, toggleCheckAt(a, a.doc.line(2).from));
    expect(b.doc.toString()).toBe('- [x] milk\n- [ ] eggs');
    expect(toggleCheckAt(make('plain'), 0)).toBeNull();
  });

  it('⌘↵ checks every selected box, or unchecks when all are checked', () => {
    expect(show(step(make('{- [ ] a\n- [x] b}'), toggleChecks(make('{- [ ] a\n- [x] b}'))))).toBe('{- [x] a\n- [x] b}');
    expect(show(step(make('{- [x] a\n- [x] b}'), toggleChecks(make('{- [x] a\n- [x] b}'))))).toBe('{- [ ] a\n- [ ] b}');
    expect(toggleChecks(make('plain^'))).toBeNull();
  });
});

describe('recording and undo', () => {
  it('every command is one recorded change that KOP replays exactly', () => {
    const cases: [string, (s: EditorState) => TransactionSpec | null][] = [
      ['{a\nb\nc}', (s) => setLineStyle(s, 'numbered')],
      ['1. a\n2. b^\n3. c', (s) => setLineStyle(s, 'numbered')],
      ['x {😀 y} z', (s) => toggleInline(s, 'underline')],
      ['**bo{ld** text}', (s) => toggleInline(s, 'bold')],
      ['- [ ] a', (s) => toggleCheckAt(s, 0)],
    ];
    for (const [src, f] of cases) {
      const s = make(src);
      const tr = s.update(f(s)!);
      expect(applyKop(s.doc.toString(), [0, 0, ...runsFromTransaction(tr)])).toBe(tr.newDoc.toString());
    }
  });

  it('undo takes back one whole command, even right after typing', () => {
    let s = make('one two^', [history()]);
    const dispatch = (tr: { state: EditorState }) => (s = tr.state);
    s = s.update({ changes: { from: 7, insert: 's' }, selection: { anchor: 8 }, userEvent: 'input.type' }).state;
    s = s.update(setLineStyle(s, 'numbered')!).state;
    s = s.update({ changes: { from: s.doc.length, insert: '!' }, selection: { anchor: s.doc.length + 1 }, userEvent: 'input.type' }).state;
    s = s.update({ selection: { anchor: 3, head: 6 } }).state;
    s = s.update(toggleInline(s, 'bold')!).state;
    expect(s.doc.toString()).toBe('1. **one** twos!');
    const depth = undoDepth(s);
    undo({ state: s, dispatch });
    expect(s.doc.toString()).toBe('1. one twos!');
    expect(undoDepth(s)).toBe(depth - 1);
    undo({ state: s, dispatch });
    expect(s.doc.toString()).toBe('1. one twos');
    undo({ state: s, dispatch });
    expect(s.doc.toString()).toBe('one twos');
  });
});

describe('active state', () => {
  const at = (src: string) => activeFormats(make(src));

  it('paragraph style of the caret line', () => {
    expect(at('# T^').paragraph).toBe('title');
    expect(at('## T^').paragraph).toBe('heading');
    expect(at('### T^').paragraph).toBe('subheading');
    expect(at('T^').paragraph).toBe('normal');
    expect(at('- T^').paragraph).toBe('normal');
  });

  it('line styles: pressed when every selected line has it', () => {
    expect(at('- a^')).toMatchObject({ bullet: true, numbered: false, check: false });
    expect(at('- [ ] a^')).toMatchObject({ bullet: false, check: true });
    expect(at('3. a^').numbered).toBe(true);
    expect(at('> a^').quote).toBe(true);
    expect(at('{- a\n\n- b}').bullet).toBe(true);
    expect(at('{- a\nb}').bullet).toBe(false);
  });

  it('inline styles: caret inside, empty pair, or a fully covered selection', () => {
    expect(at('**bo^ld**').bold).toBe(true);
    expect(at('**bold**^').bold).toBe(false);
    expect(at('a **^**').bold).toBe(true);
    expect(at('*it^*')).toMatchObject({ italic: true, bold: false });
    expect(at('<u>u^</u>').underline).toBe(true);
    expect(at('~~s^~~').strike).toBe(true);
    expect(at('{**a**\n**b**}').bold).toBe(true);
    expect(at('{**a** b}').bold).toBe(false);
    expect(at('***x^***')).toMatchObject({ bold: true, italic: true });
    expect(at('`**x^**`').bold).toBe(false);
  });
});

describe('shortcut labels', () => {
  it('reads as the app writes shortcuts elsewhere', () => {
    expect(shortcutLabel('bold', true)).toBe('⌘B');
    expect(shortcutLabel('strike', false)).toBe('Ctrl ⇧X');
    expect(shortcutLabel('subheading', true)).toBe('⌘⇧J');
    expect(shortcutLabel('subheading', false)).toBe('Ctrl ⇧G');
    expect(shortcutLabel('title', true)).toBe('⌘⇧1');
  });
});
