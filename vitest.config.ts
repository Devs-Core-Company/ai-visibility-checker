import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests never call PageSpeed Insights.
    env: { AVC_PSI: 'off' },
    testTimeout: 30000,
  },
});
