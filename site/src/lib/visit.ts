// "New since your last visit" — the visitor's own browsing clock.
//
// Zero server state: no account, no subscription, no email, no cookie. One
// localStorage key holds two timestamps and nothing else — no ids, no contact
// details, nothing that identifies anyone — which is what keeps this side of
// "alerts" free of personal data entirely. Nothing here is ever sent anywhere.
//
// Kept dependency-free ON PURPOSE, exactly like freshness.ts and savedJobs.ts:
// this module is imported by the client script in Base.astro, so it must never
// import lib/data.ts or lib/insights.ts (both pull a gitignored snapshot JSON
// into whatever bundle reaches them). freshness.ts is the one import, and it
// imports nothing itself. Storage is always a PARAMETER, never reached for, so
// node tests hand it a fake.
//
// "Your last visit" is the PREVIOUS BROWSING SESSION, not the previous page
// view: every page view stamps `last`, and a gap of more than an hour between
// stamps ends a session and rotates the old `last` into `prev`. A visitor
// clicking through six ledger pages therefore keeps seeing the same flags
// instead of watching them vanish behind them.

import { sastYmd } from './freshness';

/** localStorage key. Versioned: a v2 shape would be a new key, not a migration. */
export const VISIT_KEY = 'mybankjobs.visit.v1';

/**
 * Idle time that ends a session. An hour is long enough to read a job page,
 * open three in tabs and come back, and short enough that this morning and
 * this afternoon count as two visits.
 */
export const SESSION_GAP_MS = 60 * 60 * 1000;

/** The two instants the feature turns on. Both are UTC ISO-8601 timestamps. */
export interface VisitRecord {
  /**
   * End of the PREVIOUS session — the "since" in "since your last visit".
   * null on a first-ever visit (and whenever storage is unusable), which is the
   * signal to flag nothing at all: everything would be new, which is no
   * information.
   */
  prev: string | null;
  /** This page view. Rewritten on every load. */
  last: string;
}

/** A stored value that is usable, or null — corrupt storage starts over. */
function parseStored(stored: string | null): VisitRecord | null {
  if (!stored) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const v = parsed as Record<string, unknown>;
  const last = typeof v.last === 'string' ? v.last : null;
  // Without a usable `last` there is no session clock to continue.
  if (!last || Number.isNaN(Date.parse(last))) return null;
  const prev = typeof v.prev === 'string' && !Number.isNaN(Date.parse(v.prev)) ? v.prev : null;
  return { prev, last };
}

/**
 * The record this page view leaves behind, given what was stored.
 *
 * More than SESSION_GAP_MS since the last stamp means the previous session is
 * over and becomes `prev`; anything shorter is the same session continuing, so
 * `prev` is carried unchanged. A clock that jumped backwards produces a
 * negative gap and is treated as the same session — the alternative is
 * rotating away a real "last visit" over a device's clock skew.
 */
export function rotateVisit(stored: string | null, nowIso: string): VisitRecord {
  const previous = parseStored(stored);
  if (!previous) return { prev: null, last: nowIso };
  const gap = Date.parse(nowIso) - Date.parse(previous.last);
  if (gap > SESSION_GAP_MS) return { prev: previous.last, last: nowIso };
  return { prev: previous.prev, last: nowIso };
}

/**
 * Stamp this page view and hand back the record to render against.
 *
 * Writes NEVER throw: private mode, a full quota or storage disabled by policy
 * degrade to "no last visit" (nothing flagged), never to an exception that
 * takes the page's script down with it. Unusable storage returns a first-visit
 * record for the same reason.
 *
 * IDEMPOTENT within the session gap: a second caller on the same page view
 * re-reads what the first wrote, sees a gap of ~0ms and gets the identical
 * record — which is why Base.astro and the homepage script can both call it
 * without agreeing on an order.
 */
export function recordVisit(
  storage: Storage | null,
  nowIso: string = new Date().toISOString(),
): VisitRecord {
  if (!storage) return { prev: null, last: nowIso };

  let stored: string | null = null;
  try {
    stored = storage.getItem(VISIT_KEY);
  } catch {
    stored = null;
  }

  const record = rotateVisit(stored, nowIso);
  try {
    storage.setItem(VISIT_KEY, JSON.stringify(record));
  } catch {
    // Quota or a refused write: the record is still correct for THIS page view,
    // it just will not survive to the next one.
  }
  return record;
}

/**
 * Whether a job first appeared on our statement after the visitor's last visit.
 *
 * Plain string comparison is a chronological comparison here: both sides are
 * fixed-width UTC ISO-8601 from Date#toISOString ('2026-07-21T08:22:24.487Z') —
 * firstSeen is stamped that way by the ingest, prev by recordVisit — so
 * lexicographic order is time order. No Date parsing, no timezone in play.
 *
 * A null on either side is false: a row with no firstSeen cannot be dated, and
 * a visitor with no previous session has nothing to be new since.
 */
export function isNewSince(firstSeen: string | null, prevIso: string | null): boolean {
  if (!firstSeen || !prevIso) return false;
  return firstSeen > prevIso;
}

/**
 * Total the per-day addition counts for the days AFTER the visitor's last
 * visit, reckoned in SAST (the site's single display timezone, so the days
 * counted are the days named on /insights/).
 *
 * The visit day itself is SKIPPED, not prorated: a visit at 14:00 SAST saw
 * whatever had been added that morning, and the day's count cannot say how much
 * of it landed after they left. Undercounting by part of one day is the honest
 * direction — the line claims only additions the visitor certainly has not
 * seen.
 *
 * 0 for a first-ever visit and for an unparseable timestamp; unusable counts
 * are ignored rather than poisoning the sum with a NaN.
 */
export function sumAddedSince(addedByDay: Record<string, number>, prevIso: string | null): number {
  if (!prevIso) return 0;
  const prev = new Date(prevIso);
  if (Number.isNaN(prev.getTime())) return 0;

  // Both sides are 'YYYY-MM-DD', so > is a calendar comparison.
  const prevDay = sastYmd(prev);
  let total = 0;
  for (const [day, count] of Object.entries(addedByDay)) {
    if (day > prevDay && typeof count === 'number' && Number.isFinite(count)) total += count;
  }
  return total;
}
