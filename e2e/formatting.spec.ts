// The formatting toolbar and shortcuts: every control writes plain Markdown through a normal,
// recorded edit (so it saves and replays in letters). Desktop: the toolbar sits in the header and
// fades with the chrome. Phones: a row docked above the on-screen keyboard while the text has focus.
import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { decodeTestLetter, encodeTestLetter, mod, openDrafts, readerPath, runCommand, settle, startWriting, write } from './helpers';

const isMobile = (page: Page) => page.viewportSize()!.width < 640;

/** the editor's whole text, straight from the view (CodeMirror renders only lines near the viewport) */
const shownText = (page: Page) =>
  page.evaluate(() => {
    type Node = { root?: { view?: View }; rootView?: { view?: View }; view?: View };
    type View = { state: { doc: { toString(): string } } };
    const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: Node; cmView?: Node }) | null;
    const tile = content?.cmTile ?? content?.cmView;
    return (tile?.root?.view ?? tile?.rootView?.view ?? tile?.view)?.state.doc.toString() ?? null;
  });

/** The toolbar as a person reaches it: on desktop the header fades while typing, so move the pointer first. */
async function toolbar(page: Page): Promise<Locator> {
  if (!isMobile(page)) {
    await page.mouse.move(600, 500);
    await page.mouse.move(640, 540);
  }
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(bar).toBeVisible();
  return bar;
}

/** press a toolbar button: a tap on phones, a click elsewhere */
async function press(page: Page, button: Locator) {
  if (isMobile(page)) await button.tap();
  else await button.click();
}

async function pickStyle(page: Page, name: string) {
  const bar = await toolbar(page);
  await press(page, bar.getByRole('button', { name: /^Paragraph style/ }));
  await press(page, page.getByRole('menuitemradio', { name, exact: true }));
  await expect(page.getByRole('menu', { name: 'Paragraph style' })).toHaveCount(0);
}

async function selectBack(page: Page, n: number) {
  for (let i = 0; i < n; i++) await page.keyboard.press('Shift+ArrowLeft');
}

