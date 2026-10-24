// Leaving a draft, by state × way of leaving. Unsaved words (a stale tab, or saves that keep failing)
// must never vanish on a switch or on browser Back: the "aren't saved" notice holds the leave and the
// URL stays on the editor until Leave anyway; a clean draft leaves at once and reopens from "/".
// (stale × switch-draft → Leave anyway is covered in app.spec.ts, R5.)
import { expect, test, type Page } from '@playwright/test';
import { failIdb, freshStart, openDrafts, removeDraftsUnderneath, settle, write } from './helpers';

const draft = (page: Page) => page.getByRole('textbox', { name: 'Draft' });
const unsavedLeave = (page: Page) => page.getByText('Your newest words aren’t saved.');
const savingError = (page: Page) => page.getByText('Couldn’t save just now. Retrying…');
const landing = (page: Page) => page.getByRole('heading', { name: 'A quiet place to write.' });
const path = (page: Page) => new URL(page.url()).pathname;

/** Start from /about so Start writing pushes "/" and browser Back has somewhere to go. */
async function startFromAbout(page: Page) {
  await freshStart(page);
  await page.goto('/about');
  await page.getByRole('button', { name: 'Start writing' }).click();
  await expect(draft(page)).toHaveAttribute('contenteditable', 'true');
  await expect.poll(() => path(page)).toBe('/');
  await write(page, draft(page), 'first words');
  await settle(page);
}

test('dirty (saves failing) × switch draft: the notice holds the switch and Stay keeps writing', async ({ page }) => {
  await startFromAbout(page);
  await failIdb(page, ['add', 'put'], 'ops');
  await draft(page).pressSequentially(' unsaved');
  await expect(savingError(page)).toBeVisible({ timeout: 10_000 });
  await openDrafts(page);
  await page.getByRole('dialog', { name: 'Drafts' }).getByRole('button', { name: 'New draft' }).click();
  await expect(unsavedLeave(page)).toBeVisible();
  await expect(draft(page)).toContainText('first words unsaved');
  await page.getByRole('button', { name: 'Stay' }).click();
  await expect(unsavedLeave(page)).toHaveCount(0);
  // still the same draft, still writable; the next retry fails again and says so
  await expect(draft(page)).toContainText('first words unsaved');
  await expect(draft(page)).toHaveAttribute('contenteditable', 'true');
  await expect(savingError(page)).toBeVisible({ timeout: 15_000 });
});

test('clean × browser Back: Landing shows, and "/" reopens the draft', async ({ page }) => {
  await startFromAbout(page);
  await page.goBack();
  await expect(landing(page)).toBeVisible();
  expect(path(page)).toBe('/about');
  await page.goto('/');
  await expect(draft(page)).toHaveText('first words');
});

test('stale × browser Back: the notice holds Back on the editor until Leave anyway', async ({ page }) => {
  await startFromAbout(page);
  await removeDraftsUnderneath(page);
  await draft(page).pressSequentially(' second');
  await expect(page.getByText('This tab stopped saving.')).toBeVisible({ timeout: 10_000 });
  await page.goBack();
  await expect(unsavedLeave(page)).toBeVisible();
  await expect(draft(page)).toContainText('first words second');
  await expect.poll(() => path(page)).toBe('/');
  await page.getByRole('button', { name: 'Leave anyway' }).click();
  await expect(landing(page)).toBeVisible();
  expect(path(page)).toBe('/about');
});

test('dirty (saves failing) × browser Back: the notice holds Back on the editor until Leave anyway', async ({ page }) => {
  await startFromAbout(page);
  await failIdb(page, ['add', 'put'], 'ops');
  await draft(page).pressSequentially(' second');
  await expect(savingError(page)).toBeVisible({ timeout: 10_000 });
  await page.goBack();
  await expect(unsavedLeave(page)).toBeVisible();
  await expect(draft(page)).toContainText('first words second');
  await expect.poll(() => path(page)).toBe('/');
  await page.getByRole('button', { name: 'Leave anyway' }).click();
  await expect(landing(page)).toBeVisible();
  expect(path(page)).toBe('/about');
});
