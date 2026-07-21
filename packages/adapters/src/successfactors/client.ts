import type { FetchOptions } from '../types';
import type { SfFeedItem, SfRawPosting, SfSitemapPosting } from './types';

/**
 * Everything tenant-specific lives here so a second SuccessFactors CSB careers
 * site is a new config, not new code. `host` is the careers host (no scheme);
 * the feed path is CSB-standard and only overridable for a re-skinned tenant.
 */
export interface SuccessFactorsConfig {
  /** Careers host, e.g. 'jobs.nedbank.co.za' or 'careers.discovery.co.za'. */
  host: string;
  /**
   * default '/sitemap.xml' — the (mislabelled) Google-for-Jobs FEED path, read
   * by {@link fetchAllSuccessFactors}. Only relevant to feed-path tenants.
   */
  feedPath?: string;
  /**
   * default '/sitemap.xml' — the URL SITEMAP path, read by
   * {@link fetchAllSuccessFactorsSitemap}. Same default path, different document:
   * a `<urlset>` of job detail URLs, not an `<rss>` feed. The two acquisition
   * paths never mix — a tenant is either feed-driven (Nedbank) or sitemap-driven
   * (Discovery), selected by which entry-point the adapter calls.
   */
  sitemapPath?: string;
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
const DEFAULT_SITEMAP_PATH = '/sitemap.xml';
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

// ===========================================================================
// Sitemap-driven acquisition path (Discovery). A second CSB pattern: some
// tenants serve a GENUINE URL sitemap at /sitemap.xml — a <urlset> whose every
// <loc> is a job detail page — instead of the Google-for-Jobs RSS the feed path
// consumes. Here the detail pages are LOAD-BEARING (they carry title, business
// unit, function, description and address), so a page that fails to fetch or
// lacks a critical field (jobId/title) is skipped + logged + counted, mirroring
// the Workday malformed-posting skip; it never fails the whole run. The feed
// path above is untouched by any of this.
// ===========================================================================

const LOC_RE = /<loc>([\s\S]*?)<\/loc>/gi;
// A JobPosting microdata <meta itemprop="X" content="Y"> (attribute order and
// quote style are both tolerated).
const META_CONTENT_RE = /\bcontent=["']([^"']*)["']/i;

/** Build a `<meta … itemprop="{name}" …>` matcher (attribute-order tolerant). */
function metaByItemprop(name: string): RegExp {
  return new RegExp(`<meta\\b[^>]*\\bitemprop=["']${name}["'][^>]*>`, 'i');
}

/** The `content` of the first `<meta itemprop="{name}">`, XML-decoded, or null. */
function metaContent(html: string, name: string): string | null {
  const tag = metaByItemprop(name).exec(html)?.[0];
  if (!tag) return null;
  const content = META_CONTENT_RE.exec(tag)?.[1];
  return content === undefined ? null : decodeXmlEntities(content).trim();
}

/**
 * The inner HTML of the first `<span … {attr}="{value}" …>` element, matched by
 * BALANCED span depth so a description whose body contains nested `<span>`s is
 * captured whole (a non-greedy `</span>` would stop at the first nested close).
 * Returns null when the opening tag or its matching close is absent.
 */
function spanInnerByAttr(html: string, attr: string, value: string): string | null {
  const open = new RegExp(`<span\\b[^>]*\\b${attr}=["']${value}["'][^>]*>`, 'i').exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;

  const token = /<span\b[^>]*>|<\/span>/gi;
  token.lastIndex = start;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    if (m[0].charAt(1) === '/') {
      depth -= 1;
      if (depth === 0) return html.slice(start, m.index);
    } else {
      depth += 1;
    }
  }
  return null;
}

