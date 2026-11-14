import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // Fake values so tests can exercise the "secrets present" path. Real ones are Worker secrets.
      miniflare: { bindings: { TURN_KEY_ID: 'test-key-id', TURN_API_TOKEN: 'test-token-SECRET-9f3a' } },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
