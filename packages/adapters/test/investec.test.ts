import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { investecAdapter } from '../src/index';
import {
  EARCU_UA,
  extractCanonicalUrl,
  extractDetailUrls,
  extractJobPostingLd,
  fetchAllEarcu,
} from '../src/index';
import type { EarcuConfig, EarcuRawPosting } from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (committed HTML, loaded offline — never the network). Each detail
// page is turned into a raw posting the same way the live client does: parse the
// JobPosting JSON-LD and read the canonical URL as the durable apply link.
// ---------------------------------------------------------------------------

const fixturesDir = new URL('../../../fixtures/investec/', import.meta.url);

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixturesDir), 'utf8');
}

function rawFromDetail(name: string): EarcuRawPosting {
  const html = readFixture(name);
  const jsonLd = extractJobPostingLd(html);
  const url = extractCanonicalUrl(html);
  if (jsonLd === null) throw new Error(`no JobPosting JSON-LD in ${name}`);
  if (url === null) throw new Error(`no canonical URL in ${name}`);
  return { url, jsonLd };
}

const detailFiles = readdirSync(fixturesDir)
  .filter((f) => /^detail-.*\.html$/.test(f))
  .sort();
const raws = detailFiles.map(rawFromDetail);

function jobForReq(reqNumber: string): ReturnType<typeof investecAdapter.normalize> {
  const raw = raws.find((r) => extractIdentifier(r) === reqNumber);
  if (!raw) throw new Error(`No fixture for req ${reqNumber}`);
  return investecAdapter.normalize(raw);
}

function extractIdentifier(raw: EarcuRawPosting): string {
  const id = raw.jsonLd.identifier;
  return typeof id === 'string' ? id : String(id?.value ?? '');
}

// ---------------------------------------------------------------------------
// Snapshots.
// ---------------------------------------------------------------------------

