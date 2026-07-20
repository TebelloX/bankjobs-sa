import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { standardbankAdapter } from '../src/index';
import type { SrListResponse, SrPostingDetail, SrRawPosting } from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (loaded offline, never the network).
// ---------------------------------------------------------------------------

function loadFixture<T>(name: string): T {
  const url = new URL(`../../../fixtures/standardbank/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

const list = loadFixture<SrListResponse>('list-page1.json');
const details = [1, 2, 3].map((n) => loadFixture<SrPostingDetail>(`detail-${n}.json`));

/** Pair each detail with its list item by id (the detail is itself a superset). */
function pairFor(detail: SrPostingDetail): SrRawPosting {
  const listItem = list.content.find((p) => p.id === detail.id) ?? detail;
  return { listItem, detail };
}

const pairs = details.map(pairFor);

function jobFor(id: string): ReturnType<typeof standardbankAdapter.normalize> {
  const pair = pairs.find((p) => p.detail.id === id);
  if (!pair) throw new Error(`No fixture pair for ${id}`);
  return standardbankAdapter.normalize(pair);
}

// ---------------------------------------------------------------------------
// Snapshots.
// ---------------------------------------------------------------------------

describe('standardbankAdapter.normalize — snapshots', () => {
  it.each(pairs.map((p) => [p.detail.id, p] as const))('normalizes %s', (_id, raw) => {
    expect(standardbankAdapter.normalize(raw)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// Invariants that must hold for every fixture.
// ---------------------------------------------------------------------------

describe('standardbankAdapter.normalize — invariants', () => {
  const jobs = pairs.map((p) => standardbankAdapter.normalize(p));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^standardbank:\d+$/);
    expect(job.source).toBe('standardbank');
    expect(job.brand).toBe('Standard Bank');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    expect(job.applyUrl.startsWith('https://jobs.smartrecruiters.com/')).toBe(true);
    expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Fixture-specific mapping.
// ---------------------------------------------------------------------------

describe('standardbankAdapter.normalize — mapping', () => {
  it('detail-1 (Johannesburg) → ZA / Gauteng, Full-time, dated releasedDate', () => {
    const job = jobFor('744000138643793');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Johannesburg');
    expect(job.locations[0]?.province).toBe('Gauteng');
    expect(job.primaryLocation).toBe('Johannesburg, Gauteng');
    expect(job.employmentType).toBe('Full-time');
    expect(job.postedDate).toBe('2026-07-20');
  });

  it('detail-3 (Douglas, Isle of Man) → IM with a city fallback primaryLocation', () => {
    const job = jobFor('744000138697014');
    expect(job.country).toBe('IM');
    expect(job.primaryLocation).toBe('Douglas');
  });

  it('descriptionHtml keeps jobDescription + qualifications but drops the company boilerplate', () => {
    const job = jobFor('744000138643793');
    // From the jobDescription section:
    expect(job.descriptionHtml).toContain('high-performance culture');
    // From the qualifications section:
    expect(job.descriptionHtml).toContain('FAIS Representative');
    // The companyDescription boilerplate must NOT survive.
    expect(job.descriptionHtml).not.toContain('career-enhancing opportunities');
  });
});
