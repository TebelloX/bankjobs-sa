import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { nedbankAdapter } from '../src/index';
import { extractDatePosted, extractJobId, extractSfCanonicalUrl, parseFeed } from '../src/index';
import type { SfRawPosting } from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (committed feed.xml + detail HTML, loaded offline — never the
// network). The feed is the single load-bearing source; the detail pages enrich
// postedDate for the items they cover, matched by numeric job id exactly as the
// ingest pipeline does. `normalize` reads only {item, postedDate}, so it stays
// pure.
// ---------------------------------------------------------------------------

const fixturesDir = new URL('../../../fixtures/nedbank/', import.meta.url);

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixturesDir), 'utf8');
}

const feedItems = parseFeed(readFixture('feed.xml'));
const manifest = JSON.parse(readFixture('manifest.json')) as { totalAtCapture: number };

const detailFiles = readdirSync(fixturesDir)
  .filter((f) => /^detail-.*\.html$/.test(f))
  .sort();

// postedDate enrichment map, id → YYYY-MM-DD, built like loadSuccessFactorsFixtures.
const postedById = new Map<string, string>();
for (const file of detailFiles) {
  const html = readFixture(file);
  const url = extractSfCanonicalUrl(html);
  const id = url ? extractJobId(url) : null;
  const posted = extractDatePosted(html);
  if (id && posted) postedById.set(id, posted);
}

const raws: SfRawPosting[] = feedItems.map((item) => ({
  item,
  postedDate: postedById.get(item.id) ?? null,
}));

function jobFor(id: string): ReturnType<typeof nedbankAdapter.normalize> {
  const raw = raws.find((r) => r.item.id === id);
  if (!raw) throw new Error(`No feed item for id ${id}`);
  return nedbankAdapter.normalize(raw);
}

// A curated handful of pinned ids for snapshots (snapshotting all 77 would be
// unwieldy); the invariants below run over the whole feed.
const SNAPSHOT_IDS = ['1375204433', '1408728033', '1415472733'];

// ---------------------------------------------------------------------------
// (a) Feed parser — over the committed feed.
// ---------------------------------------------------------------------------

describe('successfactors feed parser', () => {
  it('parses every <item> (count matches the manifest)', () => {
    expect(feedItems.length).toBe(manifest.totalAtCapture);
    expect(feedItems.length).toBe(77);
  });

  it('decodes XML entities in plain-text fields and un-escapes the CDATA to real HTML', () => {
    const item = feedItems.find((i) => i.id === '1375204433');
    if (!item) throw new Error('missing pinned fixture item 1375204433');

    // g:job_function arrives as 'Administration &amp; Operations' — proven decoded.
    expect(item.jobFunction).toBe('Administration & Operations');
    // g:location is 'City, CC'.
    expect(item.location).toBe('Muldersdrift, ZA');

    // The description CDATA is double-encoded ('&lt;p&gt;…'); the parser un-escapes
    // it to real HTML, so real tags appear and no encoded '&lt;' survives.
    expect(item.description).toContain('<');
    expect(item.description).not.toContain('&lt;');
    expect(item.description).toContain('Requisition');
  });

  it('skips malformed items (no id or link) while keeping valid ones', () => {
    const xml =
      '<rss><channel>' +
      '<item><title>no id or link</title></item>' +
      '<item><title>Good</title><link>https://jobs.nedbank.co.za/job/X-Good/999/</link><g:id>999</g:id></item>' +
      '</channel></rss>';
    const parsed = parseFeed(xml);
    expect(parsed.map((i) => i.id)).toEqual(['999']);
  });
});

// ---------------------------------------------------------------------------
// (b) datePosted microdata extraction — over the committed detail pages.
// ---------------------------------------------------------------------------

