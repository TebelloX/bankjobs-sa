// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://bankjobs-sa.pages.dev',
  integrations: [sitemap()],
  // No web fonts, no third-party origins — the page-weight budget and privacy
  // promise both depend on this staying empty.
  trailingSlash: 'ignore',
});
