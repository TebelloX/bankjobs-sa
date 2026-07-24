// Freshness wording for the header's "Last updated" line.
//
// Kept separate from data.ts ON PURPOSE: data.ts imports the (gitignored) job
// snapshot JSON, and this module is also imported by the client script in
// Base.astro — bundling it must never drag the snapshot into the browser
// payload. Keep this file dependency-free.
//
// The site is static and can be served for many hours after a build, so the
// relative wording ('today', 'last night', 'yesterday') CANNOT be decided at
// build time — an evening build's 'today 19:58' would still be on screen the
// next morning. Build-time rendering uses formatUpdatedAbsolute (never goes
// stale); the client script re-renders with formatUpdatedLabel at view time.

// All wording is reckoned in SAST (fixed UTC+2, no DST) — the site's single
// display timezone.
const SAST = 'Africa/Johannesburg';

/** 'YYYY-MM-DD' for an instant, in SAST. */
export function sastYmd(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SAST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

// hourCycle 'h23' (not hour12: false) so midnight is '00:xx', never '24:xx'.
function sastTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: SAST,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

function sastHour(date: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: SAST,
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date),
  );
}

/** '23 Jul, 19:58' in SAST — correct no matter when it is read. */
export function formatUpdatedAbsolute(generatedAt: string): string {
  const d = new Date(generatedAt);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const day = new Intl.DateTimeFormat('en-ZA', {
    timeZone: SAST,
    day: 'numeric',
    month: 'short',
  }).format(d); // e.g. "23 Jul"
  return `${day}, ${sastTime(d)}`;
}

/** SAST hour from which a previous-day update reads 'last night', not 'yesterday'. */
const EVENING_START_HOUR = 18;

/**
 * Relative label for generatedAt as seen at `now`: same SAST day →
 * 'today 19:58'; previous SAST day → 'last night 19:58' (at or after
 * 18:00 SAST) or 'yesterday 15:00'; anything older → '20 Jul, 14:00'.
 */
export function formatUpdatedLabel(generatedAt: string, now: Date = new Date()): string {
  const d = new Date(generatedAt);
  if (Number.isNaN(d.getTime())) return 'unknown';

  const day = sastYmd(d);
  if (day === sastYmd(now)) return `today ${sastTime(d)}`;

  // SAST has no DST, so 24h before `now` always lands on the previous SAST day.
  if (day === sastYmd(new Date(now.getTime() - 86_400_000))) {
    const word = sastHour(d) >= EVENING_START_HOUR ? 'last night' : 'yesterday';
    return `${word} ${sastTime(d)}`;
  }

  return formatUpdatedAbsolute(generatedAt);
}

/**
 * Relative freshness for a statement-card row, e.g. 'today', '1d', '3d'.
 * Compares a date-only string ('2026-07-17') to the SAST date at `now`.
 * Empty for null/malformed input — callers keep their baked fallback then.
 */
export function formatPostedRelative(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  const posted = Date.UTC(y, m - 1, d);
  const [ty, tm, td] = sastYmd(now).split('-').map(Number);
  const today = Date.UTC(ty, tm - 1, td);
  const days = Math.round((today - posted) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1d';
  return `${days}d`;
}

/** The SAST date at `now` for the statement-card header, e.g. '24 Jul 2026'. */
export function sastStatementDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-ZA', {
    timeZone: SAST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(now);
}