/** Flatten a labelled span's inner (may hold entities/stray tags) to plain text. */
function spanText(html: string, attr: string, value: string): string {
  const inner = spanInnerByAttr(html, attr, value);
  if (inner === null) return '';
  return decodeXmlEntities(inner.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a `<urlset>` sitemap into its `<loc>` job-detail URLs. Tolerant and
 * dependency-free (same spirit as {@link parseFeed}); only `<loc>`s that look
 * like a `/job/…/{numericId}/` detail page are kept, so a stray non-job entry
 * cannot leak in.
 */
export function parseSitemap(xml: string): string[] {
  const urls: string[] = [];
  for (const match of xml.matchAll(LOC_RE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const url = decodeXmlEntities(raw).trim();
    if (url !== '' && extractJobId(url) !== null) urls.push(url);
  }
  return urls;
}

/**
 * Parse one job detail page into a structured {@link SfSitemapPosting}. jobId
 * (from the URL) and title are CRITICAL — a page missing either returns null so
 * the caller can skip + count it. Address/date come from schema.org microdata
 * (`itemprop`); title/businessUnit/function come from the labelled CSB fields
 * (`data-careersite-propertyid`) — businessUnit is ONLY exposed there, and the
 * others read the same span the microdata would.
 */
export function parseSitemapDetail(html: string, url: string): SfSitemapPosting | null {
  const jobId = extractJobId(url);
  if (jobId === null) return null;

  const title = spanText(html, 'data-careersite-propertyid', 'title');
  if (title === '') return null;

  return {
    jobId,
    url,
    title,
    businessUnit: spanText(html, 'data-careersite-propertyid', 'customfield1'),
    jobFunction: spanText(html, 'data-careersite-propertyid', 'department'),
    // Real HTML on the page (not the feed's double-encoded CDATA) — sanitize as-is.
    description: spanInnerByAttr(html, 'itemprop', 'description') ?? '',
    locality: metaContent(html, 'addressLocality') ?? '',
    country: metaContent(html, 'addressCountry') ?? '',
    // Same Java-toString datePosted microdata the feed path enriches from.
    postedDate: extractDatePosted(html),
  };
}

/** GET the URL sitemap XML. Non-OK responses throw with status + url. */
export async function fetchSitemap(
  cfg: SuccessFactorsConfig,
  opts?: FetchOptions,
): Promise<string> {
  const url = `https://${cfg.host}${cfg.sitemapPath ?? DEFAULT_SITEMAP_PATH}`;
  const res = await sfFetch(url, opts);
  if (!res.ok) {
    throw new Error(`SuccessFactors sitemap request failed: HTTP ${res.status} for ${url}`);
  }
  return res.text();
}

/**
 * Fetch every current posting from a SITEMAP-driven SuccessFactors CSB site.
 *   1. GET the sitemap — one request enumerates every open role's detail URL.
 *   2. GET each detail page and parse it into a structured record. Detail pages
 *      are LOAD-BEARING here: a fetch failure or a page missing jobId/title is
 *      skipped, logged and counted (never fatal) — systematic breakage instead
 *      surfaces downstream via the ingest count-drop guardrail.
 * Sleeps `delayMs` between EVERY network request.
 */
export async function fetchAllSuccessFactorsSitemap(
  cfg: SuccessFactorsConfig,
  opts?: FetchOptions,
): Promise<SfSitemapPosting[]> {
  const delayMs = cfg.delayMs ?? DEFAULT_DELAY_MS;
  const label = cfg.host;

  let requestsMade = 0;
  const pace = async (): Promise<void> => {
    if (requestsMade > 0) await sleep(delayMs);
    requestsMade += 1;
  };

  // 1) sitemap → every open role's detail URL.
  await pace();
  const xml = await fetchSitemap(cfg, opts);
  const urls = parseSitemap(xml).slice(0, SAFETY_CAP);
  opts?.log?.(`${label}: sitemap listed ${urls.length} job URLs`);

  // 2) detail pages → structured records (load-bearing; skips are non-fatal).
  const result: SfSitemapPosting[] = [];
  let skipped = 0;
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    if (url === undefined) continue;

    try {
      await pace();
      const res = await sfFetch(url, opts);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const posting = parseSitemapDetail(await res.text(), url);
      if (posting === null) {
        skipped += 1;
        opts?.log?.(`${label}: skipped ${url} — missing critical field (jobId/title)`);
      } else {
        result.push(posting);
      }
    } catch (e) {
      skipped += 1;
      opts?.log?.(`${label}: skipped ${url} — ${(e as Error).message}`);
    }
    opts?.log?.(`${label}: details ${i + 1}/${urls.length}`);
  }

  if (skipped > 0) opts?.log?.(`${label}: skipped ${skipped}/${urls.length} detail page(s)`);
  return result;
}
