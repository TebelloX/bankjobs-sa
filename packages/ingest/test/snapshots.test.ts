import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CanonicalJob } from '@bankjobs/core';
import { openLocalDb } from '../src/db';
import { upsertJobs } from '../src/diff';
import { emitSnapshots } from '../src/snapshots';

const NOW = '2026-07-10T00:00:00.000Z';

function makeJob(overrides: Partial<CanonicalJob>): CanonicalJob {
  return {
    id: 'absa:R-0',
    source: 'absa',
    brand: 'Absa',
    title: 'Job',
    category: 'Other',
    employmentType: 'Full time',
    descriptionHtml: '<p>Work here.</p>',
    descriptionText: 'Work here.',
    excerpt: 'Work here.',
    primaryLocation: null,
    locations: [],
    country: 'ZA',
    applyUrl: 'https://absa.wd3.myworkdayjobs.com/apply',
    postedDate: null,
    ...overrides,
  };
}

const dir = mkdtempSync(join(tmpdir(), 'bankjobs-snap-'));

const db = openLocalDb(':memory:');
upsertJobs(
  db,
  'absa',
  [
    makeJob({
      id: 'absa:R-1',
      title: 'Branch Teller',
      category: 'Branch & Retail',
      country: 'ZA',
      postedDate: '2026-07-05',
      primaryLocation: 'Johannesburg, Gauteng',
      locations: [{ city: 'Johannesburg', province: 'Gauteng', raw: 'Johannesburg' }],
    }),
    makeJob({
      id: 'absa:R-2',
      title: 'Backend Engineer',
      category: 'Software & IT',
      country: 'ZA',
      postedDate: '2026-07-08',
      primaryLocation: 'Cape Town, Western Cape',
      locations: [{ city: 'Cape Town', province: 'Western Cape', raw: 'Cape Town' }],
    }),
    makeJob({
      id: 'absa:R-3',
      title: 'Information Risk Manager',
      category: 'Risk & Compliance',
      country: 'SC',
      postedDate: '2026-07-01',
      primaryLocation: 'Grand Anse',
      locations: [{ city: null, province: null, raw: 'Grand Anse' }],
    }),
    makeJob({
      id: 'absa:R-4',
      title: 'Sales Consultant',
      category: 'Sales',
      country: 'ZA',
      postedDate: null,
      primaryLocation: 'Durban, KwaZulu-Natal',
      locations: [{ city: 'Durban', province: 'KwaZulu-Natal', raw: 'Durban' }],
    }),
  ],
  NOW,
);
emitSnapshots(db, dir, NOW);
db.close();

function readJson<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(dir, ...parts), 'utf8')) as T;
}

interface LeanRow {
  id: string;
  slug: string;
  title: string;
  category: string;
  categorySlug: string;
  city: string | null;
  province: string | null;
  country: string;
  postedDate: string | null;
}

describe('emitSnapshots', () => {
  it('writes the full contracted file set', () => {
    expect(() => readFileSync(join(dir, 'public', 'data', 'jobs.json'))).not.toThrow();
    expect(() => readFileSync(join(dir, 'public', 'data', 'meta.json'))).not.toThrow();
    expect(() => readFileSync(join(dir, 'src', 'data', 'jobs-full.json'))).not.toThrow();
    const categoryFiles = readdirSync(join(dir, 'public', 'data', 'category'));
    expect(categoryFiles.length).toBe(10);
    expect(categoryFiles).toContain('software-it.json');
  });

  it('orders jobs.json by postedDate desc with nulls last and correct shape', () => {
    const rows = readJson<LeanRow[]>('public', 'data', 'jobs.json');
    expect(rows.map((r) => r.id)).toEqual(['absa:R-2', 'absa:R-1', 'absa:R-3', 'absa:R-4']);

    const first = rows[0];
    expect(first?.slug).toBe('absa-r-2');
    expect(first?.categorySlug).toBe('software-it');
    expect(first?.city).toBe('Cape Town');
    expect(first?.province).toBe('Western Cape');

    const intl = rows.find((r) => r.id === 'absa:R-3');
    expect(intl?.country).toBe('SC');
    expect(intl?.city).toBeNull();
    expect(intl?.province).toBeNull();
  });

  it('reports SA vs international counts and rollups in meta.json', () => {
    const meta = readJson<{
      generatedAt: string;
      totalOpen: number;
      totalSA: number;
      totalInternational: number;
      sources: { id: string; name: string; count: number; lastSuccessAt: string | null }[];
      categories: Record<string, number>;
      provinces: Record<string, number>;
    }>('public', 'data', 'meta.json');

    expect(meta.generatedAt).toBe(NOW);
    expect(meta.totalOpen).toBe(4);
    expect(meta.totalSA).toBe(3);
    expect(meta.totalInternational).toBe(1);

    const absa = meta.sources.find((s) => s.id === 'absa');
    expect(absa?.count).toBe(4);
    // absa, firstrand, standardbank, investec, gotyme all present (gotyme is
    // seeded disabled but still a sources row, so it appears with count 0).
    expect(meta.sources.length).toBe(5);

    expect(Object.keys(meta.categories).length).toBe(10);
    expect(meta.categories['software-it']).toBe(1);
    expect(meta.categories['branch-retail']).toBe(1);
    expect(meta.categories['other']).toBe(0);

    // Only SA provinces with >0; the Seychelles job contributes none.
    expect(meta.provinces['Gauteng']).toBe(1);
    expect(meta.provinces['Western Cape']).toBe(1);
    expect(meta.provinces['KwaZulu-Natal']).toBe(1);
  });

  it('includes full records with descriptionHtml and slug in jobs-full.json', () => {
    const full = readJson<
      { id: string; slug: string; descriptionHtml: string; categorySlug: string }[]
    >('src', 'data', 'jobs-full.json');
    expect(full.length).toBe(4);
    const first = full[0];
    expect(first?.descriptionHtml).toContain('<p>');
    expect(first?.slug).toBe('absa-r-2');
    expect(first?.categorySlug).toBe('software-it');
  });

  it('filters category files to their category', () => {
    const softwareIt = readJson<LeanRow[]>('public', 'data', 'category', 'software-it.json');
    expect(softwareIt.map((r) => r.id)).toEqual(['absa:R-2']);
    const other = readJson<LeanRow[]>('public', 'data', 'category', 'other.json');
    expect(other).toEqual([]);
  });
});
