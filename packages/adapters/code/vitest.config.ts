import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The browser smoke test launches a headless Chromium and the worker tests
    // spawn worker_threads; give them headroom beyond the default 5s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
