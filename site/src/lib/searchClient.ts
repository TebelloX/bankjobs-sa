// Single seam for the search data source. In 'static' mode the site ships a
// build-time JSON snapshot and filters it in the browser; in 'api' mode the
// search island queries the deployed Cloudflare Worker (bm25 FTS server-side).
// The mode is chosen at BUILD time from PUBLIC_* env vars and inlined into the
// client bundle by Astro/Vite — this module is the single place that plumbing
// lives, so flipping modes needs no other change in the UI.

export type SearchMode = 'static' | 'api';

/**
 * 'static' = fetch the snapshot and filter client-side (default: local dev and
 * CI builds without a Worker). 'api' = query the Worker. Chosen at build time
 * from PUBLIC_SEARCH_MODE; anything other than 'api' (including unset) is
 * 'static', so a plain `pnpm build` stays static.
 */
export const PUBLIC_SEARCH_MODE: SearchMode =
  import.meta.env.PUBLIC_SEARCH_MODE === 'api' ? 'api' : 'static';

/**
 * Worker origin for 'api' mode (e.g. https://bankjobs-api.example.workers.dev),
 * no trailing slash. First-party infra only — never a third-party origin.
 */
export const PUBLIC_API_BASE: string = import.meta.env.PUBLIC_API_BASE ?? '';

// An 'api' build with no base URL would ship a search box that can never reach
// the Worker. Fail the build loudly at module evaluation rather than shipping
// broken search: search.astro imports PUBLIC_SEARCH_MODE in its frontmatter, so
// this runs during `astro build`, not in the visitor's browser.
if (PUBLIC_SEARCH_MODE === 'api' && PUBLIC_API_BASE === '') {
  throw new Error(
    "PUBLIC_SEARCH_MODE='api' requires PUBLIC_API_BASE to be set to the Worker origin (no trailing slash).",
  );
}

/** Same-origin snapshot of open jobs (lean rows). Never a third-party URL. */
export const SEARCH_DATA_URL = '/data/jobs.json';

/** Lean row shape shipped in public/data/jobs.json. */
export interface SearchRow {
  id: string;
  slug: string;
  title: string;
  brand: string;
  source: string;
  category: string;
  categorySlug: string;
  city: string | null;
  province: string | null;
  primaryLocation: string | null;
  country: string;
  postedDate: string | null;
}

/**
 * A row from the Worker `GET /api/jobs` response: the lean row plus the two
 * extra fields the API attaches to search results.
 */
export interface ApiJobRow extends SearchRow {
  excerpt: string;
  applyUrl: string;
}

/** Shape of the Worker `GET /api/jobs` response. */
export interface ApiJobsResponse {
  total: number;
  limit: number;
  offset: number;
  jobs: ApiJobRow[];
}

/**
 * UI state the search island maps onto Worker `/api/jobs` params in 'api' mode.
 *
 * The three filter fields carry CANONICAL API values, not URL slugs: the search
 * page renders them into each `<option data-api>` at build time and the island
 * reads them back off the selected option. Every param name below is on the
 * edge-cache-key allowlist in packages/api/src/cache.ts — a filter that is not
 * on that list would let two different result sets collide on one cache entry.
 */
export interface SearchQuery {
  /** Free-text query; '' lists everything in scope (the API falls back to a listing). */
  q: string;
  /** Canonical brand name exactly as stored on jobs.brand ('Standard Bank'); omit for all banks. */
  brand?: string;
  /** Category slug ('risk-compliance') or canonical name — the API resolves both; omit for all. */
  category?: string;
  /** Canonical province name ('Western Cape'); omit for all provinces. */
  province?: string;
  /** ISO alpha-2 to restrict to one country ('ZA' = SA-only); omit for all countries. */
  country?: string;
  /** Page size (the API caps this at 50). */
  limit: number;
  /** Row offset for paging. */
  offset: number;
}

/**
 * Build the Worker query URL for a search. 'static' mode never calls this — it
 * fetches SEARCH_DATA_URL once and filters locally, so the query is irrelevant
 * there; 'api' mode maps the UI state (query, filters, country scope, paging)
 * onto the `/api/jobs` params. Empty/undefined values are omitted rather than
 * sent blank: the Worker treats a missing param as "no constraint", and the
 * cache key drops empty params anyway.
 */
export function buildSearchUrl(params: SearchQuery): string {
  const url = new URL(`${PUBLIC_API_BASE}/api/jobs`);
  if (params.q) url.searchParams.set('q', params.q);
  if (params.brand) url.searchParams.set('brand', params.brand);
  if (params.category) url.searchParams.set('category', params.category);
  if (params.province) url.searchParams.set('province', params.province);
  if (params.country) url.searchParams.set('country', params.country);
  url.searchParams.set('limit', String(params.limit));
  url.searchParams.set('offset', String(params.offset));
  return url.toString();
}
