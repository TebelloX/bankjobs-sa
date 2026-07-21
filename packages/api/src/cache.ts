// Browse/search data changes only 3×/day (ingestion cadence), so the edge cache
// carries almost all read traffic and D1 stays well under the 5M reads/day free
// limit. TTL: fresh 5 min at the browser, 15 min at the edge.
export const CACHE_CONTROL = 'public, max-age=300, s-maxage=900';

// Only these params affect a response. The cache key is built from them,
// sorted and with unknown/empty params dropped, so `?b=2&a=1` and `?a=1&b=2&x=9`
// hit the same cache entry.
const CACHE_PARAMS = ['q', 'category', 'province', 'city', 'source', 'country', 'limit', 'offset'];

export function cacheKey(request: Request): Request {
  const url = new URL(request.url);
  const src = url.searchParams;
  const kept: [string, string][] = [];
  for (const k of CACHE_PARAMS) {
    const v = src.get(k);
    if (v !== null && v !== '') kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = new URLSearchParams(kept).toString();
  return new Request(url.toString(), { method: 'GET' });
}
