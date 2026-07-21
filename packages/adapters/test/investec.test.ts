import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { investecAdapter } from '../src/index';
import {
  extractCanonicalUrl,
  extractDetailUrls,
  extractJobPostingLd,
  extractPagestamp,
} from '../src/index';
import type { EarcuRawPosting } from '../src/index';

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
  it('detail-1 (Product Analyst, Cape Town) → ZA / Western Cape, Full-time', () => {
    const job = jobForReq('13787');
    expect(job.id).toBe('investec:13787');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Cape Town');
    expect(job.locations[0]?.province).toBe('Western Cape');
    expect(job.primaryLocation).toBe('Cape Town, Western Cape');
    expect(job.employmentType).toBe('Full-time');
    expect(job.applyUrl).toBe(
      'https://careers.investec.co.za/jobs/vacancy/product-analyst-13787-cape-town/13805/description/',
    );
  });

  it('detail-2 (Sandton) → ZA / Gauteng from the Johannesburg locality', () => {
    const job = jobForReq('13749');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Johannesburg');
    expect(job.locations[0]?.province).toBe('Gauteng');
    expect(job.primaryLocation).toBe('Johannesburg, Gauteng');
  });

  it('detail-3 (empty JSON-LD address) → still ZA, but no resolved location', () => {
    const job = jobForReq('12158');
    expect(job.country).toBe('ZA');
    expect(job.locations).toEqual([]);
    expect(job.primaryLocation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Client HTML extraction (pure, against the committed grid + detail fixtures).
// ---------------------------------------------------------------------------

describe('eArcu client extraction', () => {
  it('pulls every detail-page URL out of the grid fragment, absolute + deduped', () => {
    const grid = readFixture('grid.html');
    const urls = extractDetailUrls(grid, 'https://careers.investec.co.za');

    expect(urls.length).toBe(5);
    expect(new Set(urls).size).toBe(urls.length);
    for (const u of urls) {
      expect(u).toMatch(
        /^https:\/\/careers\.investec\.co\.za\/jobs\/vacancy\/[^\s"']+\/\d+\/description\/$/,
      );
    }
    expect(urls).toContain(
      'https://careers.investec.co.za/jobs/vacancy/product-analyst-13787-cape-town/13805/description/',
    );
  });

  it('extracts and parses the JobPosting JSON-LD from a detail page', () => {
    const posting = extractJobPostingLd(readFixture('detail-1.html'));
    expect(posting).not.toBeNull();
    expect(posting?.['@type']).toBe('JobPosting');
    expect(posting?.title).toBe('Product Analyst');
  });

  it('returns null when a page carries no JobPosting JSON-LD', () => {
    expect(extractJobPostingLd('<html><body>no ld+json here</body></html>')).toBeNull();
  });

  it('reads the per-load pagestamp from the results-page HTML', () => {
    // A minimal stand-in for the results page (the real one is not committed;
    // its pagestamp rotates every load and is useless as ground truth).
    const html =
      '<a href="/jobs/vacancy/find/results/ajaxaction/posbrowser_gridhandler/?pagestamp=653b774a-4a75-47d1-93fd-03da33100baf">grid</a>';
    expect(extractPagestamp(html)).toBe('653b774a-4a75-47d1-93fd-03da33100baf');
    expect(extractPagestamp('<html>no stamp</html>')).toBeNull();
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
