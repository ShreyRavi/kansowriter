import { expect, type Locator, type Page } from '@playwright/test';

/** The app's own rule for ⌘ vs Ctrl, evaluated in the (possibly emulated) page. */
export const mod = async (page: Page) =>
  (await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))) ? 'Meta' : 'Control';

/** Fresh visit: clear storage so each test starts with no drafts. */
export async function freshStart(page: Page) {
  await page.goto('/about');
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    const dbs = (await indexedDB.databases?.()) ?? [{ name: 'kansowriter' }];
    await Promise.all(
      dbs.map(
        (d) =>
          new Promise((r) => {
            const q = indexedDB.deleteDatabase(d.name!);
            q.onsuccess = q.onerror = q.onblocked = () => r(null);
          }),
      ),
    );
  });
}

export async function startWriting(page: Page) {
  await freshStart(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Start writing' }).click();
  const editor = page.getByRole('textbox', { name: 'Draft' });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  return editor;
}

/**
 * In the page: the open editor's text, and what IndexedDB has committed for each draft (the latest
 * snapshot at or below `head`, then the ops after it replayed with the KOP rule from src/core/kop.ts).
 */
export const savedState = (page: Page) =>
  page.evaluate(async () => {
    // CodeMirror keeps its view on the content element (`cmTile` since 6.4x, `cmView` before)
    type Node = { root?: { view?: View }; rootView?: { view?: View }; view?: View };
    type View = { state: { doc: { toString(): string } } };
    const content = document.querySelector('.cm-content') as (HTMLElement & { cmTile?: Node; cmView?: Node }) | null;
    const tile = content?.cmTile ?? content?.cmView;
    const view = tile?.root?.view ?? tile?.rootView?.view ?? tile?.view;
    const editor = view ? view.state.doc.toString() : null;
    const title = document.querySelector('.header .title')?.textContent ?? null;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const q = indexedDB.open('kansowriter');
      q.onsuccess = () => resolve(q.result);
      q.onerror = () => reject(q.error);
    });
    const all = <T>(store: string) =>
      new Promise<T[]>((resolve, reject) => {
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => resolve(q.result as T[]);
        q.onerror = () => reject(q.error);
      });
    type Rec = { id: string; head: number; updatedAt: number; meta?: { title?: string } };
    type Run = number | string;
    try {
      const [drafts, ops, snaps] = await Promise.all([
        all<Rec>('drafts'),
        all<{ draftId: string; seq: number; op: Run[] }>('ops'),
        all<{ draftId: string; opIndex: number; text: string }>('snapshots'),
      ]);
      const saved = drafts.map((d) => {
        const snap = snaps.filter((s) => s.draftId === d.id && s.opIndex <= d.head).sort((a, b) => b.opIndex - a.opIndex)[0];
        let text = snap?.text ?? '';
        const mine = ops.filter((o) => o.draftId === d.id && o.seq >= (snap?.opIndex ?? 0) && o.seq < d.head).sort((a, b) => a.seq - b.seq);
        for (const { op } of mine) {
          let pos = 0;
          let out = '';
          for (const r of op.slice(2)) {
            if (typeof r === 'string') out += r;
            else if (r > 0) {
              out += text.slice(pos, pos + r);
              pos += r;
            } else pos -= r;
          }
          text = out;
        }
        return { id: d.id, head: d.head, updatedAt: d.updatedAt, title: d.meta?.title ?? '', ops: mine.length, text };
      });
      return { editor, title, saved };
    } finally {
      db.close();
    }
  });

/**
 * The draft the editor has open: the one being written is the most recently updated, and its saved
 * title is what the header shows (set from each commit), so match the title first, then take the newest.
 */
export function openDraftOf<D extends { title: string; updatedAt: number }>(header: string | null, saved: D[]): D | undefined {
  const named = saved.filter((d) => (d.title || 'Untitled') === header);
  return (named.length ? named : saved).reduce<D | undefined>((a, d) => (!a || d.updatedAt > a.updatedAt ? d : a), undefined);
}

