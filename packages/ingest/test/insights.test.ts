import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CanonicalJob } from '@bankjobs/core';
import { openLocalDb } from '../src/db';
import type { JobsDb } from '../src/db';
import { closeAbsentees, upsertJobs } from '../src/diff';
import { buildSeries, emitInsights } from '../src/insights';

// One fetch per day at the 06:17 SAST cron slot, so every timestamp lands
// unambiguously on its own UTC (and SAST) day.
const DAY1 = '2026-07-01T04:17:00.000Z';
const DAY2 = '2026-07-02T04:17:00.000Z';
const DAY3 = '2026-07-03T04:17:00.000Z';
const DAY4 = '2026-07-04T04:17:00.000Z';
const DAY5 = '2026-07-05T04:17:00.000Z';
/** The instant the snapshot is emitted — two days after the last fetch above. */
const NOW = '2026-07-06T09:00:00.000Z';

interface InsightsFile {
  generatedAt: string;
  trackingSince: string;
  openToday: number;
  series: Array<{ day: string; added: number; closed: number; open: number }>;
  closedRoles: { total: number; daysOpenHistogram: Array<{ days: number; count: number }> };
  runs: {
    total: number;
    success: number;
    days: Array<{ day: string; success: number; warning: number; failure: number }>;
  };
}

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

/**
 * The job with this id, identical on every run. R-3 is the international one and
 * must stay international: re-seeding it as ZA would change its content hash and
 * upsertJobs would rewrite the country, quietly pulling it onto the SA statement.
 */
function job(id: string): CanonicalJob {
  return makeJob({ id, country: id === 'absa:R-3' ? 'SC' : 'ZA' });
}

/** A run row exactly as runIngest finalizes one. */
async function seedRun(db: JobsDb, startedAt: string, outcome: string): Promise<void> {
  await db.run('INSERT INTO ingestion_runs (source, started_at, outcome) VALUES (?, ?, ?)', [
    'absa',
    startedAt,
    outcome,
  ]);
}

function readInsights(dir: string): InsightsFile {
  return JSON.parse(
    readFileSync(join(dir, 'src', 'data', 'insights.json'), 'utf8'),
  ) as InsightsFile;
}

const dir = mkdtempSync(join(tmpdir(), 'bankjobs-insights-'));
let file: InsightsFile;

beforeAll(async () => {
  const db = openLocalDb(':memory:');

  // Day 1: the opening ledger — three SA roles and one international one.
  await upsertJobs(db, 'absa', ['absa:R-1', 'absa:R-2', 'absa:R-4', 'absa:R-3'].map(job), DAY1);

  // Day 2: one addition (R-5); R-1 goes missing for the first time.
  await upsertJobs(db, 'absa', ['absa:R-2', 'absa:R-3', 'absa:R-4', 'absa:R-5'].map(job), DAY2);
  await closeAbsentees(db, 'absa', DAY2, DAY2);

  // Day 3: R-1 misses a second consecutive run and closes (2 days on the
  // statement). This is the anti-flap gate — one absence is never a closure.
  await upsertJobs(db, 'absa', ['absa:R-2', 'absa:R-3', 'absa:R-4', 'absa:R-5'].map(job), DAY3);
  await closeAbsentees(db, 'absa', DAY3, DAY3);

  // Days 4 and 5: R-4 disappears, misses twice and closes (4 days open).
  for (const day of [DAY4, DAY5]) {
    await upsertJobs(db, 'absa', ['absa:R-2', 'absa:R-3', 'absa:R-5'].map(job), day);
    await closeAbsentees(db, 'absa', day, day);
  }

  // Fetch record: one run older than the 14-day day-window (counts in the
  // totals, absent from the per-day rows) and one still in flight.
  await seedRun(db, '2026-06-01T04:17:00.000Z', 'success');
  await seedRun(db, '2026-07-01T04:17:00.000Z', 'success');
  await seedRun(db, '2026-07-01T10:17:00.000Z', 'warning');
  await seedRun(db, '2026-07-02T04:17:00.000Z', 'failure');
  await seedRun(db, '2026-07-02T10:17:00.000Z', 'success');
  await seedRun(db, '2026-07-06T04:17:00.000Z', 'running');

  await emitInsights(db, dir, NOW);
  await db.close();
  file = readInsights(dir);
});