test.describe('formatting toolbar', () => {
  test('buttons write Markdown, show what the caret is in, and never move the page or the focus', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'Hello world');
    await selectBack(page, 5);
    const bar = await toolbar(page);
    const bold = bar.getByRole('button', { name: 'Bold' });
    const scrolled = await page.evaluate(() => window.scrollY);
    await press(page, bold);
    expect(await shownText(page)).toBe('Hello **world**');
    await expect(bold).toHaveAttribute('aria-pressed', 'true');
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

    await press(page, bar.getByRole('button', { name: 'Italic' }));
    expect(await shownText(page)).toBe('Hello **_world_**'); // underscores: a "*" never glues onto the "**"
    await press(page, bar.getByRole('button', { name: 'Italic' }));
    await press(page, bar.getByRole('button', { name: 'Underline' }));
    expect(await shownText(page)).toBe('Hello **<u>world</u>**');
    await press(page, bar.getByRole('button', { name: 'Strikethrough' }));
    expect(await shownText(page)).toBe('Hello **<u>~~world~~</u>**');
    await press(page, bar.getByRole('button', { name: 'Strikethrough' }));
    await press(page, bar.getByRole('button', { name: 'Underline' }));
    await press(page, bold);
    expect(await shownText(page)).toBe('Hello world');
    await expect(bold).toHaveAttribute('aria-pressed', 'false');

    // line styles replace each other and toggle off
    const bullet = bar.getByRole('button', { name: 'Bulleted list' });
    await press(page, bullet);
    expect(await shownText(page)).toBe('- Hello world');
    await expect(bullet).toHaveAttribute('aria-pressed', 'true');
    await press(page, bar.getByRole('button', { name: 'Numbered list' }));
    expect(await shownText(page)).toBe('1. Hello world');
    await press(page, bar.getByRole('button', { name: 'Checklist' }));
    expect(await shownText(page)).toBe('- [ ] Hello world');
    // a quote holds the list item rather than replacing it
    await press(page, bar.getByRole('button', { name: 'Quote' }));
    expect(await shownText(page)).toBe('> - [ ] Hello world');
    await press(page, bar.getByRole('button', { name: 'Quote' }));
    expect(await shownText(page)).toBe('- [ ] Hello world');
    await press(page, bar.getByRole('button', { name: 'Checklist' }));
    expect(await shownText(page)).toBe('Hello world');

    // the style menu shows the caret line's style
    await pickStyle(page, 'Title');
    expect(await shownText(page)).toBe('# Hello world');
    await expect(bar.getByRole('button', { name: /^Paragraph style/ })).toHaveText(/Title/);
    await pickStyle(page, 'Subheading');
    expect(await shownText(page)).toBe('### Hello world');
    await pickStyle(page, 'Normal');
    expect(await shownText(page)).toBe('Hello world');
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);

    // an empty caret gets a pair to type into; the result is saved like any typing
    await page.keyboard.press('End');
    await page.keyboard.type(' ');
    await press(page, bold);
    await page.keyboard.type('again');
    expect(await shownText(page)).toBe('Hello world **again**');
    await settle(page);
  });

  test('numbered lists number every selected line and keep counting', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, 'one\ntwo\nthree');
    // select all through the editor itself: phones have no hardware ⌘A, and emulated iPhone WebKit on a Linux host ignores Meta+A
    await page.evaluate(() => {
      type View = { state: { doc: { length: number } }; dispatch(spec: { selection: { anchor: number; head: number } }): void };
      type Tile = { root?: { view?: View }; rootView?: { view?: View }; view?: View };
      const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: Tile; cmView?: Tile }) | null;
      const tile = content?.cmTile ?? content?.cmView;
      const view = tile?.root?.view ?? tile?.rootView?.view ?? tile?.view;
      view!.dispatch({ selection: { anchor: 0, head: view!.state.doc.length } });
    });
    const bar = await toolbar(page);
    await press(page, bar.getByRole('button', { name: 'Numbered list' }));
    expect(await shownText(page)).toBe('1. one\n2. two\n3. three');
    await expect(bar.getByRole('button', { name: 'Numbered list' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('shortcuts write the same Markdown, as in Notes (⌘⇧1 for Title)', async ({ page }) => {
    test.skip(isMobile(page), 'phones have no hardware keyboard for shortcuts; the dock covers them');
    const editor = await startWriting(page);
    const m = await mod(page);
    const mac = m === 'Meta';
    await write(page, editor, 'Hello world');
    await selectBack(page, 5);
    const steps: [string, string][] = [
      [`${m}+b`, 'Hello **world**'],
      [`${m}+b`, 'Hello world'],
      [`${m}+i`, 'Hello *world*'],
      [`${m}+i`, 'Hello world'],
      [`${m}+u`, 'Hello <u>world</u>'],
      [`${m}+u`, 'Hello world'],
      [`${m}+Shift+x`, 'Hello ~~world~~'],
      [`${m}+Shift+x`, 'Hello world'],
      [`${m}+Shift+Digit8`, '- Hello world'],
      [`${m}+Shift+Digit7`, '1. Hello world'],
      [`${m}+Shift+Digit9`, '- [ ] Hello world'],
      [`${m}+Enter`, '- [x] Hello world'],
      [`${m}+Enter`, '- [ ] Hello world'],
      [`${m}+Shift+Digit9`, 'Hello world'],
      [`${m}+'`, '> Hello world'],
      [`${m}+Shift+Digit1`, '> # Hello world'],
      [`${m}+Shift+h`, '> ## Hello world'],
      [mac ? `${m}+Shift+j` : `${m}+Shift+g`, '> ### Hello world'],
      [mac ? `${m}+Shift+j` : `${m}+Shift+g`, '> Hello world'],
      [`${m}+'`, 'Hello world'],
      [`${m}+Shift+Digit1`, '# Hello world'],
      [`${m}+Shift+b`, 'Hello world'],
    ];
    for (const [key, text] of steps) {
      await page.keyboard.press(key);
      expect(await shownText(page), key).toBe(text);
    }
    // ⌘⇧T stays the typewriter toggle: it never touches the text
    await page.keyboard.press(`${m}+Shift+t`);
    expect(await shownText(page)).toBe('Hello world');
    // one undo per command
    await page.keyboard.press(`${m}+b`);
    expect(await shownText(page)).toBe('Hello **world**');
    await page.keyboard.press(`${m}+z`);
    expect(await shownText(page)).toBe('Hello world');
  });

  test('a checklist box toggles with a click, persists after reload, and replays in a letter', async ({ page, browserName }) => {
    test.slow(); // a letter round trip
    const editor = await startWriting(page);
    await write(page, editor, 'Shopping\n\n- [ ] milk\n\nThat is all.');
    const box = page.getByRole('checkbox', { name: 'milk' });
    await expect(box).toHaveAttribute('aria-checked', 'false');
    const scrolled = await page.evaluate(() => window.scrollY);
    if (isMobile(page)) await box.tap();
    else await box.click();
    await expect(box).toHaveAttribute('aria-checked', 'true');
    // (mobile WebKit may fold the typed blank lines: only the box's line matters here)
    const typed = (await shownText(page))!;
    expect(typed).toContain('- [x] milk');
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
    await settle(page);
    await page.reload();
    await expect(page.getByRole('checkbox', { name: 'milk' })).toHaveAttribute('aria-checked', 'true');
    expect(await shownText(page)).toBe(typed);

    // Send as letter: the box's flip is one of the letter's ops
    if (isMobile(page)) {
      await page.touchscreen.tap(5, 400);
      await page.getByRole('button', { name: 'Open commands' }).click();
      await runCommand(page, 'send', /Send as letter/);
    } else {
      await page.getByRole('textbox', { name: 'Draft' }).click();
      await page.keyboard.press(`${await mod(page)}+Shift+L`);
    }
    const dialog = page.getByRole('dialog', { name: 'Send as letter' });
    await expect(dialog.getByText(/Fits in a link · [\d.]+ KB/)).toBeVisible();
    let link: string;
    if (browserName === 'chromium') {
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await dialog.getByRole('button', { name: 'Copy link' }).click();
      await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
      link = await page.evaluate(() => navigator.clipboard.readText());
    } else {
      await page.evaluate(() => {
        navigator.clipboard.writeText = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
      });
      await dialog.getByRole('button', { name: 'Copy link' }).click();
      link = await dialog.getByRole('textbox', { name: 'Letter link' }).inputValue();
    }
    const letter = await decodeTestLetter(link);
    expect(letter.ops.some((op) => op.slice(2).includes('x'))).toBe(true);

    const reader = await page.context().newPage();
    await reader.goto(readerPath(link));
    const text = reader.getByRole('textbox', { name: 'Letter' });
    await expect(text).toContainText('That is all.', { timeout: 30_000 });
    await expect(reader.getByRole('link', { name: 'Written with Kansowriter' })).toBeAttached({ timeout: 30_000 });
    const shown = reader.getByRole('checkbox', { name: 'milk' });
    await expect(shown).toHaveAttribute('aria-checked', 'true');
    // display-only in the reader
    await expect(shown).toHaveAttribute('aria-readonly', 'true');
    await shown.click({ force: true });
    await expect(shown).toHaveAttribute('aria-checked', 'true');
  });

  test('underline and strikethrough render off the caret line, syntax hidden; other HTML stays text', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, '<u>under</u> and ~~gone~~ and <b>raw</b>\n\nnext line');
    const line = page.locator('.cm-line').first();
    await expect(line).toHaveText('under and gone and <b>raw</b>');
    await expect(line.locator('.cm-u')).toHaveText('under');
    await expect(line.locator('.cm-u')).toHaveCSS('text-decoration-line', 'underline');
    await expect(line.locator('.cm-strike')).toHaveText('gone');
    await expect(line.locator('.cm-strike')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.locator('.cm-content b, .cm-content u, .cm-content s')).toHaveCount(0);
  });

  test('the header toolbar fades with the chrome, but never while it has focus', async ({ page }) => {
    test.skip(isMobile(page), 'phones carry the toolbar in the keyboard dock, not the fading header');
    const editor = await startWriting(page);
    await write(page, editor, 'Hello world');
    const header = page.locator('.header');
    await expect(header).toHaveClass(/hidden/, { timeout: 5000 });
    await expect(header.getByRole('toolbar', { name: 'Formatting' })).toBeAttached();
    await page.mouse.move(600, 500);
    await page.mouse.move(640, 540);
    await expect(header).not.toHaveClass(/hidden/);

    // keyboard: into the toolbar, and it stays while focus is there
    await selectBack(page, 5);
    await page.getByRole('button', { name: /^Paragraph style/ }).focus();
    await page.waitForTimeout(4000);
    await expect(header).not.toHaveClass(/hidden/);
    // ←/→ move along the toolbar; Enter applies and hands focus back to the text
    await page.keyboard.press('End');
    await expect(page.getByRole('button', { name: 'Strikethrough' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('button', { name: 'Bold' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await shownText(page)).toBe('Hello **world**');
    await expect(editor).toBeFocused();

    // the style menu by keyboard: opens on the current style, arrows, Enter, back to the text
    await page.getByRole('button', { name: /^Paragraph style/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('menuitemradio', { name: 'Normal' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('menuitemradio', { name: 'Subheading' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await shownText(page)).toBe('### Hello **world**');
    await expect(editor).toBeFocused();
    // Esc closes the menu and returns to its button
    await page.getByRole('button', { name: /^Paragraph style/ }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Paragraph style/ })).toBeFocused();
  });

  test('a read-only tab gets a disabled toolbar and its shortcuts change nothing', async ({ page }) => {
    test.skip(isMobile(page), 'the phone dock shows only while the text has focus, which a read-only view never takes');
    const editor = await startWriting(page);
    await write(page, editor, 'Hello world');
    await settle(page);
    const second = await page.context().newPage();
    await second.goto('/');
    await expect(second.getByText('Open in another tab.')).toBeVisible();
    const bar = second.getByRole('toolbar', { name: 'Formatting' });
    await expect(bar.getByRole('button', { name: 'Bold' })).toBeDisabled();
    await expect(bar.getByRole('button', { name: /^Paragraph style/ })).toBeDisabled();
    await second.getByRole('textbox', { name: 'Draft' }).click();
    await second.keyboard.press(`${await mod(second)}+b`);
    expect(await shownText(second)).toBe('Hello world');
  });

  test('phones: a formatting row docks above the keyboard while writing, and hides when the text loses focus', async ({ page }) => {
    test.skip(!isMobile(page), 'phone layout only');
    const editor = await startWriting(page);
    await write(page, editor, 'Hello world');
    const dock = page.locator('.format-dock');
    await expect(dock).toBeVisible();
    await expect(page.locator('.header').getByRole('toolbar')).toHaveCount(0);
    // the dock sits on the visual viewport's bottom edge: an on-screen keyboard taking 300px lifts it
    // (Playwright can't open a real keyboard: the visual viewport is shrunk the way one does)
    await page.evaluate(() => {
      const vv = window.visualViewport!;
      const h = window.innerHeight - 300;
      Object.defineProperty(vv, 'height', { get: () => h, configurable: true });
      vv.dispatchEvent(new Event('resize'));
    });
    await expect
      .poll(async () => {
        const box = (await dock.boundingBox())!;
        return Math.round(box.y + box.height);
      })
      .toBe(await page.evaluate(() => Math.round(window.innerHeight - 300)));
    // every control is a full 44px target; the row scrolls sideways, never the page
    for (const b of await dock.getByRole('button').all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // the row's far edge fades while there is more to scroll to, the near edge once scrolled
    const row = dock.getByRole('toolbar');
    const scrollable = await row.evaluate((el) => el.scrollWidth > el.clientWidth);
    if (scrollable) {
      await expect(row).toHaveClass(/fade-right/);
      await row.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
      await expect(row).toHaveClass(/fade-left/);
      await expect(row).not.toHaveClass(/fade-right/);
      await row.evaluate((el) => el.scrollTo({ left: 0 }));
    }
    await press(page, dock.getByRole('button', { name: 'Checklist' }));
    expect(await shownText(page)).toBe('- [ ] Hello world');
    await expect(editor).toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(dock).toHaveCount(0);
  });

  test('header and toolbar buttons show their name and shortcut on hover and keyboard focus', async ({ page }) => {
    test.skip(isMobile(page), 'touch screens get no tooltips (no hover); the buttons keep their aria-labels');
    const editor = await startWriting(page);
    await write(page, editor, 'Hello');
    const m = (await mod(page)) === 'Meta' ? '⌘' : 'Ctrl ';
    const tipOpacity = (l: Locator) => l.evaluate((el) => getComputedStyle(el, '::after').opacity);
    const cases: [Locator, string][] = [
      [page.getByRole('button', { name: 'Open drafts' }), 'Drafts'],
      [page.getByRole('button', { name: /^Turn (on|off) focus mode$/ }), `Focus mode: (on|off) ${m}⇧P`],
      [page.getByRole('button', { name: /^Switch to (night|paper) theme$/ }), `theme ${m}⇧N`],
      [page.getByRole('button', { name: 'Send as letter' }), `Send as letter ${m}⇧L`],
      [page.getByRole('button', { name: /^Open command palette/ }), `Command palette ${m}K`],
      [page.getByRole('button', { name: 'Bold' }), `Bold ${m}B`],
      [page.getByRole('button', { name: 'Checklist' }), `Checklist ${m}⇧9`],
    ];
    await toolbar(page);
    for (const [button, label] of cases) {
      await expect(button).toHaveAttribute('data-tip', new RegExp(label.replace(/[⇧]/g, '\\$&')));
      expect(await tipOpacity(button)).toBe('0');
      await button.hover();
      // a short delay first, so sweeping across the bar never flashes them
      await expect.poll(() => tipOpacity(button)).toBe('1');
    }
    // the tip never replaces the screen-reader name, and there is no native title tooltip
    await expect(page.locator('.header [title]')).toHaveCount(0);
    // keyboard focus shows it too
    await page.mouse.move(5, 700);
    const italic = page.getByRole('button', { name: 'Italic' });
    await page.getByRole('button', { name: 'Bold' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(italic).toBeFocused();
    await expect.poll(() => tipOpacity(italic)).toBe('1');
  });

  test('a second press ends the style for what is typed next (Notes): buttons and shortcuts', async ({ page }) => {
    const editor = await startWriting(page);
    const bar = await toolbar(page);
    await write(page, editor, 'I am ');
    await press(page, bar.getByRole('button', { name: 'Bold' }));
    await page.keyboard.type('loud');
    await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    await press(page, bar.getByRole('button', { name: 'Bold' }));
    await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type(' now');
    expect(await shownText(page)).toBe('I am **loud** now');
    if (isMobile(page)) return; // no hardware keyboard for the shortcut half
    const m = await mod(page);
    const cases: [string, string, string][] = [
      ['i', '*', '*'],
      ['u', '<u>', '</u>'],
      ['Shift+x', '~~', '~~'],
    ];
    for (const [k, o, c] of cases) {
      await page.keyboard.type(' and ');
      await page.keyboard.press(`${m}+${k}`);
      await page.keyboard.type('this');
      await page.keyboard.press(`${m}+${k}`);
      await page.keyboard.type('.');
      expect(await shownText(page)).toMatch(new RegExp(`and ${o.replace(/[*~]/g, '\\$&')}this${c.replace(/[*~]/g, '\\$&')}\\.$`));
    }
  });

  test('Enter continues lists, Enter on an empty item ends them, and numbered lists renumber', async ({ page }) => {
    test.skip(
      isMobile(page),
      'phone emulation sends Enter as inserted text (e2e/helpers.ts write), not the Enter key the list commands take',
    );
    const editor = await startWriting(page);
    const m = await mod(page);
    await page.keyboard.press(`${m}+Shift+Digit8`);
    await editor.pressSequentially('one');
    await page.keyboard.press('Enter');
    await editor.pressSequentially('two');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter'); // an empty item ends the list
    await editor.pressSequentially('after');
    expect(await shownText(page)).toBe('- one\n- two\nafter');
    await page.keyboard.press('Enter');
    await page.keyboard.press(`${m}+Shift+Digit7`);
    await editor.pressSequentially('a');
    for (const t of ['b', 'c']) {
      await page.keyboard.press('Enter');
      await editor.pressSequentially(t);
    }
    expect(await shownText(page)).toBe('- one\n- two\nafter\n1. a\n2. b\n3. c');
    // delete the line "2. b": the list renumbers
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+End');
    await page.keyboard.press('Backspace');
    expect(await shownText(page)).toBe('- one\n- two\nafter\n1. a\n2. c');
    // Backspace right after a marker removes it
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Home');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Backspace');
    expect(await shownText(page)).toBe('- one\n- two\nafter\n1. a\nc');
    await settle(page);
  });

  test('the style menu: radio picks, Esc closes a pointer-opened menu, ✓ stays out of the name, resize closes it', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const editor = await startWriting(page);
    await write(page, editor, 'Head');
    await pickStyle(page, 'Heading');
    expect(await shownText(page)).toBe('## Head');
    // picking the current style changes nothing
    await pickStyle(page, 'Heading');
    expect(await shownText(page)).toBe('## Head');
    const bar = await toolbar(page);
    await press(page, bar.getByRole('button', { name: /^Paragraph style/ }));
    // the checkmark is decoration: the accessible name is just the style
    await expect(page.getByRole('menuitemradio', { name: 'Heading', exact: true })).toHaveAttribute('aria-checked', 'true');
    if (!isMobile(page)) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0);
      await expect(editor).toBeFocused();
      await press(page, bar.getByRole('button', { name: /^Paragraph style/ }));
    }
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: size.width - 20, height: size.height });
    await expect(page.getByRole('menu')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('every icon- or symbol-only button on the main screens has a tooltip that shows on hover', async ({ page }) => {
    test.skip(isMobile(page), 'touch screens get no tooltips (no hover)');
    test.slow(); // five screens
    /** visible buttons named only by aria-label or showing no word: each needs a data-tip */
    const check = async (scope: string) => {
      const missing = await page.evaluate((scope) => {
        const root = document.querySelector(scope);
        if (!root) return [`no ${scope}`];
        return [...root.querySelectorAll('button')]
          .filter((b) => {
            const r = b.getBoundingClientRect();
            if (!r.width || !r.height || getComputedStyle(b).visibility === 'hidden') return false;
            return b.hasAttribute('aria-label') || !/[\p{L}\p{N}]{2,}/u.test(b.innerText);
          })
          .filter((b) => !b.dataset.tip)
          .map((b) => b.getAttribute('aria-label') ?? b.outerHTML.slice(0, 80));
      }, scope);
      expect(missing, `buttons without a tooltip in ${scope}`).toEqual([]);
      const tipped = page.locator(`${scope} button[data-tip]`);
      for (const b of await tipped.all()) {
        if (!(await b.isVisible())) continue;
        await b.hover();
        await expect
          .poll(() => b.evaluate((el) => getComputedStyle(el, '::after').opacity), { message: (await b.getAttribute('data-tip')) ?? '' })
          .toBe('1');
      }
    };
    const editor = await startWriting(page);
    await write(page, editor, 'Hello');
    await toolbar(page);
    await check('.shell');
    await openDrafts(page);
    await page.getByRole('searchbox', { name: 'Search drafts' }).fill('x');
    await check('.sidebar');
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).toHaveCount(0);
    await page.keyboard.press(`${await mod(page)}+k`);
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
    await check('.palette');
    await page.keyboard.press('Escape');
    await editor.click();
    await page.keyboard.press(`${await mod(page)}+Shift+L`);
    await expect(page.getByRole('dialog', { name: 'Send as letter' })).toBeVisible();
    await check('.send-wrap');
    await page.keyboard.press('Escape');
    const letter = await encodeTestLetter({ v: 1, baseText: '', ops: [[0, 30_000, 'One line.']] });
    await page.goto(`/l#${letter}`);
    await expect(page.getByRole('textbox', { name: 'Letter' })).toBeVisible();
    await page.mouse.move(10, 10);
    await page.mouse.move(60, 60);
    await check('body');
  });

  test('focus mode: the button shows a clear on-state, says its state, and the dimming is visible', async ({ page }) => {
    test.skip(isMobile(page), 'the focus button is hidden on phones (hide-phone); the palette toggles it there');
    const editor = await startWriting(page);
    await write(page, editor, 'First paragraph.\n\nSecond paragraph.');
    await toolbar(page);
    const button = page.getByRole('button', { name: /focus mode$/ });
    const m = (await mod(page)) === 'Meta' ? '⌘' : 'Ctrl ';
    const look = () => button.evaluate((el) => `${getComputedStyle(el).backgroundColor}|${getComputedStyle(el).color}`);
    // on by default (paragraph): pressed, other paragraphs dimmed
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toHaveAttribute('data-tip', `Focus mode: on ${m}⇧P`);
    await expect(page.locator('.cm-dim').first()).toBeAttached();
    const dim = await page
      .locator('.cm-dim')
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    const ink = await editor.evaluate((el) => getComputedStyle(el).color);
    expect(dim).not.toBe(ink);
    await page.mouse.move(5, 700);
    const on = await look();
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await expect(button).toHaveAttribute('data-tip', `Focus mode: off ${m}⇧P`);
    await expect(page.locator('.cm-dim')).toHaveCount(0);
    await page.mouse.move(5, 700);
    expect(await look()).not.toBe(on);
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.cm-dim').first()).toBeAttached();
  });

  test('the toolbar, its menu and the phone dock pass axe', async ({ page }) => {
    const editor = await startWriting(page);
    await write(page, editor, '# Title\n\n- [ ] a box\n\nBody **text**.');
    await toolbar(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const bar = await toolbar(page);
    await press(page, bar.getByRole('button', { name: /^Paragraph style/ }));
    await expect(page.getByRole('menu', { name: 'Paragraph style' })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
});
