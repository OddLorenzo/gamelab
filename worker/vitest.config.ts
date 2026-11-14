import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      // Fake values so tests can exercise the "secrets present" path. Real ones are Worker secrets.
      // ALLOWED_ORIGINS is a fake pair here; the real list is set per deployment (see ../DEPLOY.md).
      miniflare: {
        bindings: {
          TURN_KEY_ID: 'test-key-id',
          TURN_API_TOKEN: 'test-token-SECRET-9f3a',
          ALLOWED_ORIGINS: 'https://game.example,http://localhost:5173',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
