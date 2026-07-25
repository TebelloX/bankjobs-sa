import { describe, expect, it } from 'vitest';
import {
  formatDayLong,
  formatDayShort,
  medianFromHistogram,
  postedMonthBuckets,
  showDurations,
  showSparkline,
  sparkPoints,
  windowSums,
} from '../src/lib/insightsView';

/** A series entry; only day/added/closed/open are ever read. */
function day(day: string, added: number, closed: number, open: number) {
  return { day, added, closed, open };
}

/** `days` consecutive days from 2026-07-01, each with the given open balance. */
function series(opens: number[]) {
  return opens.map((open, i) => day(`2026-07-${String(i + 1).padStart(2, '0')}`, 0, 0, open));
}

describe('windowSums', () => {
  const TRACKING = '2026-07-01';

  it('excludes the opening day — it is the import, not a day of hiring', () => {
    const rows = [
      day('2026-07-01', 420, 0, 420),
      day('2026-07-02', 6, 2, 424),
      day('2026-07-03', 4, 1, 427),
    ];
    expect(windowSums(rows, TRACKING)).toEqual({ added: 10, closed: 3, isFullWindow: false });
  });

  it('flags a full window only once seven post-opening days exist', () => {
    const rows = [day('2026-07-01', 420, 0, 420)];
    for (let i = 2; i <= 7; i += 1) {
      rows.push(day(`2026-07-0${i}`, 1, 0, 419 + i));
    }
    expect(windowSums(rows, TRACKING).isFullWindow).toBe(false);
    rows.push(day('2026-07-08', 1, 0, 427));
    expect(windowSums(rows, TRACKING)).toEqual({ added: 7, closed: 0, isFullWindow: true });
  });

  it('keeps only the last seven days once the record is longer', () => {
    const rows = [day('2026-07-01', 420, 0, 420)];
    for (let i = 2; i <= 20; i += 1) {
      rows.push(day(`2026-07-${String(i).padStart(2, '0')}`, i, 1, 420));
    }
    // Days 14..20 → 14+15+…+20 = 119 added, 7 closed.
    expect(windowSums(rows, TRACKING)).toEqual({ added: 119, closed: 7, isFullWindow: true });
  });

  it('reports zeros on the opening day itself', () => {
    expect(windowSums([day('2026-07-01', 420, 0, 420)], TRACKING)).toEqual({
      added: 0,
      closed: 0,
      isFullWindow: false,
    });
  });
});

describe('medianFromHistogram', () => {
  it('is null for an empty histogram', () => {
    expect(medianFromHistogram([])).toBeNull();
    expect(medianFromHistogram([{ days: 3, count: 0 }])).toBeNull();
  });

  it('takes the middle observation for an odd total', () => {
    // 1, 3, 3, 8, 9 → 3
    expect(
      medianFromHistogram([
        { days: 1, count: 1 },
        { days: 3, count: 2 },
        { days: 8, count: 1 },
        { days: 9, count: 1 },
      ]),
    ).toBe(3);
  });

  it('averages the two middle observations for an even total', () => {
    // 2, 4, 6, 10 → (4 + 6) / 2 = 5
    expect(
      medianFromHistogram([
        { days: 2, count: 1 },
        { days: 4, count: 1 },
        { days: 6, count: 1 },
        { days: 10, count: 1 },
      ]),
    ).toBe(5);
  });

  it('reads bins in day order however they arrive', () => {
    expect(
      medianFromHistogram([
        { days: 30, count: 1 },
        { days: 0, count: 1 },
        { days: 5, count: 1 },
      ]),
    ).toBe(5);
  });
});

describe('the display gates', () => {
  it('holds the sparkline back until the series is 14 days long', () => {
    expect(showSparkline(series(new Array(13).fill(400)))).toBe(false);
    expect(showSparkline(series(new Array(14).fill(400)))).toBe(true);
  });

  it('holds durations back until there are both closures and history', () => {
    // Both gates: 40 closures AND 30 days tracked.
    expect(showDurations(39, '2026-07-01', '2026-09-01')).toBe(false);
    expect(showDurations(40, '2026-07-01', '2026-07-29')).toBe(false);
    expect(showDurations(40, '2026-07-01', '2026-07-31')).toBe(true);
    expect(showDurations(400, '2026-07-21', '2026-07-25')).toBe(false);
  });
});

