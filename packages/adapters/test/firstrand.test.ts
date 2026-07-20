import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { firstrandAdapter } from '../src/index';
import type {
  WorkdayJobDetail,
  WorkdayListPosting,
  WorkdayListResponse,
  WorkdayRawPosting,
} from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (loaded offline, never the network).
// ---------------------------------------------------------------------------

function loadFixture<T>(name: string): T {
  const url = new URL(`../../../fixtures/firstrand/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

const list = loadFixture<WorkdayListResponse>('list-page1.json');
const details = [1, 2, 3, 4].map((n) => loadFixture<WorkdayJobDetail>(`detail-${n}.json`));

// detail-3 (R51496) is a WesBank posting captured from a later page than the
// committed list-page1, so its list item isn't in the fixture. Supply the real
// shape (brand is always the LAST bulletField) so sub-brand attribution — the
// whole point of this source — can be exercised deterministically.
const R51496_LIST_ITEM: WorkdayListPosting = {
  title: 'Lend Deal Maker (Gauteng)',
  externalPath: '/job/Randburg/Lend-Deal-Maker--Gauteng-_R51496',
  bulletFields: ['Randburg', 'South Africa', 'R51496', 'WesBank'],
};

/** Pair each detail with the list item whose bulletFields contain its reqId. */
function pairFor(detail: WorkdayJobDetail): WorkdayRawPosting {
  const reqId = detail.jobPostingInfo.jobReqId;
  const listItem =
    list.jobPostings.find((p) => p.bulletFields.includes(reqId)) ??
    (reqId === 'R51496' ? R51496_LIST_ITEM : undefined);
  if (!listItem) throw new Error(`No list item for jobReqId ${reqId}`);
  return { listItem, detail };
}

const pairs = details.map(pairFor);

function jobFor(reqId: string): ReturnType<typeof firstrandAdapter.normalize> {
  const pair = pairs.find((p) => p.detail.jobPostingInfo.jobReqId === reqId);
  if (!pair) throw new Error(`No fixture pair for ${reqId}`);
  return firstrandAdapter.normalize(pair);
}

// ---------------------------------------------------------------------------
// Snapshots.
// ---------------------------------------------------------------------------

describe('firstrandAdapter.normalize — snapshots', () => {
  it.each(pairs.map((p) => [p.detail.jobPostingInfo.jobReqId, p] as const))(
    'normalizes %s',
    (_reqId, raw) => {
      expect(firstrandAdapter.normalize(raw)).toMatchSnapshot();
    },
  );
});

// ---------------------------------------------------------------------------
// Invariants that must hold for every fixture.
// ---------------------------------------------------------------------------

describe('firstrandAdapter.normalize — invariants', () => {
  const jobs = pairs.map((p) => firstrandAdapter.normalize(p));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^firstrand:R\d+$/);
    expect(job.source).toBe('firstrand');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    expect(job.applyUrl.startsWith('https://firstrand.wd3.myworkdayjobs.com/')).toBe(true);
    expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Sub-brand attribution — the reason this source exists.
// ---------------------------------------------------------------------------

describe('firstrandAdapter.normalize — brand attribution', () => {
  it('detail-1 → FNB', () => expect(jobFor('R49624').brand).toBe('FNB'));
  it('detail-2 → RMB', () => expect(jobFor('R41608').brand).toBe('RMB'));
  it('detail-3 → WesBank', () => expect(jobFor('R51496').brand).toBe('WesBank'));
  it('detail-4 → FNB', () => expect(jobFor('R51835').brand).toBe('FNB'));

  it('falls back to FirstRand when the last bulletField is not a known sub-brand', () => {
    const fabricated = structuredClone(pairs[0]!);
    fabricated.listItem.bulletFields = ['Somewhere', 'South Africa', 'R49624', 'MysteryBrand'];
    expect(firstrandAdapter.normalize(fabricated).brand).toBe('FirstRand');
  });

  it('falls back to FirstRand when there are no bulletFields at all', () => {
    const fabricated = structuredClone(pairs[0]!);
    fabricated.listItem.bulletFields = [];
    expect(firstrandAdapter.normalize(fabricated).brand).toBe('FirstRand');
  });
});

// ---------------------------------------------------------------------------
// Location & country mapping.
// ---------------------------------------------------------------------------

describe('firstrandAdapter.normalize — location & country', () => {
  it('detail-1 (Bellville) resolves to ZA / Western Cape', () => {
    const job = jobFor('R49624');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Bellville');
    expect(job.locations[0]?.province).toBe('Western Cape');
    expect(job.primaryLocation).toBe('Bellville, Western Cape');
  });

  it('detail-4 (Ezulwini) resolves to Eswatini (SZ) and keeps the raw location', () => {
    const job = jobFor('R51835');
    expect(job.country).toBe('SZ');
    expect(job.locations[0]?.city).toBeNull();
    expect(job.locations[0]?.province).toBeNull();
  });
});
