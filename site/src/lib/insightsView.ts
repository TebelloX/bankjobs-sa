// The reckoning behind /insights/ — sums, medians, buckets and the display
// gates, with no data of its own.
//
// Kept separate from insights.ts on the freshness.ts pattern: that module
// imports the (gitignored) history snapshot, this one imports NOTHING, so the
// tests need no snapshot and nothing here can drag the JSON anywhere. Keep it
// dependency-free.
//
// Every date is an ISO date-only string ('2026-07-21') and all arithmetic is
// done on the string or through Date.UTC — never through a local-timezone parse,
// which would shift a day either side of midnight SAST.

/** The one field of a series entry these helpers read, plus the day it fell on. */
interface Day {
  day: string;
  added: number;
  closed: number;
  open: number;
}

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Whole days from `from` to `to`, both ISO date-only. Negative if `to` is earlier. */
function daysBetween(from: string, to: string): number {
  const utc = (iso: string): number => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/**
 * Additions and closures over the last `days` entries, EXCLUDING the opening
 * day. Tracking began mid-life, so `trackingSince`'s `added` is the import of an
 * existing ledger, not a day's hiring — counting it in a "last 7 days" figure
 * would report ~420 roles added in a week that saw a handful.
 *
 * `isFullWindow` says whether `days` whole post-opening days exist yet. Until
 * they do, the caller labels the figure "since <opening day>" rather than
 * claiming a week.
 */
export function windowSums(
  series: Day[],
  trackingSince: string,
  days = 7,
): { added: number; closed: number; isFullWindow: boolean } {
  const post = series.filter((d) => d.day !== trackingSince);
  const window = post.slice(-days);
  return {
    added: window.reduce((n, d) => n + d.added, 0),
    closed: window.reduce((n, d) => n + d.closed, 0),
    isFullWindow: post.length >= days,
  };
}

/**
 * Median of a count-per-value histogram, without expanding it into rows. Null
 * for an empty histogram — there is no median of nothing, and the caller must
 * say so rather than print a 0.
 */
export function medianFromHistogram(bins: Array<{ days: number; count: number }>): number | null {
  const sorted = [...bins].filter((b) => b.count > 0).sort((a, b) => a.days - b.days);
  const total = sorted.reduce((n, b) => n + b.count, 0);
  if (total === 0) return null;

  // Value at a 0-based rank in the implied sorted list of every observation.
  const at = (rank: number): number => {
    let seen = 0;
    for (const bin of sorted) {
      seen += bin.count;
      if (rank < seen) return bin.days;
    }
    return sorted[sorted.length - 1]!.days;
  };

  if (total % 2 === 1) return at((total - 1) / 2);
  return (at(total / 2 - 1) + at(total / 2)) / 2;
}

/**
 * Show the trend sparkline only once the series is two weeks long. A four-point
 * line reads as a trend while being nothing but the shape of our own start date.
 */
export function showSparkline(series: Day[]): boolean {
  return series.length >= 14;
}

/**
 * Show how long roles stay open only once there are enough closures AND enough
 * history to have observed a long one. Early on the figure is biased low by
 * right-censoring: only the short-lived roles have closed yet, so a median
 * struck now would report days when the truth is weeks. Both gates flip on their
 * own as the record lengthens.
 */
export function showDurations(
  closedTotal: number,
  trackingSince: string,
  todayIso: string,
): boolean {
  return closedTotal >= 40 && daysBetween(trackingSince, todayIso) >= 30;
}

/** Round to 2dp — enough precision for an SVG coordinate, short in the markup. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Polyline geometry for the open-balance sparkline, plus the min and max the
 * caller labels. `y` is inverted (SVG counts down, a reader reads up), and the
 * line is inset by the stroke's half-width so the extremes are not shaved off by
 * the viewBox edge. A flat series has no range to scale against — it is centred
 * rather than divided by zero.
 */
export function sparkPoints(
  series: Day[],
  width: number,
  height: number,
): { points: string; min: number; max: number } {
  const opens = series.map((d) => d.open);
  const min = opens.length > 0 ? Math.min(...opens) : 0;
  const max = opens.length > 0 ? Math.max(...opens) : 0;

  const PAD = 2;
  const span = max - min;
  const step = opens.length > 1 ? width / (opens.length - 1) : 0;
  const points = opens
    .map((open, i) => {
      const t = span === 0 ? 0.5 : (open - min) / span;
      const y = height - PAD - t * (height - 2 * PAD);
      return `${round(i * step)},${round(y)}`;
    })
    .join(' ');

  return { points, min, max };
}

/**
 * Composition of the open ledger by the month each role was posted: the current
 * month and the five before it, then everything older, then the roles the banks
 * publish with no date at all. Newest first, and every bucket is emitted even at
 * zero — a missing month would read as a gap in the record rather than a quiet
 * month.
 *
 * This says when today's open roles were POSTED. It is not a posting rate: roles
 * posted in a given month that have since closed are not on this statement.
 */
export function postedMonthBuckets(
  postedDates: Array<string | null>,
  todayIso: string,
): Array<{ label: string; count: number }> {
  const [ty, tm] = todayIso.slice(0, 10).split('-').map(Number);
  const year = ty ?? 1970;
  const month = tm ?? 1;

  // Six month keys, newest first, walking back through the year boundary.
  const keys: string[] = [];
  const labels: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const total = year * 12 + (month - 1) - i;
    const y = Math.floor(total / 12);
    const m = total % 12;
    keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    labels.push(`${MONTHS_SHORT[m]} ${y}`);
  }

  const counts = new Map(keys.map((k) => [k, 0]));
  let older = 0;
  let undated = 0;

  for (const posted of postedDates) {
    const key = (posted ?? '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(key)) {
      undated += 1;
      continue;
    }
    // A posting dated ahead of today — a few bank feeds carry these — counts in
    // the current month. It is certainly not older than the window.
    const bucket = key > keys[0]! ? keys[0]! : key;
    const current = counts.get(bucket);
    if (current === undefined) older += 1;
    else counts.set(bucket, current + 1);
  }

  return [
    ...keys.map((k, i) => ({ label: labels[i]!, count: counts.get(k) ?? 0 })),
    { label: 'older', count: older },
    { label: 'undated', count: undated },
  ];
}

/** '2026-07-21' → '21 July 2026'. Split, never parsed — timezone-safe. */
export function formatDayLong(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${d} ${MONTHS_LONG[m - 1]} ${y}`;
}

/** '2026-07-22' → '22 Jul', the statement table's day column. */
export function formatDayShort(iso: string): string {
  const [, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!m || !d || m < 1 || m > 12) return iso;
  return `${d} ${MONTHS_SHORT[m - 1]}`;
}
