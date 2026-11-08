import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['development'] },
  test: { name: 'ui', environment: 'jsdom', setupFiles: ['./src/test-setup.ts'] },
});
