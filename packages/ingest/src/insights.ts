import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobsDb } from './db';

/**
 * One day on the statement: what came on, what came off, and the closing
 * balance. The FIRST entry is the opening balance — tracking began mid-life, so
 * its `added` is the ledger as we found it, not a day's hiring.
 */
export interface InsightsDay {
  day: string;
  added: number;
  closed: number;
  open: number;
}

/** A `GROUP BY day` row: the day and its count. */
export interface DayCount {
  day: string;
  n: number;
}

interface RunDayRow {
  day: string;
  success: number | null;
  warning: number | null;
  failure: number | null;
}

/** Days a closed role stood on the statement, and how many stood that long. */
interface HistogramRow {
  days: number | null;
  n: number;
}

/** ISO date-only string one day after `day`, e.g. '2026-07-31' → '2026-08-01'. */
function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1)).toISOString().slice(0, 10);
}

/**
 * Walk every day from `trackingSince` to `today` inclusive, carrying a running
 * balance: open(D) = Σ added ≤ D − Σ closed ≤ D. Pure and total — days with no
 * activity still get a row, so the site can render a continuous statement
 * without doing date arithmetic of its own.
 *
 * A day outside the window is DROPPED (a closure dated tomorrow by a clock skew,
 * an addition predating the first `first_seen`), which is one of the ways the
 * final balance can disagree with the live open count; emitInsights reconciles
 * and warns. Always emits at least the opening row, even if `trackingSince`
 * somehow postdates `today`.
 */
export function buildSeries(
  adds: DayCount[],
  closes: DayCount[],
  trackingSince: string,
  today: string,
): InsightsDay[] {
  const addedByDay = new Map(adds.map((r) => [r.day, Number(r.n)]));
  const closedByDay = new Map(closes.map((r) => [r.day, Number(r.n)]));

  const series: InsightsDay[] = [];
  let open = 0;
  for (let day = trackingSince; ; day = nextDay(day)) {
    const added = addedByDay.get(day) ?? 0;
    const closed = closedByDay.get(day) ?? 0;
    open += added - closed;
    series.push({ day, added, closed, open });
    if (day >= today) break;
  }
  return series;
}

/**
 * Write `{dir}/src/data/insights.json` — the history aggregates behind
 * /insights/. Called at the end of emitSnapshots, so every path that produces
 * snapshots produces this file too.
 *
 * Every query here is AGGREGATE-ONLY, by necessity rather than taste: closed
 * rows keep their tens-of-KB `description_html`, and over the D1 REST API a wide
 * read of them would overflow the response ceiling long before the counts got
 * interesting. Result sets are O(days) or O(bins).
 *
 * `substr(…, 1, 10)` buckets by UTC day. All three cron slots (04:17 / 10:17 /
 * 16:17 UTC = 06:17 / 12:17 / 18:17 SAST) fall on the same UTC and SAST day, so
 * for scheduled runs UTC bucketing IS SAST bucketing — no day is split or
 * doubled by the timezone.
 *
 * Deliberately ABSENT from the output: per-bank / per-category / per-province
 * current counts. The site computes those at build time from the snapshots it
 * already imports (the index.astro pattern); this file carries only what the D1
 * history knows and the snapshots cannot say.
 */
