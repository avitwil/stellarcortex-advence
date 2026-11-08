import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: { name: 'server', testTimeout: 20000, pool: 'forks' },
});
