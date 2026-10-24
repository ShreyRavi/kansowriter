import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { THEME_COLOR } from './src/ui/theme-colors';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
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
        file_handlers: [{ action: '/l', accept: { 'application/x-kansoletter': ['.kansoletter'] } }],
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
});