describe('sparkPoints', () => {
  it('steps x evenly across the width and inverts y so higher reads up', () => {
    const { points, min, max } = sparkPoints(series([10, 20, 30]), 100, 64);
    const pairs = points.split(' ').map((p) => p.split(',').map(Number));
    expect(min).toBe(10);
    expect(max).toBe(30);
    expect(pairs.map((p) => p[0])).toEqual([0, 50, 100]);

    // Monotonic x, and the highest balance sits highest on screen (smallest y).
    for (let i = 1; i < pairs.length; i += 1) {
      expect(pairs[i]![0]!).toBeGreaterThan(pairs[i - 1]![0]!);
      expect(pairs[i]![1]!).toBeLessThan(pairs[i - 1]![1]!);
    }
    // Inset by the stroke's half-width at both extremes.
    expect(pairs[0]![1]).toBe(62);
    expect(pairs[2]![1]).toBe(2);
  });

  it('centres a flat series instead of dividing by zero', () => {
    const { points, min, max } = sparkPoints(series([400, 400, 400]), 100, 64);
    expect(min).toBe(400);
    expect(max).toBe(400);
    expect(points).toBe('0,32 50,32 100,32');
  });

  it('survives a one-day series', () => {
    expect(sparkPoints(series([5]), 100, 64)).toEqual({ points: '0,32', min: 5, max: 5 });
  });
});

describe('postedMonthBuckets', () => {
  it('buckets six months newest first, then older, then undated', () => {
    const buckets = postedMonthBuckets(
      [
        '2026-07-20',
        '2026-07-02',
        '2026-06-30',
        '2026-04-01',
        '2026-02-11',
        '2019-11-05',
        null,
        '',
      ],
      '2026-07-25',
    );
    expect(buckets).toEqual([
      { label: 'Jul 2026', count: 2 },
      { label: 'Jun 2026', count: 1 },
      { label: 'May 2026', count: 0 },
      { label: 'Apr 2026', count: 1 },
      { label: 'Mar 2026', count: 0 },
      { label: 'Feb 2026', count: 1 },
      { label: 'older', count: 1 },
      { label: 'undated', count: 2 },
    ]);
  });

  it('walks back across the year boundary', () => {
    const buckets = postedMonthBuckets(
      ['2027-01-04', '2026-12-31', '2026-08-01', '2026-07-31'],
      '2027-01-15',
    );
    expect(buckets.map((b) => b.label)).toEqual([
      'Jan 2027',
      'Dec 2026',
      'Nov 2026',
      'Oct 2026',
      'Sep 2026',
      'Aug 2026',
      'older',
      'undated',
    ]);
    expect(buckets.find((b) => b.label === 'Jan 2027')?.count).toBe(1);
    expect(buckets.find((b) => b.label === 'Dec 2026')?.count).toBe(1);
    expect(buckets.find((b) => b.label === 'Aug 2026')?.count).toBe(1);
    // Jul 2026 is one month past the six-month window.
    expect(buckets.find((b) => b.label === 'older')?.count).toBe(1);
  });

  it('counts a posting dated ahead of today in the current month', () => {
    const buckets = postedMonthBuckets(['2026-09-01'], '2026-07-25');
    expect(buckets[0]).toEqual({ label: 'Jul 2026', count: 1 });
    expect(buckets.find((b) => b.label === 'older')?.count).toBe(0);
  });

  it('counts a malformed date as undated rather than guessing', () => {
    const buckets = postedMonthBuckets(['not-a-date', '2026', null], '2026-07-25');
    expect(buckets.find((b) => b.label === 'undated')?.count).toBe(3);
  });
});

describe('the date formatters', () => {
  it('spells the tracking date out in full', () => {
    expect(formatDayLong('2026-07-21')).toBe('21 July 2026');
    expect(formatDayLong('2026-12-01')).toBe('1 December 2026');
  });

  it('shortens a statement row to day and month', () => {
    expect(formatDayShort('2026-07-22')).toBe('22 Jul');
  });

  it('hands malformed input straight back', () => {
    expect(formatDayLong('garbage')).toBe('garbage');
    expect(formatDayShort('garbage')).toBe('garbage');
  });
});
