import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // R11: a new service worker waits until no Kansowriter tab is open; it never reloads an open page.
      registerType: 'prompt',
      // OV10: register from a same-origin script file, never an inline script (strict CSP).
      injectRegister: 'script',
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
        background_color: '#F5F0E6',
        theme_color: '#F5F0E6',
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
