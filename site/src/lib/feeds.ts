// Item mapping for the RSS feeds under /feeds/.
//
// Kept dependency-FREE on purpose, exactly like related.ts and freshness.ts:
// lib/data.ts imports the (gitignored) job snapshots, so a module that imported
// it — even for a type — risks dragging megabytes of JSON into anything that
// ever reaches a browser bundle. This file declares the minimal structural
// shape it reads (FeedJob) instead and takes rows as arguments, which also
// makes it plain-node unit-testable. The endpoints in src/pages/feeds/ do the
// data.ts import: they run at build time only and are never client-bundled.
//
// Everything here is PURE. Same rows in, byte-identical items out, so a rebuild
// with unchanged data produces an unchanged feed and readers see no churn.
//
// Escaping is @astrojs/rss's job — it builds the XML and escapes every title
// and description. The ONE exception is the per-item `customData` string, which
// it splices in as raw XML; the guid we put there is escaped below.

/** The fields a job row must expose to become a feed item. FullJob satisfies this. */
export interface FeedJob {
  id: string;
  slug: string;
  title: string;
  brand: string;
  excerpt: string;
  /** ISO date-only ('2026-07-21'), or null when the source publishes none. */
  postedDate: string | null;
  /** ISO timestamp of the first crawl that saw this job. */
  firstSeen: string;
}

/** One feed item, structurally an @astrojs/rss RSSFeedItem. */
export interface FeedItem {
  title: string;
  link: string;
  pubDate: Date;
  description: string;
  customData: string;
}

/** How many items a feed carries: the newest 50. */
export const FEED_LIMIT = 50;

/**
 * The day a row is filed under for ordering: its real posted date, else the day
 * we first saw it. Date-only on both sides so the comparison is like-for-like —
 * ordering must not depend on the clock time of a crawl.
 */
function sortKey(job: FeedJob): string {
  return job.postedDate ?? job.firstSeen.slice(0, 10);
}

/**
 * Newest first, by posted date (falling back to first-seen), with the job id as
 * the tiebreak. The id tiebreak is what makes this deterministic: same rows in
 * any order produce the same feed.
 */
export function sortForFeed<T extends FeedJob>(jobs: readonly T[]): T[] {
  return [...jobs].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    return 0;
  });
}

/** The first `limit` rows — pair with sortForFeed to get the newest ones. */
export function capForFeed<T>(jobs: readonly T[], limit: number = FEED_LIMIT): T[] {
  return jobs.slice(0, Math.max(0, limit));
}

/**
 * XML-escape a value we splice into markup ourselves. Job ids are [a-z0-9:-]
 * today, so nothing here has anything to escape — this is defence against the
 * day an id format changes, not a fix for one.
 */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Map job rows to feed items: newest first, capped at `limit`.
 *
 * - link is the canonical job URL, absolute against `origin`. Feed readers have
 *   no page to resolve a relative link against.
 * - pubDate falls back to firstSeen when a source publishes no date, the same
 *   honest fallback the JobPosting JSON-LD makes on the detail page. Date-only
 *   strings parse as UTC midnight, which is what a date-only claim means — do
 *   NOT localize them into SAST, that would move some rows a day.
 * - guid is the stable job id with isPermaLink="false", overriding the link-
 *   derived guid @astrojs/rss would otherwise emit. Ids survive re-crawls and
 *   URL changes; a reader that has seen one never re-notifies on it.
 */
export function toFeedItems(
  jobs: readonly FeedJob[],
  origin: string | URL,
  limit: number = FEED_LIMIT,
): FeedItem[] {
  return capForFeed(sortForFeed(jobs), limit).map((job) => ({
    title: `${job.title} — ${job.brand}`,
    link: new URL(`/jobs/${job.slug}/`, origin).href,
    pubDate: new Date(job.postedDate ?? job.firstSeen),
    description: job.excerpt,
    customData: `<guid isPermaLink="false">${escapeXml(job.id)}</guid>`,
  }));
}

/**
 * Astro types `context.site` as `URL | undefined` because a project may omit
 * `site` from astro.config. Ours sets it, and feed links have to be absolute,
 * so the endpoints fail the build rather than quietly emit relative ones.
 */
export function requireSite(site: URL | undefined): URL {
  if (!site) {
    throw new Error('[feeds] astro.config `site` must be set — feed links must be absolute');
  }
  return site;
}

/** A page's `<link rel="alternate">` target. */
export interface FeedLink {
  href: string;
  title: string;
}

/** The site-wide feed, advertised on every page. */
export const ALL_FEED: FeedLink = {
  href: '/feeds/all.xml',
  title: 'mybankjobs — new vacancies',
};

// The two builders below are shared by the endpoint (which uses `title` as the
// channel title) and the HTML page (which advertises the same pair in its
// <head>), so the two can never drift apart.

/** The feed for one bank, e.g. bankFeed('Absa', 'absa'). */
export function bankFeed(brand: string, slug: string): FeedLink {
  return { href: `/feeds/bank/${slug}.xml`, title: `mybankjobs — new ${brand} vacancies` };
}

/** The feed for one category, e.g. categoryFeed('Software & IT', 'software-it'). */
export function categoryFeed(name: string, slug: string): FeedLink {
  return { href: `/feeds/category/${slug}.xml`, title: `mybankjobs — new ${name} vacancies` };
}
