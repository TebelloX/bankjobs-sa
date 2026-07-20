// Single seam for the search data source. Today the site is fully static and
// filters a fetched JSON snapshot in the browser. When the Worker API lands
// (deferred milestone), flip PUBLIC_SEARCH_MODE to 'api' and point
// SEARCH_DATA_URL / buildSearchUrl at it — nothing else in the UI changes.

export type SearchMode = 'static' | 'api';

/** 'static' = fetch the snapshot and filter client-side (current + local dev). */
export const PUBLIC_SEARCH_MODE: SearchMode = 'static';

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
 * In 'api' mode this would return the Worker query URL for a given search;
 * in 'static' mode the whole snapshot is fetched once and filtered locally,
 * so the query is ignored here.
 */
export function buildSearchUrl(_query: string): string {
  return SEARCH_DATA_URL;
}
