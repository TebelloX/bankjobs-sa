import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { capitecAdapter } from '../src/index';
import { extractSfCanonicalUrl, parseSitemap, parseSitemapDetail } from '../src/index';
import type { SfSitemapPosting } from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (committed sitemap.xml + detail HTML, loaded offline — never the
// network). On the sitemap path the DETAIL pages are the load-bearing source:
// each is parsed into a structured posting (its own canonical link supplies the
// URL), exactly as the ingest fixtures loader does. `normalize` reads only the
// SfSitemapPosting, so it stays pure. Capitec is a SINGLE-BRAND tenant — every
// posting is kept, there is no business-unit filter. The committed set spans
// both address shapes (a structured addressLocality role and streetAddress
// roles, incl. a bare-"ZA" locationless pipeline role) and the title-as-element
// microdata that distinguishes Capitec's pages from Discovery's labelled spans.
// ---------------------------------------------------------------------------

const fixturesDir = new URL('../../../fixtures/capitec/', import.meta.url);

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixturesDir), 'utf8');
}

const sitemapUrls = parseSitemap(readFixture('sitemap.xml'));
const manifest = JSON.parse(readFixture('manifest.json')) as { totalAtCapture: number };

const detailFiles = readdirSync(fixturesDir)
  .filter((f) => /^detail-.*\.html$/.test(f))
  .sort();

const allPostings: SfSitemapPosting[] = [];
for (const file of detailFiles) {
  const html = readFixture(file);
  const url = extractSfCanonicalUrl(html);
  if (url === null) continue;
  const posting = parseSitemapDetail(html, url);
  if (posting) allPostings.push(posting);
}

function postingFor(jobId: string): SfSitemapPosting {
  const p = allPostings.find((r) => r.jobId === jobId);
  if (!p) throw new Error(`No committed posting for jobId ${jobId}`);
  return p;
}

function jobFor(jobId: string): ReturnType<typeof capitecAdapter.normalize> {
  return capitecAdapter.normalize(postingFor(jobId));
}

// Snapshot three of the four committed roles: a streetAddress corporate role
// (Software & IT), a structured-address Sales banker (city→province), and the
// bare-"ZA" locationless pipeline banker. Invariants below run over all four.
const SNAPSHOT_IDS = ['1387530633', '1414947533', '1406793133'];

// ---------------------------------------------------------------------------
// (a) Sitemap parser — over the committed sitemap.
// ---------------------------------------------------------------------------

describe('capitec sitemap parser', () => {
  it('parses every <loc> job URL (count matches the manifest)', () => {
    expect(sitemapUrls.length).toBe(manifest.totalAtCapture);
    expect(sitemapUrls.length).toBe(51);
    for (const url of sitemapUrls) {
      expect(url).toMatch(/^https:\/\/careers\.capitecbank\.co\.za\/job\/.+\/\d+\/$/);
    }
  });

  it('keeps only job detail URLs, dropping any non-job <loc>s', () => {
    const xml =
      '<urlset>' +
      '<url><loc>https://careers.capitecbank.co.za/</loc></url>' +
      '<url><loc>https://careers.capitecbank.co.za/job/Stellenbosch-Good/999/</loc></url>' +
      '<url><loc>https://careers.capitecbank.co.za/viewalljobs/</loc></url>' +
      '</urlset>';
    expect(parseSitemap(xml)).toEqual([
      'https://careers.capitecbank.co.za/job/Stellenbosch-Good/999/',
    ]);
  });
});

// ---------------------------------------------------------------------------
// (b) Detail parser — field extraction over the committed pages. Capitec's
// title is schema.org ELEMENT microdata and it carries NO labelled CSB fields,
// so businessUnit/jobFunction are always empty (single-brand tenant).
// ---------------------------------------------------------------------------

