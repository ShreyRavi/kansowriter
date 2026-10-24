// @vitest-environment jsdom
// Value: protects=the root error screen never claims drafts are saved while the editor held unsaved words: it
//   reads the unsaved-text getter before the failed tree unmounts, offers Copy (clipboard, else the text selected
//   in a readonly box) and guards the reload; with nothing unsaved it says the drafts are saved;
//   fails_when=getDerivedStateFromError stops reading unsavedText(), reads it after the child's cleanup cleared it,
//   the copy fallback or the beforeunload guard goes, or the "saved" message is shown unconditionally;
//   why_new=the e2e suite can't force a root render error without a production test seam (the palette, the likely
//   cause, now has its own boundary: e2e/palette-failures.spec.ts); seam=none (a child that throws in jsdom);
//   no_claim=that EditorShell's registered getter returns the right text (its refs are exercised by the e2e
//   unsaved-words specs, not here), or how a real browser shows the beforeunload prompt
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ErrorBoundary } from './ErrorBoundary';
import { setUnsavedProvider } from './unsaved';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let explode: () => void = () => {};
/** jsdom reports the error React rethrows in development as uncaught; the boundary handles it */
const quiet = (e: ErrorEvent) => e.preventDefault();

/** Stands in for EditorShell: registers the getter while mounted (and clears it on unmount), throws on demand. */
function Child({ text }: { text: string | null }) {
  const [boom, setBoom] = useState(false);
  explode = () => setBoom(true);
  useEffect(() => setUnsavedProvider(() => text), [text]);
  if (boom) throw new Error('render failed');
  return <p>writing</p>;
}

async function renderAndFail(text: string | null) {
  await act(async () =>
    root.render(
      <ErrorBoundary>
        <Child text={text} />
      </ErrorBoundary>,
    ),
  );
  expect(host.textContent).toContain('writing');
  await act(async () => explode());
}

const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === name);
const beforeUnloadBlocked = () => {
  const e = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(e);
  return e.defaultPrevented;
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {}); // React reports the caught error
  window.addEventListener('error', quiet);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  window.removeEventListener('error', quiet);
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('with unsaved words: says so, offers Copy, and guards the reload', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await renderAndFail('the newest words');
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Something went wrong. Some of your newest words weren’t saved.');
    expect(host.textContent).not.toContain('saved on this device');
    expect(button('Reload')).toBeTruthy();
    expect(beforeUnloadBlocked()).toBe(true);
    await act(async () => button('Copy unsaved text')!.click());
    expect(writeText).toHaveBeenCalledWith('the newest words');
    expect(button('Copied')).toBeTruthy();
  });

  it('a blocked clipboard shows the words selected in a readonly box', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    await renderAndFail('keep me');
    await act(async () => button('Copy unsaved text')!.click());
    const box = host.querySelector('textarea')!;
    expect(box.readOnly).toBe(true);
    expect(box.value).toBe('keep me');
    expect(document.activeElement).toBe(box);
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 'keep me'.length]);
    expect(host.textContent).toMatch(/Selected\. Press (⌘C|Ctrl C) to copy/);
  });

  it('with nothing unsaved: says the drafts are saved, no Copy, no reload guard', async () => {
    await renderAndFail(null);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe('Something went wrong. Your drafts are saved on this device.');
    expect(button('Copy unsaved text')).toBeUndefined();
    expect(button('Reload')).toBeTruthy();
    expect(beforeUnloadBlocked()).toBe(false);
  });
});
