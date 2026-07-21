import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { discoveryAdapter } from '../src/index';
import { extractSfCanonicalUrl, parseSitemap, parseSitemapDetail } from '../src/index';
import type { SfSitemapPosting } from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (committed sitemap.xml + detail HTML, loaded offline — never the
// network). On the sitemap path the DETAIL pages are the load-bearing source:
// each is parsed into a structured posting (its own canonical link supplies the
// URL), exactly as the ingest fixtures loader does. `normalize` reads only the
// SfSitemapPosting, so it stays pure. The committed set deliberately mixes
// Discovery Bank roles with non-bank roles so the business-unit filter has a
// real negative case.
// ---------------------------------------------------------------------------

const fixturesDir = new URL('../../../fixtures/discovery/', import.meta.url);

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixturesDir), 'utf8');
}

const sitemapUrls = parseSitemap(readFixture('sitemap.xml'));
const manifest = JSON.parse(readFixture('manifest.json')) as {
  totalAtCapture: number;
  bankAtCapture: number;
};

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

const BANK = 'Discovery Bank';
const bankPostings = allPostings.filter((p) => p.businessUnit.trim() === BANK);

function postingFor(jobId: string): SfSitemapPosting {
  const p = allPostings.find((r) => r.jobId === jobId);
  if (!p) throw new Error(`No committed posting for jobId ${jobId}`);
  return p;
}

function jobFor(jobId: string): ReturnType<typeof discoveryAdapter.normalize> {
  return discoveryAdapter.normalize(postingFor(jobId));
}

// The two committed Discovery Bank roles (snapshotting the whole group would be
// unwieldy and off-brand); invariants below run over every bank posting.
const SNAPSHOT_IDS = ['1415847033', '1415675533'];

// ---------------------------------------------------------------------------
// (a) Sitemap parser — over the committed sitemap.
// ---------------------------------------------------------------------------

describe('successfactors sitemap parser', () => {
  it('parses every <loc> job URL (count matches the manifest)', () => {
    expect(sitemapUrls.length).toBe(manifest.totalAtCapture);
    expect(sitemapUrls.length).toBe(48);
    for (const url of sitemapUrls) {
      expect(url).toMatch(/^https:\/\/careers\.discovery\.co\.za\/job\/.+\/\d+\/$/);
    }
  });

  it('keeps only job detail URLs, dropping non-job <loc>s', () => {
    const xml =
      '<urlset>' +
      '<url><loc>https://careers.discovery.co.za/</loc></url>' +
      '<url><loc>https://careers.discovery.co.za/job/Sandton-Good/999/</loc></url>' +
      '<url><loc>https://careers.discovery.co.za/sitemap.xml</loc></url>' +
      '</urlset>';
    expect(parseSitemap(xml)).toEqual(['https://careers.discovery.co.za/job/Sandton-Good/999/']);
  });
});

// ---------------------------------------------------------------------------
// (b) Detail parser — field extraction over the committed pages.
// ---------------------------------------------------------------------------

