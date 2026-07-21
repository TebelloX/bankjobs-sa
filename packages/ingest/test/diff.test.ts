import { describe, expect, it } from 'vitest';
import type { CanonicalJob } from '@bankjobs/core';
import { openLocalDb } from '../src/db';
import type { JobsDb } from '../src/db';
import { closeAbsentees, upsertJobs } from '../src/diff';

const T1 = '2026-07-01T00:00:00.000Z';
const T2 = '2026-07-02T00:00:00.000Z';
const T3 = '2026-07-03T00:00:00.000Z';
const T4 = '2026-07-04T00:00:00.000Z';

function makeJob(overrides: Partial<CanonicalJob> = {}): CanonicalJob {
  return {
    id: 'absa:R-1',
    source: 'absa',
    brand: 'Absa',
    title: 'Teller',
    category: 'Branch & Retail',
    employmentType: 'Full time',
    descriptionHtml: '<p>Serve customers.</p>',
    descriptionText: 'Serve customers.',
    excerpt: 'Serve customers.',
    primaryLocation: 'Johannesburg, Gauteng',
    locations: [{ city: 'Johannesburg', province: 'Gauteng', raw: 'Johannesburg' }],
    country: 'ZA',
    applyUrl: 'https://absa.wd3.myworkdayjobs.com/apply/R-1',
    postedDate: '2026-06-30',
    ...overrides,
  };
}

interface JobDbRow {
  title: string;
  status: string;
  missed_runs: number;
  first_seen: string;
  last_seen: string;
  updated_at: string;
  closed_at: string | null;
  content_hash: string;
}

function jobRow(db: JobsDb, id: string): Promise<JobDbRow | undefined> {
  return db.get<JobDbRow>('SELECT * FROM jobs WHERE id = ?', [id]);
}

describe('upsertJobs', () => {
  it('inserts a new job with every field populated', async () => {
    const db = openLocalDb(':memory:');
    const result = await upsertJobs(db, 'absa', [makeJob()], T1);
    expect(result).toEqual({ seen: 1, inserted: 1, updated: 0, unchangedContent: 0 });

    const row = await jobRow(db, 'absa:R-1');
    expect(row?.title).toBe('Teller');
    expect(row?.status).toBe('open');
    expect(row?.missed_runs).toBe(0);
    expect(row?.first_seen).toBe(T1);
    expect(row?.last_seen).toBe(T1);
    expect(row?.updated_at).toBe(T1);
    expect(row?.closed_at).toBeNull();
    expect(row?.content_hash).toBeTruthy();

    const locs = await db.all<{ city: string | null; province: string | null }>(
      'SELECT city, province FROM job_locations WHERE job_id = ?',
      ['absa:R-1'],
    );
    expect(locs).toEqual([{ city: 'Johannesburg', province: 'Gauteng' }]);
    await db.close();
  });

  it('re-seeing an unchanged job bumps last_seen but not updated_at', async () => {
    const db = openLocalDb(':memory:');
    await upsertJobs(db, 'absa', [makeJob()], T1);
    const result = await upsertJobs(db, 'absa', [makeJob()], T2);

    expect(result).toEqual({ seen: 1, inserted: 0, updated: 0, unchangedContent: 1 });
    const row = await jobRow(db, 'absa:R-1');
    expect(row?.last_seen).toBe(T2);
    expect(row?.updated_at).toBe(T1);
    await db.close();
  });

  it('a content change bumps updated_at and re-indexes FTS', async () => {
    const db = openLocalDb(':memory:');
    await upsertJobs(db, 'absa', [makeJob()], T1);

    const changed = makeJob({
      title: 'Senior Wizard Analyst',
      descriptionHtml: '<p>Cast spells.</p>',
      descriptionText: 'Cast spells.',
      excerpt: 'Cast spells.',
    });
    const result = await upsertJobs(db, 'absa', [changed], T3);
    expect(result).toEqual({ seen: 1, inserted: 0, updated: 1, unchangedContent: 0 });

    const row = await jobRow(db, 'absa:R-1');
    expect(row?.title).toBe('Senior Wizard Analyst');
    expect(row?.updated_at).toBe(T3);

    const hits = await db.all<{ title: string }>(
      "SELECT title FROM jobs_fts WHERE jobs_fts MATCH 'wizard'",
    );
    expect(hits.length).toBe(1);
    expect(hits[0]?.title).toBe('Senior Wizard Analyst');

    // The old title should no longer be indexed.
    const stale = await db.all<{ title: string }>(
      "SELECT title FROM jobs_fts WHERE jobs_fts MATCH 'teller'",
    );
    expect(stale.length).toBe(0);
    await db.close();
  });

  it('bumps last_seen for every re-seen job across the 80-id chunk boundary', async () => {
    const db = openLocalDb(':memory:');
    const jobs = Array.from({ length: 85 }, (_, i) => makeJob({ id: `absa:R-${i}` }));

    const first = await upsertJobs(db, 'absa', jobs, T1);
    expect(first).toEqual({ seen: 85, inserted: 85, updated: 0, unchangedContent: 0 });

    // Re-seeing all 85 with identical content spans two lifecycle chunks (80 +
    // 5); every row's last_seen must advance, none should churn content.
    const second = await upsertJobs(db, 'absa', jobs, T2);
    expect(second).toEqual({ seen: 85, inserted: 0, updated: 0, unchangedContent: 85 });

    const rows = await db.all<{ last_seen: string; updated_at: string }>(
      'SELECT last_seen, updated_at FROM jobs WHERE source = ?',
      ['absa'],
    );
    expect(rows.length).toBe(85);
    expect(rows.every((r) => r.last_seen === T2)).toBe(true);
    expect(rows.every((r) => r.updated_at === T1)).toBe(true);
    await db.close();
  });

  it('dedupes a duplicate id within one run, keeping the first occurrence', async () => {
    const db = openLocalDb(':memory:');
    const original = makeJob({ id: 'absa:DUP', title: 'First' });
    const shadow = makeJob({ id: 'absa:DUP', title: 'Second' });

    const result = await upsertJobs(db, 'absa', [original, shadow], T1);
    expect(result).toEqual({ seen: 1, inserted: 1, updated: 0, unchangedContent: 0 });
    expect((await jobRow(db, 'absa:DUP'))?.title).toBe('First');
    await db.close();
  });
});