describe('emitInsights', () => {
  it('starts the record on the day of the first fetch, with that day as the opening balance', () => {
    expect(file.generatedAt).toBe(NOW);
    expect(file.trackingSince).toBe('2026-07-01');

    // The opening row's `added` is the ledger as we found it — three SA roles.
    // The site renders it as "Opening balance", never as a day's hiring.
    const opening = file.series[0];
    expect(opening?.day).toBe('2026-07-01');
    expect(opening?.added).toBe(3);
    expect(opening?.closed).toBe(0);
    expect(opening?.open).toBe(3);
  });

  it('runs the series to the emit day and ends on the live open count', () => {
    expect(file.series.map((d) => d.day)).toEqual([
      '2026-07-01',
      '2026-07-02',
      '2026-07-03',
      '2026-07-04',
      '2026-07-05',
      '2026-07-06',
    ]);
    // R-2 and R-5 are still open; R-1 and R-4 closed.
    expect(file.openToday).toBe(2);
    expect(file.series[file.series.length - 1]?.open).toBe(2);
  });

  it('telescopes the balance day by day', () => {
    expect(file.series.map((d) => [d.added, d.closed, d.open])).toEqual([
      [3, 0, 3],
      [1, 0, 4],
      [0, 1, 3],
      [0, 0, 3],
      [0, 1, 2],
      [0, 0, 2],
    ]);
    for (let i = 1; i < file.series.length; i += 1) {
      const day = file.series[i]!;
      expect(day.open).toBe(file.series[i - 1]!.open + day.added - day.closed);
    }
  });

  it('bins closed roles by days on the statement', () => {
    expect(file.closedRoles.total).toBe(2);
    expect(file.closedRoles.daysOpenHistogram).toEqual([
      { days: 2, count: 1 },
      { days: 4, count: 1 },
    ]);
  });

  it('rolls up the fetch record, excluding runs still in flight', () => {
    // Six rows seeded, one 'running' — a crash in flight reported no outcome.
    expect(file.runs.total).toBe(5);
    expect(file.runs.success).toBe(3);

    // Per-day columns cover the last 14 days only, so the 1 June run is absent
    // from them while still counted in the totals above.
    expect(file.runs.days).toEqual([
      { day: '2026-07-01', success: 1, warning: 1, failure: 0 },
      { day: '2026-07-02', success: 1, warning: 0, failure: 1 },
    ]);
  });

  it('counts South African roles only in the series', () => {
    // Four SA jobs were ever added (R-1, R-2, R-4, R-5); the Seychelles role is
    // never on this statement, in or out.
    const added = file.series.reduce((n, d) => n + d.added, 0);
    expect(added).toBe(4);
    const closed = file.series.reduce((n, d) => n + d.closed, 0);
    expect(closed).toBe(2);
  });
});

describe('emitInsights on an empty database', () => {
  it('writes a valid file with a one-day zero series', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'bankjobs-insights-empty-'));
    const db = openLocalDb(':memory:');
    await emitInsights(db, emptyDir, NOW);
    await db.close();

    const empty = readInsights(emptyDir);
    expect(empty.trackingSince).toBe('2026-07-06');
    expect(empty.series).toEqual([{ day: '2026-07-06', added: 0, closed: 0, open: 0 }]);
    expect(empty.openToday).toBe(0);
    expect(empty.closedRoles).toEqual({ total: 0, daysOpenHistogram: [] });
    expect(empty.runs).toEqual({ total: 0, success: 0, days: [] });
  });
});

describe('emitInsights reconciliation', () => {
  it('warns loudly on drift but still emits the file', async () => {
    const driftDir = mkdtempSync(join(tmpdir(), 'bankjobs-insights-drift-'));
    const db = openLocalDb(':memory:');
    await upsertJobs(db, 'absa', [makeJob({ id: 'absa:R-1' }), makeJob({ id: 'absa:R-2' })], DAY1);
    // A closure dated beyond the emit day falls outside the walked window, so
    // the balance cannot see it — exactly the drift the warning is for.
    await db.run("UPDATE jobs SET status = 'closed', closed_at = ? WHERE id = 'absa:R-2'", [
      '2026-08-01T04:17:00.000Z',
    ]);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await emitInsights(db, driftDir, NOW);
    await db.close();

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain('does not reconcile');
    warn.mockRestore();

    const drift = readInsights(driftDir);
    expect(drift.openToday).toBe(1);
    expect(drift.series[drift.series.length - 1]?.open).toBe(2);
  });
});

describe('buildSeries', () => {
  it('drops activity dated outside the window', () => {
    const series = buildSeries(
      [
        { day: '2026-06-30', n: 5 },
        { day: '2026-07-01', n: 2 },
      ],
      [{ day: '2026-07-09', n: 1 }],
      '2026-07-01',
      '2026-07-02',
    );
    expect(series).toEqual([
      { day: '2026-07-01', added: 2, closed: 0, open: 2 },
      { day: '2026-07-02', added: 0, closed: 0, open: 2 },
    ]);
  });

  it('crosses a month boundary', () => {
    const series = buildSeries([{ day: '2026-08-01', n: 1 }], [], '2026-07-31', '2026-08-01');
    expect(series.map((d) => d.day)).toEqual(['2026-07-31', '2026-08-01']);
  });

  it('always emits the opening row, even if tracking somehow postdates today', () => {
    const series = buildSeries([], [], '2026-07-06', '2026-07-01');
    expect(series).toEqual([{ day: '2026-07-06', added: 0, closed: 0, open: 0 }]);
  });
});
