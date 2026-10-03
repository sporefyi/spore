import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Never run compiled output: only the TS sources under src/.
    dir: 'src',
    hookTimeout: 120000,
    testTimeout: 120000,
  },
});