export async function emitInsights(db: JobsDb, snapshotDir: string, now: string): Promise<void> {
  const today = now.slice(0, 10);

  // The day the record starts. An empty jobs table yields NULL → today, so a
  // fresh checkout still gets a valid one-day series rather than no file.
  const start = await db.get<{ day: string | null }>(
    'SELECT substr(MIN(first_seen), 1, 10) AS day FROM jobs',
  );
  const trackingSince = start?.day ?? today;

  // Additions per day, SA only. `hidden` rows are excluded: the staleness
  // backstop hides a job we can no longer re-confirm, so its lifecycle end is
  // unknown and it can never be balanced by a closure.
  const adds = await db.all<DayCount>(
    `SELECT substr(first_seen, 1, 10) AS day, COUNT(*) AS n FROM jobs
       WHERE country = 'ZA' AND status != 'hidden' GROUP BY day ORDER BY day`,
  );

  const closes = await db.all<DayCount>(
    `SELECT substr(closed_at, 1, 10) AS day, COUNT(*) AS n FROM jobs
       WHERE country = 'ZA' AND status = 'closed' AND closed_at IS NOT NULL
       GROUP BY day ORDER BY day`,
  );

  const series = buildSeries(adds, closes, trackingSince, today);

  // Days a closed role stood on the statement, as BINS — never rows. Its own
  // total comes from summing the bins rather than a second COUNT(*): same
  // predicate, one fewer round trip, and the two can never disagree.
  const histogram = await db.all<HistogramRow>(
    `SELECT CAST(julianday(substr(closed_at, 1, 10)) - julianday(substr(first_seen, 1, 10)) AS INTEGER) AS days,
            COUNT(*) AS n FROM jobs
       WHERE country = 'ZA' AND status = 'closed' AND closed_at IS NOT NULL
       GROUP BY days ORDER BY days`,
  );
  const daysOpenHistogram = histogram.map((r) => ({
    days: Number(r.days ?? 0),
    count: Number(r.n),
  }));
  const closedTotal = daysOpenHistogram.reduce((sum, bin) => sum + bin.count, 0);

  // The fetch record. 'running' rows are crashes-in-flight — a process that died
  // before finalizing its run — so they are excluded from both the per-day
  // columns and the totals; counting them would report a fetch that never
  // reported an outcome.
  const since = new Date(Date.parse(now) - 14 * 86_400_000).toISOString();
  const runDays = await db.all<RunDayRow>(
    `SELECT substr(started_at, 1, 10) AS day, SUM(outcome = 'success') AS success,
            SUM(outcome = 'warning') AS warning, SUM(outcome = 'failure') AS failure
       FROM ingestion_runs WHERE outcome != 'running' AND started_at >= ?
       GROUP BY day ORDER BY day`,
    [since],
  );
  const runTotals = await db.get<{ total: number; success: number }>(
    `SELECT COUNT(*) AS total, COALESCE(SUM(outcome = 'success'), 0) AS success
       FROM ingestion_runs WHERE outcome != 'running'`,
  );

  // Reconcile the walked balance against the live count. They agree whenever
  // every SA row's lifecycle is representable as one addition and at most one
  // closure inside the window; a mismatch means drift (a closure dated outside
  // it, a `closed` row with no `closed_at`) and the page would then contradict
  // the masthead. Warn LOUDLY — and still emit: a scheduled build must never
  // fall over because a figure looks off.
  const live = await db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE country = 'ZA' AND status = 'open'",
  );
  const openToday = Number(live?.n ?? 0);
  const finalOpen = series[series.length - 1]?.open ?? 0;
  if (finalOpen !== openToday) {
    console.warn(
      `[insights] balance does not reconcile: series ends at ${finalOpen} open, live SA count is ${openToday} — emitting anyway.`,
    );
  }

  const insights = {
    generatedAt: now,
    trackingSince,
    openToday,
    series,
    closedRoles: { total: closedTotal, daysOpenHistogram },
    runs: {
      total: Number(runTotals?.total ?? 0),
      success: Number(runTotals?.success ?? 0),
      days: runDays.map((r) => ({
        day: r.day,
        success: Number(r.success ?? 0),
        warning: Number(r.warning ?? 0),
        failure: Number(r.failure ?? 0),
      })),
    },
  };

  const srcDataDir = join(snapshotDir, 'src', 'data');
  mkdirSync(srcDataDir, { recursive: true });
  writeFileSync(join(srcDataDir, 'insights.json'), JSON.stringify(insights));

  // Also published as a public snapshot: the iOS app renders /insights/ (and
  // "added since your last visit") from this same file, fetched at runtime the
  // way the site's own islands fetch /data/jobs.json.
  const publicDataDir = join(snapshotDir, 'public', 'data');
  mkdirSync(publicDataDir, { recursive: true });
  writeFileSync(join(publicDataDir, 'insights.json'), JSON.stringify(insights));
}