describe('capitec detail parser', () => {
  it('extracts the title from element microdata (no labelled CSB spans)', () => {
    const p = postingFor('1387530633');
    expect(p.title).toBe('Analytics Engineer II');
    // Single-brand tenant: no business-unit / function labelled spans exist.
    expect(p.businessUnit).toBe('');
    expect(p.jobFunction).toBe('');
    expect(p.country).toBe('ZA');
    expect(p.postedDate).toBe('2026-07-16');
    expect(p.url).toBe(
      'https://careers.capitecbank.co.za/job/Stellenbosch-Analytics-Engineer-II/1387530633/',
    );
    // Description is real HTML captured whole across its nested spans.
    expect(p.description).toContain('<p');
    expect(p.description.length).toBeGreaterThan(500);
  });

  it('reads the two address shapes: structured vs streetAddress vs bare "ZA"', () => {
    // structured addressLocality microdata → clean city.
    expect(postingFor('1414947533').locality).toBe('East London');
    // streetAddress "Stellenbosch, ZA" → city with the country stripped.
    expect(postingFor('1387530633').locality).toBe('Stellenbosch');
    // bare "ZA" (nationwide/pipeline) → no city, but still country ZA.
    const pipeline = postingFor('1406793133');
    expect(pipeline.locality).toBe('');
    expect(pipeline.country).toBe('ZA');
    // Every committed posting resolves the country to ZA.
    for (const p of allPostings) expect(p.country).toBe('ZA');
  });

  it('returns null when the URL carries no numeric job id (critical field)', () => {
    expect(
      parseSitemapDetail(readFixture('detail-1.html'), 'https://careers.capitecbank.co.za/talent/'),
    ).toBeNull();
  });

  it('returns null when the page has no title microdata (critical field)', () => {
    expect(
      parseSitemapDetail(
        '<html><body>a page with no title microdata at all</body></html>',
        'https://careers.capitecbank.co.za/job/Whatever/123/',
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) normalize — snapshots.
// ---------------------------------------------------------------------------

describe('capitecAdapter.normalize — snapshots', () => {
  it.each(SNAPSHOT_IDS.map((id) => [id, id] as const))('normalizes %s', (_id, id) => {
    expect(capitecAdapter.normalize(postingFor(id))).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// (d) normalize — invariants over every committed posting.
// ---------------------------------------------------------------------------

describe('capitecAdapter.normalize — invariants', () => {
  const jobs = allPostings.map((p) => capitecAdapter.normalize(p));

  it('every committed detail page parsed to a posting', () => {
    expect(allPostings.length).toBe(detailFiles.length);
    expect(allPostings.length).toBe(4);
  });

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^capitec:\d+$/);
    expect(job.source).toBe('capitec');
    expect(job.brand).toBe('Capitec');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<span');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    expect(job.applyUrl.startsWith('https://careers.capitecbank.co.za/job/')).toBe(true);

    // Nothing structured on the page provides employment type.
    expect(job.employmentType).toBeNull();

    // Every committed role is South African.
    expect(job.country).toBe('ZA');

    // These dates are real; postedDate is a date or null (tolerant).
    if (job.postedDate !== null) expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// (e) normalize — mapping-specific assertions.
// ---------------------------------------------------------------------------

describe('capitecAdapter.normalize — mapping', () => {
  it('streetAddress corporate role → ZA / Stellenbosch / Western Cape, Software & IT', () => {
    const job = jobFor('1387530633');
    expect(job.id).toBe('capitec:1387530633');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Stellenbosch');
    expect(job.locations[0]?.province).toBe('Western Cape');
    expect(job.primaryLocation).toBe('Stellenbosch, Western Cape');
    // 'engineer' (Software & IT) outranks 'analytics' by rule order.
    expect(job.category).toBe('Software & IT');
    expect(job.postedDate).toBe('2026-07-16');
  });

  it('structured-address banker → ZA / East London / Eastern Cape, Sales (city→province)', () => {
    const job = jobFor('1414947533');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('East London');
    expect(job.locations[0]?.province).toBe('Eastern Cape');
    expect(job.primaryLocation).toBe('East London, Eastern Cape');
    // 'banker' → Sales (Capitec's frontline/relationship roles).
    expect(job.category).toBe('Sales');
  });

  it('bare-"ZA" pipeline banker → locationless, country ZA, Sales', () => {
    const job = jobFor('1406793133');
    expect(job.country).toBe('ZA');
    // No city is invented for a nationwide/pipeline role.
    expect(job.locations).toEqual([]);
    expect(job.primaryLocation).toBeNull();
    expect(job.category).toBe('Sales');
  });

  it('graduate/internship programme → Other (whatever the rules produce)', () => {
    const job = jobFor('1405951133');
    expect(job.title).toBe('Capitec Internship Programme 2027');
    expect(job.category).toBe('Other');
    expect(job.locations[0]?.province).toBe('Western Cape');
  });

  it("future-proofs Capitec's frontline title 'Bank Better Champion' → Branch & Retail", () => {
    // No such role is live today, but the per-source rule categorizes it the
    // moment it appears (global rules alone would land it in 'Other').
    const base = postingFor('1387530633');
    const champion: SfSitemapPosting = { ...base, title: 'Bank Better Champion' };
    expect(capitecAdapter.normalize(champion).category).toBe('Branch & Retail');
  });

  it('throws AdapterNormalizeError when the jobId is missing', () => {
    const base = postingFor('1387530633');
    expect(() => capitecAdapter.normalize({ ...base, jobId: '' })).toThrow(/missing jobId/);
  });
});
