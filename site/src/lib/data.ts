// Build-time data access for the static site.
//
// The two JSON inputs are produced by the ingest pipeline and are GITIGNORED —
// they do not exist in a fresh checkout. If these imports fail with
// "Cannot find module '../data/jobs-full.json'", run the ingest first:
//
//     pnpm ingest -- --source=absa      (or: pnpm ingest --fixtures)
//
// which writes site/src/data/jobs-full.json + site/public/data/*.json.
// A realistic sample set is committed-by-generation during local dev; see
// site/README.md.
import type { Category, Job } from '@bankjobs/core';
import { CATEGORY_SLUGS } from '@bankjobs/core';
import jobsFullJson from '../data/jobs-full.json';
import metaJson from '../../public/data/meta.json';

/** A full open job record, extended with the category slug the snapshot carries. */
export interface FullJob extends Job {
  slug: string;
  categorySlug: string;
}

/** Shape of public/data/meta.json. */
export interface Meta {
  generatedAt: string;
  totalOpen: number;
  totalSA: number;
  totalInternational: number;
  sources: Array<{ id: string; name: string; count: number; lastSuccessAt: string | null }>;
  categories: Record<string, number>;
  provinces: Record<string, number>;
}

// jobs-full.json is OPEN jobs only, already sorted postedDate desc (nulls last).
const jobs = jobsFullJson as unknown as FullJob[];

export const meta = metaJson as unknown as Meta;

/** Every open job, all countries, postedDate desc. */
export function allOpenJobs(): FullJob[] {
  return jobs;
}

/** Open jobs located in South Africa. */
export function saJobs(): FullJob[] {
  return jobs.filter((j) => j.country === 'ZA');
}

/** Open jobs located outside South Africa. */
export function internationalJobs(): FullJob[] {
  return jobs.filter((j) => j.country !== 'ZA');
}

/** Find one open job by its URL slug. */
export function jobBySlug(slug: string): FullJob | undefined {
  return jobs.find((j) => j.slug === slug);
}

/** Human category name for a category slug, or undefined if unknown. */
export function categoryForSlug(slug: string): Category | undefined {
  const entry = (Object.entries(CATEGORY_SLUGS) as Array<[Category, string]>).find(
    ([, s]) => s === slug,
  );
  return entry?.[0];
}

const MONTHS = [
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

/**
 * Format an ISO date-only string ('2026-07-17') as '17 Jul'. Timezone-safe:
 * the string is split rather than parsed through Date. Empty for null.
 */
export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const parts = iso.split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!y || !m || !d) return '';
  return `${d} ${MONTHS[m - 1]}`;
}

const SAST = 'Africa/Johannesburg';

function sastYmd(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SAST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Format the snapshot's generatedAt (an ISO instant) as a short freshness
 * string in SAST (Africa/Johannesburg): 'today 20:15' when it lands on the
 * build day, otherwise '19 Jul, 14:00'.
 */
export function formatUpdated(generatedAt: string): string {
  const d = new Date(generatedAt);
  if (Number.isNaN(d.getTime())) return 'unknown';

  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: SAST,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);

  if (sastYmd(d) === sastYmd(new Date())) {
    return `today ${time}`;
  }

  const day = new Intl.DateTimeFormat('en-ZA', {
    timeZone: SAST,
    day: 'numeric',
    month: 'short',
  }).format(d); // e.g. "19 Jul"

  return `${day}, ${time}`;
}