describe('closeAbsentees', () => {
  it('closes a job only after two consecutive missed runs, then reopens on return', async () => {
    const db = openLocalDb(':memory:');
    const a = makeJob({ id: 'absa:A' });
    const b = makeJob({ id: 'absa:B' });

    // Run 1: both present.
    await upsertJobs(db, 'absa', [a, b], T1);

    // Run 2: only A. B is absent for the first time -> missed_runs 1, still open.
    await upsertJobs(db, 'absa', [a], T2);
    expect(await closeAbsentees(db, 'absa', T2, T2)).toBe(0);
    let bRow = await jobRow(db, 'absa:B');
    expect(bRow?.missed_runs).toBe(1);
    expect(bRow?.status).toBe('open');

    // Run 3: only A again. B missed twice -> closed.
    await upsertJobs(db, 'absa', [a], T3);
    expect(await closeAbsentees(db, 'absa', T3, T3)).toBe(1);
    bRow = await jobRow(db, 'absa:B');
    expect(bRow?.status).toBe('closed');
    expect(bRow?.closed_at).toBe(T3);
    expect(bRow?.missed_runs).toBe(2);
    expect(bRow?.first_seen).toBe(T1);

    // Run 4: B returns -> reopens, closed_at cleared, first_seen preserved.
    await upsertJobs(db, 'absa', [b], T4);
    bRow = await jobRow(db, 'absa:B');
    expect(bRow?.status).toBe('open');
    expect(bRow?.closed_at).toBeNull();
    expect(bRow?.missed_runs).toBe(0);
    expect(bRow?.last_seen).toBe(T4);
    expect(bRow?.first_seen).toBe(T1);

    // A was seen every run and never accrued a miss.
    expect((await jobRow(db, 'absa:A'))?.missed_runs).toBe(0);
    await db.close();
  });
});
