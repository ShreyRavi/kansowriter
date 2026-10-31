import { defineConfig, devices } from '@playwright/test';

// a port of our own: the common 4173 default may be another project's preview (reused silently)
const baseURL = process.env.BASE_URL ?? 'http://localhost:4317';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: process.env.BASE_URL
    ? undefined
    : { command: 'npm run build && npm run preview', url: baseURL, reuseExistingServer: !process.env.CI, timeout: 180_000 },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'iphone', use: { ...devices['iPhone 13'] } },
    { name: 'pixel', use: { ...devices['Pixel 7'] } },
    // Ctrl-key platforms (Windows / Linux) on any host: pages report Linux (e2e/fixtures.ts), so
    // shortcut bugs that only CI's Ubuntu runners would show are caught locally too
    {
      name: 'linux-keys',
      testMatch: /formatting\.spec\.ts/,
      metadata: { linuxKeys: true },
      use: {
        ...devices['Desktop Chrome'],
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      },
    },
  ],
});
