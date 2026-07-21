// Browse/search data changes only 3×/day (ingestion cadence), so the edge cache
// carries almost all read traffic and D1 stays well under the 5M reads/day free
// limit. TTL: fresh 5 min at the browser, 15 min at the edge.
export const CACHE_CONTROL = 'public, max-age=300, s-maxage=900';

// Only these params affect a response. The cache key is built from them,
// sorted and with unknown/empty params dropped, so `?b=2&a=1` and `?a=1&b=2&x=9`
// hit the same cache entry.
// `brand` MUST be here: it changes the result set, so omitting it would let
// ?brand=Absa and ?brand=Capitec collide on one cache entry and serve wrong rows.
const CACHE_PARAMS = [
  'q',
  'brand',
  'category',
  'province',
  'city',
  'source',
  'country',
  'limit',
  'offset',
];

export function cacheKey(request: Request, versionId?: string): Request {
  const url = new URL(request.url);
  const src = url.searchParams;
  const kept: [string, string][] = [];
  for (const k of CACHE_PARAMS) {
    const v = src.get(k);
    if (v !== null && v !== '') kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const params = new URLSearchParams(kept);
  // Deploy-scoped keys: a Worker deploy does NOT purge caches.default, so
  // without this a bug fix keeps serving each PoP's stale entry for up to
  // s-maxage (observed live: a search fix stayed invisible in Johannesburg
  // for ~15 min). Folding the deploy's version id into the key orphans every
  // old entry the moment a new version rolls out. `__v` can't collide with a
  // caller param — unknown params were already dropped above.
  if (versionId) params.set('__v', versionId);
  url.search = params.toString();
  return new Request(url.toString(), { method: 'GET' });
}