describe('investecAdapter.normalize — snapshots', () => {
  it.each(raws.map((r) => [extractIdentifier(r), r] as const))('normalizes %s', (_id, raw) => {
    expect(investecAdapter.normalize(raw)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Invariants that must hold for every fixture.
// ---------------------------------------------------------------------------

describe('investecAdapter.normalize — invariants', () => {
  const jobs = raws.map((r) => investecAdapter.normalize(r));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^investec:\d+$/);
    expect(job.source).toBe('investec');
    expect(job.brand).toBe('Investec');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    expect(job.applyUrl.startsWith('https://careers.investec.co.za/')).toBe(true);

    // datePosted is templated to today's date on every load, so it is never
    // trusted; validThrough is unreliable. Recency comes from firstSeen.
    expect(job.postedDate).toBeNull();

    // Every posting is on Investec's SA careers site.
    expect(job.country).toBe('ZA');
  });
});

// ---------------------------------------------------------------------------
// Fixture-specific mapping.
// ---------------------------------------------------------------------------

describe('investecAdapter.normalize — mapping', () => {
  it('detail-1 (Relationship Manager, Cape Town) → ZA / Western Cape, Full-time', () => {
    const job = jobForReq('13385');
    expect(job.id).toBe('investec:13385');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Cape Town');
    expect(job.locations[0]?.province).toBe('Western Cape');
    expect(job.primaryLocation).toBe('Cape Town, Western Cape');
    expect(job.employmentType).toBe('Full-time');
    // The req number in the slug is NOT the numeric id in the path (13385 vs
    // 13403) — the id comes from the JSON-LD identifier, the URL from canonical.
    expect(job.applyUrl).toBe(
      'https://careers.investec.co.za/jobs/vacancy/relationship-manager--business-and-commercial-banking-13385-cape-town/13403/description/',
    );
  });

  it('detail-2 (Sandton) → ZA / Gauteng from the Johannesburg locality', () => {
    const job = jobForReq('13804');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Johannesburg');
    expect(job.locations[0]?.province).toBe('Gauteng');
    expect(job.primaryLocation).toBe('Johannesburg, Gauteng');
  });

  it('detail-3 (no JSON-LD location) → still ZA, but no resolved location', () => {
    const job = jobForReq('13784');
    expect(job.country).toBe('ZA');
    expect(job.locations).toEqual([]);
    expect(job.primaryLocation).toBeNull();
  });

  it('treats a Place with an empty PostalAddress as no location too', () => {
    // The other live shape of a city-less posting (an empty address object
    // rather than an empty jobLocation array) — both fall through to ZA / no
    // location rather than inventing a city from the title.
    const raw = structuredClone(raws[0]!);
    raw.jsonLd.jobLocation = [{ '@type': 'Place', address: {} }];
    const job = investecAdapter.normalize(raw);
    expect(job.country).toBe('ZA');
    expect(job.locations).toEqual([]);
    expect(job.primaryLocation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sitemap discovery (pure, against the committed sitemap fixture). The sitemap
// replaced the results-page + pagestamp + grid-AJAX walk once AWS WAF started
// JS-challenging that path; it lists talent pools and ordinary site pages
// alongside the real vacancies, so the vacancy-path filter is load-bearing.
// ---------------------------------------------------------------------------

const ORIGIN = 'https://careers.investec.co.za';

describe('eArcu sitemap discovery', () => {
  const sitemap = readFixture('sitemap.xml');

  it('keeps only the vacancy detail URLs, absolute and deduped', () => {
    const urls = extractDetailUrls(sitemap, ORIGIN);

    expect(urls.length).toBe(6);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) {
      expect(u).toMatch(
        /^https:\/\/careers\.investec\.co\.za\/jobs\/vacancy\/[^\s"']+\/\d+\/description\/$/,
      );
    }
    expect(urls).toContain(
      'https://careers.investec.co.za/jobs/vacancy/relationship-manager--business-and-commercial-banking-13385-cape-town/13403/description/',
    );
  });

  it('excludes the evergreen talentpool locs the sitemap also lists', () => {
    // The fixture is mostly talent pools — same /…/{id}/description/ tail, a
    // different collection — and they are NOT vacancies.
    const talentPoolLocs = sitemap.match(/<loc>[^<]*\/jobs\/talentpool\/[^<]*<\/loc>/gi) ?? [];
    expect(talentPoolLocs.length).toBeGreaterThan(6);

    const urls = extractDetailUrls(sitemap, ORIGIN);
    expect(urls.some((u) => u.includes('/jobs/talentpool/'))).toBe(false);
  });

  it('excludes ordinary site pages and drops duplicate locs', () => {
    const xml = [
      '<urlset>',
      `<url><loc>${ORIGIN}/jobs/info/careers/</loc></url>`,
      `<url><loc>${ORIGIN}/</loc></url>`,
      `<url><loc>${ORIGIN}/jobs/vacancy/a-role-1-cape-town/2/description/</loc></url>`,
      // A relative loc and an entity-encoded one resolve to the same URL as the
      // absolute form above, so both are deduped away.
      '<url><loc>/jobs/vacancy/a-role-1-cape-town/2/description/</loc></url>',
      `<url><loc>${ORIGIN}/jobs/vacancy/a-role-1-cape-town/2/description/</loc></url>`,
      `<url><loc>${ORIGIN}/jobs/vacancy/find/results/</loc></url>`,
      '</urlset>',
    ].join('\n');

    expect(extractDetailUrls(xml, ORIGIN)).toEqual([
      `${ORIGIN}/jobs/vacancy/a-role-1-cape-town/2/description/`,
    ]);
  });

  it('extracts and parses the JobPosting JSON-LD from a detail page', () => {
    const posting = extractJobPostingLd(readFixture('detail-1.html'));
    expect(posting).not.toBeNull();
    expect(posting?.['@type']).toBe('JobPosting');
    expect(posting?.title).toBe('Relationship Manager- Business and Commercial Banking');
  });

  it('returns null when a page carries no JobPosting JSON-LD', () => {
    expect(extractJobPostingLd('<html><body>no ld+json here</body></html>')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchAllEarcu — the sitemap→detail crawl, against a stubbed fetch.
// ---------------------------------------------------------------------------

/** A detail page carrying a minimal JobPosting block for the given req number. */
function stubDetailHtml(req: string): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting',
    title: `Role ${req}`,
    identifier: { '@type': 'PropertyValue', value: req },
  })}</script></head><body></body></html>`;
}

function stubSitemap(paths: string[]): string {
  return `<urlset>${paths.map((p) => `<url><loc>https://careers.example.co.za${p}</loc></url>`).join('')}</urlset>`;
}

/** Route stubbed responses by URL; anything unrouted is a test bug (404). */
function routedFetch(routes: Record<string, () => Response>): {
  impl: typeof fetch;
  calls: string[];
  headers: (Record<string, string> | undefined)[];
} {
  const calls: string[] = [];
  const headers: (Record<string, string> | undefined)[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = String(input);
    calls.push(url);
    headers.push(init?.headers as Record<string, string> | undefined);
    const route = routes[url];
    return Promise.resolve(route ? route() : new Response('unrouted', { status: 404 }));
  };
  return { impl, calls, headers };
}

const TEST_CFG: EarcuConfig = { host: 'careers.example.co.za', delayMs: 0 };
const TEST_SITEMAP_URL = 'https://careers.example.co.za/jobs/sitemap.xml';

describe('fetchAllEarcu', () => {
  it('crawls the sitemap vacancies with the honest UA and no cookies', async () => {
    const vacancy = '/jobs/vacancy/a-role-1-sandton/2/description/';
    const { impl, calls, headers } = routedFetch({
      [TEST_SITEMAP_URL]: () =>
        new Response(stubSitemap([vacancy, '/jobs/talentpool/private-bank/250/description/']), {
          status: 200,
        }),
      [`https://careers.example.co.za${vacancy}`]: () =>
        new Response(stubDetailHtml('1'), { status: 200 }),
    });

    const raws = await fetchAllEarcu(TEST_CFG, { fetchImpl: impl });

    expect(calls).toEqual([TEST_SITEMAP_URL, `https://careers.example.co.za${vacancy}`]);
    expect(raws).toHaveLength(1);
    expect(raws[0]?.jsonLd.title).toBe('Role 1');
    for (const h of headers) {
      expect(h?.['User-Agent']).toBe(EARCU_UA);
      expect(h?.Cookie).toBeUndefined();
    }
  });

  it('reads sitemapPath from config — a second eArcu site is config, not code', async () => {
    const { impl, calls } = routedFetch({
      'https://careers.example.co.za/careers/sitemap.xml': () =>
        new Response(stubSitemap([]), { status: 200 }),
    });

    await fetchAllEarcu({ ...TEST_CFG, sitemapPath: '/careers/sitemap.xml' }, { fetchImpl: impl });
    expect(calls).toEqual(['https://careers.example.co.za/careers/sitemap.xml']);
  });

  it('names the AWS WAF challenge behind a 202 rather than failing later', async () => {
    // The exact failure that broke discovery: 202 IS 2xx, so an `res.ok` check
    // waves the empty body through and the run dies at parse time instead.
    const { impl } = routedFetch({
      [TEST_SITEMAP_URL]: () =>
        new Response('', { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }),
    });

    await expect(fetchAllEarcu(TEST_CFG, { fetchImpl: impl })).rejects.toThrow(
      `eArcu sitemap request blocked by AWS WAF challenge (HTTP 202, x-amzn-waf-action: challenge): ${TEST_SITEMAP_URL}`,
    );
  });

  it('reports a plain non-200 as an ordinary failure', async () => {
    const { impl } = routedFetch({
      [TEST_SITEMAP_URL]: () => new Response('', { status: 503 }),
    });

    await expect(fetchAllEarcu(TEST_CFG, { fetchImpl: impl })).rejects.toThrow(
      `eArcu sitemap request failed: HTTP 503 for ${TEST_SITEMAP_URL}`,
    );
  });

  it('names the WAF on a challenged detail page too', async () => {
    const vacancy = '/jobs/vacancy/a-role-1-sandton/2/description/';
    const { impl } = routedFetch({
      [TEST_SITEMAP_URL]: () => new Response(stubSitemap([vacancy]), { status: 200 }),
      [`https://careers.example.co.za${vacancy}`]: () =>
        new Response('', { status: 202, headers: { 'x-amzn-waf-action': 'challenge' } }),
    });

    await expect(fetchAllEarcu(TEST_CFG, { fetchImpl: impl })).rejects.toThrow(
      /^eArcu detail request blocked by AWS WAF challenge \(HTTP 202, x-amzn-waf-action: challenge\)/,
    );
  });

  it('skips and logs a detail page with no JobPosting JSON-LD', async () => {
    const good = '/jobs/vacancy/good-1-sandton/2/description/';
    const bad = '/jobs/vacancy/bad-3-sandton/4/description/';
    const { impl } = routedFetch({
      [TEST_SITEMAP_URL]: () => new Response(stubSitemap([good, bad]), { status: 200 }),
      [`https://careers.example.co.za${good}`]: () =>
        new Response(stubDetailHtml('1'), { status: 200 }),
      [`https://careers.example.co.za${bad}`]: () =>
        new Response('<html><body>no ld+json</body></html>', { status: 200 }),
    });

    const logs: string[] = [];
    const raws = await fetchAllEarcu(TEST_CFG, { fetchImpl: impl, log: (m) => logs.push(m) });

    expect(raws.map((r) => r.jsonLd.title)).toEqual(['Role 1']);
    expect(logs.some((l) => l.includes('no JobPosting JSON-LD') && l.includes(bad))).toBe(true);
  });

  it('never fetches more than the safety cap of detail pages', async () => {
    const paths = Array.from(
      { length: 501 },
      (_, i) => `/jobs/vacancy/role-${i}-sandton/${i}/description/`,
    );
    const { impl, calls } = routedFetch({
      [TEST_SITEMAP_URL]: () => new Response(stubSitemap(paths), { status: 200 }),
      ...Object.fromEntries(
        paths.map((p) => [
          `https://careers.example.co.za${p}`,
          () => new Response(stubDetailHtml('1'), { status: 200 }),
        ]),
      ),
    });

    await fetchAllEarcu(TEST_CFG, { fetchImpl: impl });
    // 1 sitemap + SAFETY_CAP (500) detail pages, not all 501.
    expect(calls).toHaveLength(501);
  });
});

// ---------------------------------------------------------------------------
// applyUrl host guard (eArcu family). The apply link is the detail page's own
// canonical URL; a page whose canonical was tampered onto a foreign host makes
// normalize throw rather than surface a phishing link.
// ---------------------------------------------------------------------------

describe('investecAdapter.normalize — applyUrl host guard', () => {
  it('throws when the canonical apply URL is on a non-allowlisted host', () => {
    const hostile = structuredClone(raws[0]!);
    hostile.url = 'https://careers.investec.co.za.evil.example/jobs/vacancy/x/13805/description/';
    expect(() => investecAdapter.normalize(hostile)).toThrow(/not allowlisted/);
  });
});
