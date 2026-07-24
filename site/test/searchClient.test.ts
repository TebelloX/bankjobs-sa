import { afterEach, describe, expect, it, vi } from 'vitest';

// searchClient reads import.meta.env at MODULE scope (the mode guard runs on
// evaluation), so the env has to be stubbed before the module is imported and
// the registry reset between cases — hence dynamic import + resetModules rather
// than a top-level `import`.
async function loadClient(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return await import('../src/lib/searchClient');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const API_ENV = { PUBLIC_SEARCH_MODE: 'api', PUBLIC_API_BASE: 'https://api.example.test' };

/** Params the Worker builds its edge-cache key from (packages/api/src/cache.ts).
    A param the island sends that is NOT on this list would let two different
    result sets collide on one cached entry. */
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

describe('PUBLIC_SEARCH_MODE', () => {
  it("defaults to 'static' when unset", async () => {
    const { PUBLIC_SEARCH_MODE } = await loadClient({ PUBLIC_SEARCH_MODE: '' });
    expect(PUBLIC_SEARCH_MODE).toBe('static');
  });

  it("is 'api' only for the exact value", async () => {
    expect((await loadClient(API_ENV)).PUBLIC_SEARCH_MODE).toBe('api');
    expect((await loadClient({ PUBLIC_SEARCH_MODE: 'API' })).PUBLIC_SEARCH_MODE).toBe('static');
  });

  it("fails loudly when 'api' has no base url — at build, not in a browser", async () => {
    await expect(loadClient({ PUBLIC_SEARCH_MODE: 'api', PUBLIC_API_BASE: '' })).rejects.toThrow(
      /PUBLIC_API_BASE/,
    );
  });
});

describe('buildSearchUrl', () => {
  it('hits /api/jobs on the configured base with paging always present', async () => {
    const { buildSearchUrl } = await loadClient(API_ENV);
    const url = new URL(buildSearchUrl({ q: 'teller', limit: 50, offset: 0 }));
    expect(url.origin + url.pathname).toBe('https://api.example.test/api/jobs');
    expect(url.searchParams.get('q')).toBe('teller');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('offset')).toBe('0');
  });

  it('omits an empty query rather than sending q=', async () => {
    const { buildSearchUrl } = await loadClient(API_ENV);
    const url = new URL(buildSearchUrl({ q: '', limit: 50, offset: 0 }));
    expect(url.searchParams.has('q')).toBe(false);
  });

  it('omits every filter that is not set', async () => {
    const { buildSearchUrl } = await loadClient(API_ENV);
    const url = new URL(buildSearchUrl({ q: 'teller', limit: 50, offset: 0 }));
    for (const key of ['brand', 'category', 'province', 'country']) {
      expect(url.searchParams.has(key)).toBe(false);
    }
    expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'offset', 'q']);
  });

  it('emits brand, category and province when set, with canonical values', async () => {
    const { buildSearchUrl } = await loadClient(API_ENV);
    const url = new URL(
      buildSearchUrl({
        q: '',
        brand: 'Standard Bank',
        category: 'risk-compliance',
        province: 'Western Cape',
        country: 'ZA',
        limit: 50,
        offset: 0,
      }),
    );
    expect(url.searchParams.get('brand')).toBe('Standard Bank');
    expect(url.searchParams.get('category')).toBe('risk-compliance');
    expect(url.searchParams.get('province')).toBe('Western Cape');
    expect(url.searchParams.get('country')).toBe('ZA');
    // Spaces are encoded by URLSearchParams, so the values survive the trip.
    expect(url.search).toContain('brand=Standard+Bank');
    expect(url.search).toContain('province=Western+Cape');
  });

  it('drops filters passed as empty strings', async () => {
    const { buildSearchUrl } = await loadClient(API_ENV);
    const url = new URL(
      buildSearchUrl({ q: '', brand: '', category: '', province: '', limit: 20, offset: 20 }),
    );
    expect([...url.searchParams.keys()].sort()).toEqual(['limit', 'offset']);
    expect(url.searchParams.get('offset')).toBe('20');
  });

  it('only ever emits params the Worker cache key is built from', async () => {
    const { buildSearchUrl } = await loadClient(API_ENV);
    const url = new URL(
      buildSearchUrl({
        q: 'analyst',
        brand: 'Absa',
        category: 'data-analytics',
        province: 'Gauteng',
        country: 'ZA',
        limit: 50,
        offset: 100,
      }),
    );
    for (const key of url.searchParams.keys()) {
      expect(CACHE_PARAMS).toContain(key);
    }
  });
});
