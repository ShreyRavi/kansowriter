import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';

/**
 * `test` with one automatic fixture: in a project whose metadata sets `linuxKeys`, every page of
 * the context reports a Linux platform before any app code runs, so the app (isMac), CodeMirror
 * (Mod = Ctrl) and helpers' mod() all take the Ctrl path on a Mac host, as CI's Ubuntu runners do.
 */
export const test = base.extend<{ linuxKeys: void }>({
  linuxKeys: [
    async ({ context }, use, info) => {
      if ((info.project.metadata as { linuxKeys?: boolean } | undefined)?.linuxKeys)
        await context.addInitScript(() => {
          Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Linux x86_64', configurable: true });
          Object.defineProperty(Navigator.prototype, 'userAgentData', {
            get: () => ({ platform: 'Linux', mobile: false, brands: [] }),
            configurable: true,
          });
        });
      await use();
    },
    { auto: true },
  ],
});
