import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { sriPlugin } from './sri-plugin';

// The UI is always bundled into each app (NFR-SEC-07) and, when enabled, served by the
// server for the browser UI with CSP + SRI (D-16, FR-CLI-04).
export default defineConfig({
  base: './',
  plugins: [react(), sriPlugin()],
  resolve: { conditions: ['development'] },
  build: { outDir: 'dist', sourcemap: false, target: 'es2020', assetsInlineLimit: 0, modulePreload: { polyfill: false } },
});
