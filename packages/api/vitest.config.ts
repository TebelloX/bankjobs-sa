import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Runs the API tests against a REAL workerd + D1 simulator (not node), so the
// FTS5/trigger spike and every query exercise the production code path.
export default defineWorkersConfig({
  test: {
    include: ['test/**/*.test.ts'],
    poolOptions: {
      workers: {
        // Single source of truth for bindings + compatibility date.
        wrangler: { configPath: './wrangler.jsonc' },
      },
    },
  },
});