/**
 * Wait until storage holds exactly what the open draft's editor shows (nothing unsaved: the open word closes after
 * the 1 s merge window and the 500 ms batch writes it), seen on two polls in a row ~300 ms apart so a
 * keystroke still being processed can't slip past.
 */
export async function settle(page: Page) {
  let matches = 0;
  await expect
    .poll(
      async () => {
        const { editor, title, saved } = await savedState(page);
        const open = openDraftOf(title, saved);
        matches = editor !== null && open?.text === editor ? matches + 1 : 0;
        return matches;
      },
      { message: 'the editor text never reached IndexedDB', timeout: 15_000, intervals: [300] },
    )
    .toBeGreaterThanOrEqual(2);
}

const isMobile = (page: Page) => page.viewportSize()!.width < 640;

/** Type into the editor; on phone emulation newlines go in as inserted text (as a real keyboard's insertParagraph would). */
export async function write(page: Page, editor: Locator, text: string) {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]) await editor.pressSequentially(parts[i]!);
    if (i < parts.length - 1) {
      if (isMobile(page)) await page.keyboard.insertText('\n');
      else await page.keyboard.press('Enter');
    }
  }
}

/** Run a palette command by name: Enter on desktop, tap on phones. */
export async function runCommand(page: Page, query: string, option: string | RegExp) {
  await page.getByPlaceholder('Search commands and settings').fill(query);
  if (isMobile(page)) await page.getByRole('option', { name: option }).first().click();
  else {
    // cmdk re-selects after filtering on the next frame: wait for it, as a person would
    await expect(page.locator('[cmdk-item][data-selected="true"]')).toHaveText(option);
    await page.keyboard.press('Enter');
  }
}

/** Open the drafts sidebar the way a person does: the header fades while typing, so reveal it first. */
export async function openDrafts(page: Page) {
  if (isMobile(page)) await page.touchscreen.tap(5, 400);
  else {
    await page.mouse.move(200, 300);
    await page.mouse.move(240, 340);
  }
  await page.getByRole('button', { name: 'Open drafts' }).click();
}

type IdbMethod = 'add' | 'put' | 'delete';

/**
 * Make IndexedDB requests throw in this page (as a full disk or a broken store would): each listed
 * IDBObjectStore method throws QuotaExceededError, for one store or (no `store`) for all of them.
 * `restoreIdb` puts the real methods back.
 */
export async function failIdb(page: Page, methods: IdbMethod[], store?: string) {
  await page.evaluate(
    ({ methods, store }) => {
      const proto = IDBObjectStore.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
      const real = ((window as unknown as { __realIdb?: Record<string, unknown> }).__realIdb ??= {});
      for (const m of methods) {
        real[m] ??= proto[m];
        const original = real[m] as (...a: unknown[]) => unknown;
        proto[m] = function (this: IDBObjectStore, ...args: unknown[]) {
          if (!store || this.name === store) throw new DOMException(`test: ${m} refused`, 'QuotaExceededError');
          return original.apply(this, args);
        };
      }
    },
    { methods, store },
  );
}

export async function restoreIdb(page: Page) {
  await page.evaluate(() => {
    const proto = IDBObjectStore.prototype as unknown as Record<string, unknown>;
    const real = (window as unknown as { __realIdb?: Record<string, unknown> }).__realIdb ?? {};
    for (const [m, f] of Object.entries(real)) proto[m] = f;
  });
}

/** The draft disappears underneath this tab (deleted elsewhere): its next write is refused and the tab goes stale. */
export async function removeDraftsUnderneath(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((r) => {
      const q = indexedDB.open('kansowriter');
      q.onsuccess = () => r(q.result);
    });
    await new Promise((r) => {
      const t = db.transaction('drafts', 'readwrite');
      t.objectStore('drafts').clear();
      t.oncomplete = r;
    });
    db.close();
  });
}
