import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// VITE_SUPABASE_ANON_KEY is intentionally NOT required here: a missing key
// disables the savings leaderboard at runtime (see src/lib/supabase.ts) rather
// than failing the build, so the package/app stays publishable without it.
//
// No PWA service worker (vite-plugin-pwa removed entirely, both here and
// from package.json). It bought nothing for a tool that only runs against
// 127.0.0.1 on the same machine as the server -- offline caching has no
// case to make -- and was actively harmful: Workbox's generateSW precache
// pins the hashed filenames from whatever build produced it, and
// `emptyOutDir: true` across ordinary rebuilds deletes those exact files.
// A still-active old service worker then routes everything -- including
// live API calls like the digest audio stream -- through fetch handlers
// referencing files that no longer exist, surfacing as silent 503s no
// error boundary catches. Reproduced independently twice in one session:
// once in the Tauri-bundled desktop app, once again minutes later in a
// plain browser tab hitting this same static build after a routine
// rebuild. `registerType: 'autoUpdate'` does not reliably save this --
// an old worker keeps controlling the CURRENT page across its own
// update cycle, so the failure window is exactly the rebuild-heavy,
// fast-iteration use this app actually gets.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  plugins: [react(), tailwindcss()],
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
