import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests never call PageSpeed Insights.
    // Tests keep keys in a file under their temp data dir, never in the OS keychain.
    env: { AVC_PSI: 'off', AVC_SECRET_STORE: 'file' },
    testTimeout: 30000,
  },
});
