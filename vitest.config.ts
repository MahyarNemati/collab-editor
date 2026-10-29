import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Server tests bind real TCP ports and drive wall-clock timers; running the
    // files sequentially keeps those assertions deterministic on a small runner.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
