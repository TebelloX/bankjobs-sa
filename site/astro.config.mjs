// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://mybankjobs.co.za',
  integrations: [sitemap()],
  // No web fonts, no third-party origins — the page-weight budget and privacy
  // promise both depend on this staying empty.
  trailingSlash: 'ignore',
  vite: {
    build: {
      // Never inline the search island (or any asset) into the HTML: the CSP in
      // public/_headers is `script-src 'self'` with NO inline-script hashes, so
      // an inlined script would be blocked in production — invisibly to CI,
      // which tests without the Pages headers. External files keep the policy
      // hash-free and immune to toolchain-version drift.
      assetsInlineLimit: 0,
    },
  },
});
