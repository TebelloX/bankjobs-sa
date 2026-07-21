/// <reference types="astro/client" />

// Build-time search configuration, inlined into the client bundle by Astro/Vite.
// See src/lib/searchClient.ts for how these drive static vs. api search mode.
interface ImportMetaEnv {
  readonly PUBLIC_SEARCH_MODE?: 'static' | 'api';
  readonly PUBLIC_API_BASE?: string;
}
