import type { FetchOptions } from '../types';
import type { SfFeedItem, SfRawPosting } from './types';

/**
 * Everything tenant-specific lives here so a second SuccessFactors CSB careers
 * site is a new config, not new code. `host` is the careers host (no scheme);
 * the feed path is CSB-standard and only overridable for a re-skinned tenant.
 */
export interface SuccessFactorsConfig {
  /** Careers host, e.g. 'jobs.nedbank.co.za'. */
  host: string;
  /** default '/sitemap.xml' — the (mislabelled) Google-for-Jobs feed. */
  feedPath?: string;
  /** default 400 — delay between every network request. */
  delayMs?: number;
}

/**
 * The feed and detail pages answer our honest crawler UA with 200 (verified
 * against jobs.nedbank.co.za 2026-07-21), so — like SmartRecruiters, eArcu and
 * Workable — we never spoof a browser.
 */
export const SUCCESSFACTORS_UA =
  'Mozilla/5.0 (compatible; BankJobsSA/0.1; +https://github.com/bankjobs-sa)';

const DEFAULT_FEED_PATH = '/sitemap.xml';
const DEFAULT_DELAY_MS = 400;
/** Never enrich more than this many detail pages in a single run. */
const SAFETY_CAP = 500;

const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;
const CDATA_RE = /<!\[CDATA\[([\s\S]*?)\]\]>/;
// datePosted rides in a schema.org JobPosting microdata <meta> in the detail
// page head; tolerant of either attribute order within the tag.
const DATE_POSTED_META_RE = /<meta\b[^>]*\bitemprop=["']datePosted["'][^>]*>/i;
const CONTENT_ATTR_RE = /\bcontent=["']([^"']*)["']/i;
// The content is a Java-toString date, e.g. 'Fri Jul 17 02:00:00 UTC 2026'.
// Take the calendar date as written (no timezone maths — a 02:00 UTC stamp must
// not drift a day under local-time parsing).
const JAVA_DATE_RE =
  /[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+\d{1,2}:\d{2}:\d{2}\s+[A-Za-z]+\s+(\d{4})/;
const CANONICAL_RE = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i;
// Detail-page URLs look like /job/{City-Slug-Title}/{numericId}/.
const JOB_ID_RE = /\/job\/[^/]+\/(\d+)\/?/;

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode the XML entities the feed uses, in a SINGLE pass (`&amp;` last so
 * `&amp;amp;` collapses to `&amp;`, never to `&`). Applied uniformly to every
 * field: it turns 'A &amp; B' into 'A & B' for plain-text fields, and the
 * CDATA's HTML-encoded HTML ('&lt;p&gt;') back into real HTML ('<p>').
 */
function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Inner text of the first `<tag>…</tag>` in `block`, XML-decoded, or null. */
function tagText(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const raw = re.exec(block)?.[1];
  return raw === undefined ? null : decodeXmlEntities(raw).trim();
}

/**
 * Parse the RSS feed into items with a small tolerant hand-rolled parser (no XML
 * dep). Each `<item>` block yields one {@link SfFeedItem}; the CDATA description
 * is un-escaped to real HTML. Individual items missing the id or link — the
 * fields we cannot invent — are skipped and counted, mirroring the Workday
 * client's malformed-posting skip.
 */
export function parseFeed(xml: string, opts?: FetchOptions): SfFeedItem[] {
  const items: SfFeedItem[] = [];
  let skipped = 0;

  for (const match of xml.matchAll(ITEM_RE)) {
    const block = match[1];
    if (block === undefined) continue;

    const id = tagText(block, 'g:id');
    const link = tagText(block, 'link');
    if (!id || !link) {
      skipped += 1;
      continue;
    }

    const cdata = CDATA_RE.exec(block)?.[1] ?? '';
    items.push({
      id,
      link,
      title: tagText(block, 'title') ?? '',
      location: tagText(block, 'g:location') ?? '',
      jobFunction: tagText(block, 'g:job_function') ?? '',
      employer: tagText(block, 'g:employer') ?? '',
      description: decodeXmlEntities(cdata),
    });
  }

  if (skipped > 0) opts?.log?.(`successfactors: skipped ${skipped} malformed feed items`);
  return items;
}

/** The `YYYY-MM-DD` posted date from a detail page's datePosted microdata, or
 * null when the meta tag / content / date shape is absent or unrecognised. */
export function extractDatePosted(detailHtml: string): string | null {
  const tag = DATE_POSTED_META_RE.exec(detailHtml)?.[0];
  if (!tag) return null;
  const content = CONTENT_ATTR_RE.exec(tag)?.[1];
  if (!content) return null;
  const m = JAVA_DATE_RE.exec(content);
  if (!m) return null;
  const month = MONTHS[(m[1] ?? '').toLowerCase()];
  if (!month) return null;
  const day = (m[2] ?? '').padStart(2, '0');
  return `${m[3]}-${month}-${day}`;
}

/** The canonical detail-page URL declared in a detail page, or null if absent. */
export function extractCanonicalUrl(detailHtml: string): string | null {
  return CANONICAL_RE.exec(detailHtml)?.[1] ?? null;
}

/** The numeric job id embedded in a detail-page URL, or null if absent. */
export function extractJobId(url: string): string | null {
  return JOB_ID_RE.exec(url)?.[1] ?? null;
}

async function sfFetch(url: string, opts: FetchOptions | undefined): Promise<Response> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  return fetchImpl(url, { headers: { 'User-Agent': SUCCESSFACTORS_UA } });
}

/** GET the feed XML. Non-OK responses throw with status + url. */
export async function fetchFeed(cfg: SuccessFactorsConfig, opts?: FetchOptions): Promise<string> {
  const url = `https://${cfg.host}${cfg.feedPath ?? DEFAULT_FEED_PATH}`;
  const res = await sfFetch(url, opts);
  if (!res.ok) {
    throw new Error(`SuccessFactors feed request failed: HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/**
 * Fetch every current posting from a SuccessFactors CSB careers site.
 *   1. GET the feed — one request carries every open role with all critical
 *      fields (id, title, URL, location, function, full description).
 *   2. GET each job's detail page and extract its `datePosted` microdata to
 *      enrich `postedDate`. This step is NON-FATAL: a fetch or extraction miss
 *      leaves that job's postedDate null and is logged — it never drops the job
 *      or fails the run (the brittle HTML surface is kept non-load-bearing).
 * Sleeps `delayMs` between EVERY network request.
 */
export async function fetchAllSuccessFactors(
  cfg: SuccessFactorsConfig,
  opts?: FetchOptions,
): Promise<SfRawPosting[]> {
  const delayMs = cfg.delayMs ?? DEFAULT_DELAY_MS;
  const label = cfg.host;

  let requestsMade = 0;
  const pace = async (): Promise<void> => {
    if (requestsMade > 0) await sleep(delayMs);
    requestsMade += 1;
  };

  // 1) feed → every open role.
  await pace();
  const xml = await fetchFeed(cfg, opts);
  const items = parseFeed(xml, opts).slice(0, SAFETY_CAP);
  opts?.log?.(`${label}: feed carried ${items.length} items`);

  // 2) detail pages → postedDate enrichment (non-fatal).
  const result: SfRawPosting[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;

    let postedDate: string | null = null;
    try {
      await pace();
      const res = await sfFetch(item.link, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      postedDate = extractDatePosted(await res.text());
      if (postedDate === null) {
        opts?.log?.(`${label}: no datePosted microdata at ${item.link}`);
      }
    } catch (e) {
      opts?.log?.(
        `${label}: postedDate enrichment failed for ${item.link} — ${(e as Error).message}`,
      );
    }

    result.push({ item, postedDate });
    opts?.log?.(`${label}: details ${i + 1}/${items.length}`);
  }

  return result;
}