describe('successfactors datePosted extraction', () => {
  it('parses the Java-toString datePosted microdata to YYYY-MM-DD', () => {
    const dates = detailFiles.map((f) => extractDatePosted(readFixture(f)));
    const present = dates.filter((d): d is string => d !== null);
    expect(present.length).toBeGreaterThanOrEqual(1);
    for (const d of present) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('returns null when a page carries no datePosted microdata (job still survives)', () => {
    // One committed detail page is a genuine live variant that renders NO
    // JobPosting microdata at all — the enrichment misses and yields null.
    const misses = detailFiles
      .map((f) => extractDatePosted(readFixture(f)))
      .filter((d) => d === null);
    expect(misses.length).toBeGreaterThanOrEqual(1);

    // A synthetic page with no meta, and a malformed content value, both → null.
    expect(
      extractDatePosted('<html><head><title>x</title></head><body>no meta</body></html>'),
    ).toBeNull();
    expect(extractDatePosted('<meta itemprop="datePosted" content="not a date">')).toBeNull();

    // The job whose detail page missed still normalizes, with postedDate null.
    const capeTown = jobFor('1415795833');
    expect(capeTown.postedDate).toBeNull();
    expect(capeTown.id).toBe('nedbank:1415795833');
  });
});

// ---------------------------------------------------------------------------
// (c) normalize — snapshots.
// ---------------------------------------------------------------------------

describe('nedbankAdapter.normalize — snapshots', () => {
  it.each(SNAPSHOT_IDS.map((id) => [id, id] as const))('normalizes %s', (_id, id) => {
    expect(nedbankAdapter.normalize(jobRaw(id))).toMatchSnapshot();
  });
});

function jobRaw(id: string): SfRawPosting {
  const raw = raws.find((r) => r.item.id === id);
  if (!raw) throw new Error(`No feed item for id ${id}`);
  return raw;
}

// ---------------------------------------------------------------------------
// (d) normalize — invariants over the whole feed.
// ---------------------------------------------------------------------------

describe('nedbankAdapter.normalize — invariants', () => {
  const jobs = raws.map((r) => nedbankAdapter.normalize(r));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^nedbank:\d+$/);
    expect(job.source).toBe('nedbank');
    expect(job.brand).toBe('Nedbank');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    expect(job.applyUrl.startsWith('https://jobs.nedbank.co.za/job/')).toBe(true);

    // The feed has no structured employment type.
    expect(job.employmentType).toBeNull();

    // Every fixture role is South African or Namibian.
    expect(['ZA', 'NA']).toContain(job.country);

    // postedDate is a real date (enriched) or null (enrichment missed).
    if (job.postedDate !== null) expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// (e) normalize — mapping-specific assertions.
// ---------------------------------------------------------------------------

describe('nedbankAdapter.normalize — mapping', () => {
  it('Johannesburg → ZA / Gauteng, Software & IT', () => {
    const job = jobFor('1408728033');
    expect(job.id).toBe('nedbank:1408728033');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Johannesburg');
    expect(job.locations[0]?.province).toBe('Gauteng');
    expect(job.primaryLocation).toBe('Johannesburg, Gauteng');
    expect(job.category).toBe('Software & IT');
    expect(job.applyUrl).toBe(
      'https://jobs.nedbank.co.za/job/Johannesburg-Software-Developer/1408728033/',
    );
  });

  it('Muldersdrift → ZA / Gauteng (a town added to the location table)', () => {
    const job = jobFor('1375204433');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Muldersdrift');
    expect(job.locations[0]?.province).toBe('Gauteng');
    expect(job.primaryLocation).toBe('Muldersdrift, Gauteng');
    // Enriched from a detail page that carries the datePosted microdata.
    expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('Mariental → NA from the ", CC" suffix, no SA location resolved', () => {
    const job = jobFor('1415472733');
    // Country comes from the ', NA' suffix, uppercased — not a silent ZA.
    expect(job.country).toBe('NA');
    // Mariental is Namibian, so the SA lookup does not resolve; the raw city shows.
    expect(job.locations[0]?.city).toBeNull();
    expect(job.locations[0]?.province).toBeNull();
    expect(job.primaryLocation).toBe('Mariental');
    expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('Cape Town → ZA / Western Cape', () => {
    const job = jobFor('1415795833');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Cape Town');
    expect(job.locations[0]?.province).toBe('Western Cape');
    expect(job.primaryLocation).toBe('Cape Town, Western Cape');
  });
});
