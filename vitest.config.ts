import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // @bankjobs/api runs on the Cloudflare workers pool (real workerd + D1), not
    // this node pool. Its own vitest.config.ts + `pnpm test` (see root scripts)
    // run it separately.
    exclude: [...configDefaults.exclude, 'packages/api/**'],
  },
});
