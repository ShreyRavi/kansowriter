// Regression: ISSUE-001 — phone palette sheet had no touch-reachable way to close
// Found by /qa on 2026-10-23
// Report: .gstack/qa-reports/run-20261024T020531Z/qa-report-localhost-2026-10-23.md
import { expect, test } from '@playwright/test';
import { startWriting } from './helpers';

test('the full-screen palette on a phone closes with a tap', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone sheet only');
  await startWriting(page);
  await page.getByRole('button', { name: 'Open commands' }).click();
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