describe('successfactors detail parser', () => {
  it('extracts every field from a Discovery Bank detail page', () => {
    const p = postingFor('1415847033');
    expect(p.title).toBe('Collections Manager');
    expect(p.businessUnit).toBe('Discovery Bank');
    expect(p.jobFunction).toBe('Banking');
    expect(p.locality).toBe('Sandton - 1 Discovery Place');
    expect(p.country).toBe('ZA');
    expect(p.postedDate).toBe('2026-07-16');
    expect(p.url).toBe(
      'https://careers.discovery.co.za/job/Sandton-1-Discovery-Place-Collections-Manager-GP-2196/1415847033/',
    );
    // Description is real HTML captured whole across its nested spans.
    expect(p.description).toContain('<p');
    expect(p.description.length).toBeGreaterThan(500);
  });

  it('reads the Business Unit of each committed brand (only customfield1 carries it)', () => {
    const byId = new Map(allPostings.map((p) => [p.jobId, p.businessUnit]));
    expect(byId.get('1415847033')).toBe('Discovery Bank');
    expect(byId.get('1415675533')).toBe('Discovery Bank');
    // The two non-bank fixtures carry other brands — proven present so the
    // filter test below has a genuine negative.
    const others = allPostings
      .filter((p) => p.businessUnit.trim() !== BANK)
      .map((p) => p.businessUnit.trim());
    expect(others.length).toBeGreaterThanOrEqual(1);
    expect(others).not.toContain(BANK);
  });

  it('returns null when the URL carries no numeric job id (critical field)', () => {
    expect(
      parseSitemapDetail(readFixture('detail-1.html'), 'https://careers.discovery.co.za/talent/'),
    ).toBeNull();
  });

  it('returns null when the page has no title span (critical field)', () => {
    expect(
      parseSitemapDetail(
        '<html><body>a page with no CSB fields at all</body></html>',
        'https://careers.discovery.co.za/job/Whatever/123/',
      ),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) The business-unit filter — bank kept, non-bank dropped (real fixtures).
// ---------------------------------------------------------------------------

describe('discovery business-unit filter', () => {
  it('keeps exactly the Discovery Bank roles and drops the rest', () => {
    expect(allPostings.length).toBe(detailFiles.length);
    expect(allPostings.length).toBeGreaterThan(bankPostings.length); // negatives present
    expect(bankPostings.map((p) => p.jobId).sort()).toEqual(['1415675533', '1415847033']);
    for (const p of bankPostings) expect(p.businessUnit.trim()).toBe(BANK);
  });
});

// ---------------------------------------------------------------------------
// (d) normalize — snapshots (the two bank roles).
// ---------------------------------------------------------------------------

describe('discoveryAdapter.normalize — snapshots', () => {
  it.each(SNAPSHOT_IDS.map((id) => [id, id] as const))('normalizes %s', (_id, id) => {
    expect(discoveryAdapter.normalize(postingFor(id))).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// (e) normalize — invariants over every bank posting.
// ---------------------------------------------------------------------------

describe('discoveryAdapter.normalize — invariants', () => {
  const jobs = bankPostings.map((p) => discoveryAdapter.normalize(p));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^discovery:\d+$/);
    expect(job.source).toBe('discovery');
    expect(job.brand).toBe('Discovery Bank');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<span');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    expect(job.applyUrl.startsWith('https://careers.discovery.co.za/job/')).toBe(true);

    // Nothing structured on the page provides employment type.
    expect(job.employmentType).toBeNull();

    // Every committed bank role is South African.
    expect(job.country).toBe('ZA');

    // These dates are real; postedDate is a date or null (tolerant).
    if (job.postedDate !== null) expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// (f) normalize — mapping-specific assertions.
// ---------------------------------------------------------------------------

describe('discoveryAdapter.normalize — mapping', () => {
  it('Collections Manager → ZA / Sandton / Gauteng, Credit & Lending', () => {
    const job = jobFor('1415847033');
    expect(job.id).toBe('discovery:1415847033');
    expect(job.country).toBe('ZA');
    // The locality combines suburb + building; normalizeLocation still resolves it.
    expect(job.locations[0]?.city).toBe('Sandton');
    expect(job.locations[0]?.province).toBe('Gauteng');
    expect(job.primaryLocation).toBe('Sandton, Gauteng');
    expect(job.category).toBe('Credit & Lending'); // 'Collections' in the title
    expect(job.postedDate).toBe('2026-07-16');
    expect(job.applyUrl).toBe(
      'https://careers.discovery.co.za/job/Sandton-1-Discovery-Place-Collections-Manager-GP-2196/1415847033/',
    );
  });

  it('folds the Function field into the categorize haystack', () => {
    // A title that alone categorizes to 'Other' is pushed into 'Risk &
    // Compliance' purely by the Function field — proving the fold-in.
    const base = postingFor('1415847033');
    const withFunction: SfSitemapPosting = {
      ...base,
      title: 'Consultant',
      jobFunction: 'Risk Management',
    };
    const withoutFunction: SfSitemapPosting = { ...base, title: 'Consultant', jobFunction: '' };
    expect(discoveryAdapter.normalize(withFunction).category).toBe('Risk & Compliance');
    expect(discoveryAdapter.normalize(withoutFunction).category).toBe('Other');
  });

  it('throws AdapterNormalizeError when the jobId is missing', () => {
    const base = postingFor('1415847033');
    expect(() => discoveryAdapter.normalize({ ...base, jobId: '' })).toThrow(/missing jobId/);
  });
});
