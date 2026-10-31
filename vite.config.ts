import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { THEME_COLOR } from './src/ui/theme-colors';
import { LETTER_FILE_EXTENSION, LETTER_MIME } from './src/core/letter';

/**
 * Two builds of one app: the web app (dist/web, deployed by Vercel) and the macOS desktop app's
 * frontend (`--mode desktop`, embedded by Tauri from src-tauri/target/frontend). The desktop build
 * ships its files inside the .app, so it has no service worker, no web manifest and no update notice.
 */
export default defineConfig(({ mode }) => ({
  build: { outDir: mode === 'desktop' ? 'src-tauri/target/frontend' : 'dist/web' },
  plugins: [
    react(),
    VitePWA({
      disable: mode === 'desktop',
      // R11: a new service worker waits; it activates only when the user clicks Reload (src/ui/updates.ts)
      // or when no tab is open; it never reloads a page on its own.
      registerType: 'prompt',
      // OV10: the app registers the worker itself (src/ui/updates.ts, bundled), never an inline
      // script (strict CSP); it offers a quiet "Update ready · Reload" and reloads only on that click.
      injectRegister: false,
      workbox: {
        skipWaiting: false,
        clientsClaim: false,
        globPatterns: ['**/*.{js,css,html,woff2,svg,png,ico,webmanifest}'],
        navigateFallback: '/index.html',
        // A letter link must open the reader of the app as deployed now, not whatever shell this
        // device cached: /l never takes the precached fallback; it goes to the network first and
        // falls back to its own cached copy offline (once it has been fetched), then to the
        // precached shell. Workbox tests the denylist against pathname + search, so /l?fbclid=…
        // (a link that went through a chat app) is a letter navigation too.
        navigateFallbackDenylist: [/^\/l\/?(\?|$)/],
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) => request.mode === 'navigate' && /^\/l\/?$/.test(url.pathname),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'letter-reader',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 2 },
              // the fragment (the letter) is never sent; only the shell is cached
              matchOptions: { ignoreSearch: true },
              plugins: [
                {
                  // offline before /l was ever fetched (or an installed app opening a .kansoletter):
                  // the precached shell routes /l to the reader, which needs nothing else. Serialized
                  // into sw.js, so self-contained (no closures); the precache key carries a
                  // __WB_REVISION__ query, hence ignoreSearch.
                  handlerDidError: async () => (await caches.match('/index.html', { ignoreSearch: true })) ?? Response.error(),
                },
              ],
            },
          },
        ],
      },
      manifest: {
        name: 'Kansowriter',
        short_name: 'Kansowriter',
        description: 'A quiet place to write.',
        start_url: '/',
        display: 'standalone',
        background_color: THEME_COLOR.paper,
        theme_color: THEME_COLOR.paper,
        // R1: an installed app opens .kansoletter files in the reader (Chromium desktop only; the Reader reads window.launchQueue)
        file_handlers: [{ action: '/l', accept: { [LETTER_MIME]: [LETTER_FILE_EXTENSION] } }],
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // full-bleed with a safe zone, so Android's circle/squircle crop never cuts the marks
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
}));
