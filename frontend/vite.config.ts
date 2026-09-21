import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// VITE_SUPABASE_ANON_KEY is intentionally NOT required here: a missing key
// disables the savings leaderboard at runtime (see src/lib/supabase.ts) rather
// than failing the build, so the package/app stays publishable without it.
//
// The PWA service worker is skipped entirely for the Tauri desktop build
// (detected via TAURI_ENV_PLATFORM, which tauri-cli injects around
// beforeBuildCommand/beforeDevCommand). It buys the embedded webview nothing
// -- Tauri already bundles every asset into the binary, no offline caching
// is needed -- and it's actively harmful there: a Workbox generateSW
// precache pins hashed filenames from whatever build produced it, and
// `emptyOutDir: true` across the frequent rebuilds a desktop app goes
// through deletes those exact files, so a still-active old service worker
// starts routing everything (including live API calls like the digest
// audio stream) through fetch handlers referencing files that no longer
// exist -- surfacing as silent 503s no error boundary catches. Only the
// browser-facing copy (`npm run build`, served from
// src/openjarvis/server/static) keeps the service worker, where offline
// support is genuinely useful and rebuilds are infrequent.
const isTauriBuild = !!process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    ...(isTauriBuild
      ? []
      : [
          VitePWA({
            registerType: 'autoUpdate',
            manifest: {
              name: 'OpenJarvis',
              short_name: 'Jarvis',
              description: 'On-device AI assistant',
              theme_color: '#161618',
              background_color: '#161618',
              display: 'standalone',
              icons: [
                { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
                { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
              ],
            },
            workbox: {
              globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
              navigateFallbackDenylist: [/^\/v1\//, /^\/health/, /^\/dashboard/, /^\/api\//],
            },
          }),
        ]),
  ],
  build: {
    outDir: '../src/openjarvis/server/static',
    emptyOutDir: true,
    // Preserve the Vite 6 browser baseline for existing desktop webviews.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom)[\\/]/ },
            {
              name: 'markdown',
              test: /node_modules[\\/](react-markdown|rehype-highlight|remark-gfm)[\\/]/,
            },
            { name: 'charts', test: /node_modules[\\/]recharts[\\/]/ },
            { name: 'router', test: /node_modules[\\/]react-router[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // ws: true is required for the /v1/agents/events WebSocket. Without it
      // Vite proxies the HTTP request but not the upgrade, so the socket never
      // opens — no error, no close event, just silence — and every live agent
      // view sits empty in dev while working in a production build.
      '/v1': {
        target: process.env.VITE_API_URL || 'http://localhost:8000',
        changeOrigin: true,
        ws: true,
      },
      '/health': process.env.VITE_API_URL || 'http://localhost:8000',
      '/api': process.env.VITE_API_URL || 'http://localhost:8000',
    },
  },
});
