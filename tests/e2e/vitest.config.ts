import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { conditions: ['development'] },
  test: { name: 'e2e', testTimeout: 90_000, hookTimeout: 60_000, pool: 'forks', include: ['**/*.e2e.ts'] },
});
