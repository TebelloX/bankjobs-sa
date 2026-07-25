// Build-time history aggregates for /insights/.
//
// The JSON input is produced by the ingest pipeline and is GITIGNORED — it does
// not exist in a fresh checkout. If this import fails with "Cannot find module
// '../data/insights.json'", run the ingest first:
//
//     pnpm ingest -- --source=absa      (or: pnpm ingest --fixtures)
//
// which writes site/src/data/insights.json beside the job snapshots.
//
// Same rule as data.ts: this module must never reach a client bundle. The file
// is small, but importing it from anything a <script> can pull in would ship the
// whole history to every visitor. All the pure reckoning done on this data lives
// in insightsView.ts, which imports nothing.
import insightsJson from '../data/insights.json';

/** One day on the statement. The FIRST entry is the opening balance. */
export interface InsightsDay {
  day: string;
  added: number;
  closed: number;
  open: number;
}

/** Shape of src/data/insights.json — field names are the ingest contract. */
export interface Insights {
  generatedAt: string;
  /** The day the record begins: the earliest first_seen we hold. */
  trackingSince: string;
  /** Live SA open count, the same figure the masthead carries. */
  openToday: number;
  series: InsightsDay[];
  closedRoles: {
    total: number;
    daysOpenHistogram: Array<{ days: number; count: number }>;
  };
  runs: {
    total: number;
    success: number;
    /** The last 14 days only — the totals above cover the whole record. */
    days: Array<{ day: string; success: number; warning: number; failure: number }>;
  };
}

export const insights = insightsJson as unknown as Insights;
