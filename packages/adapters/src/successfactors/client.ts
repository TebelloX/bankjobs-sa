import { describeError } from '@bankjobs/core';

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
  /**
   * default [5000, 15000] — backoff before each retry of the load-bearing
   * feed/sitemap GET (so up to 3 attempts in total). Tests pass [] or [0].
   */
  retryDelaysMs?: number[];
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
/** Backoff before each retry of the load-bearing feed/sitemap GET. */
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000];
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

/**
 * GET a load-bearing document (feed or sitemap) with bounded retry. Every SF
 * CSB tenant we crawl CNAMEs to the same SAP edge (rmk12.jobs2web.com), so one
 * transient connect failure there fails every SF source in the run at once
 * (observed 2026-07-22: undici's default 10s connect timeout tripped for all
 * three hosts while every non-SF platform connected fine). A thrown fetch
 * (network-level), a failed body read, and a 429/5xx response all retry after
 * the configured backoff; any other non-OK status is permanent and throws
 * immediately — a 403/404 will not heal in 15 seconds.
 */
async function fetchDocument(
  what: 'feed' | 'sitemap',
  url: string,
  retryDelaysMs: number[],
  opts?: FetchOptions,
): Promise<string> {
  const attempts = retryDelaysMs.length + 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      const delay = retryDelaysMs[attempt - 2] ?? 0;
      opts?.log?.(
        `${what} attempt ${attempt - 1}/${attempts} failed for ${url} — ` +
          `${lastError === undefined ? 'unknown error' : describeError(lastError)}; ` +
          `retrying in ${delay}ms`,
      );
      await sleep(delay);
    }

    let res: Response;
    try {
      res = await sfFetch(url, opts);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }

    if (res.ok) {
      try {
        return await res.text();
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        continue;
      }
    }

    lastError = new Error(`SuccessFactors ${what} request failed: HTTP ${res.status} for ${url}`);
    if (res.status !== 429 && res.status < 500) throw lastError;
  }

  throw lastError ?? new Error(`SuccessFactors ${what} request failed for ${url}`);
}

/** GET the feed XML with retry; see {@link fetchDocument} for the policy. */
export async function fetchFeed(cfg: SuccessFactorsConfig, opts?: FetchOptions): Promise<string> {
  const url = `https://${cfg.host}${cfg.feedPath ?? DEFAULT_FEED_PATH}`;
  return fetchDocument('feed', url, cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS, opts);
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
      opts?.log?.(`${label}: postedDate enrichment failed for ${item.link} — ${describeError(e)}`);
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
 * Inner text of the first NON-meta element carrying `itemprop="{name}"`
 * (e.g. `<h1 itemprop="title">…</h1>`), flattened to plain text and XML-decoded,
 * or '' when absent. Some CSB tenants (Capitec) expose the title as schema.org
 * ELEMENT microdata rather than a labelled `data-careersite-propertyid` span;
 * the tag name is captured and closed with a backreference so an element with a
 * simple text body is read whole.
 */
function itempropElementText(html: string, name: string): string {
  const re = new RegExp(
    `<([a-z0-9]+)\\b[^>]*\\bitemprop=["']${name}["'][^>]*>([\\s\\S]*?)</\\1>`,
    'i',
  );
  const m = re.exec(html);
  if (!m) return '';
  return decodeXmlEntities((m[2] ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolve the posting's city + country from the address microdata, tolerating
 * both CSB shapes. Preferred: the structured `addressLocality`/`addressCountry`
 * meta (Discovery). When those are absent, fall back to a single `streetAddress`
 * meta of the form `"City, CC"` (or a bare `"CC"` for a nationwide/pipeline role
 * with no city) — Capitec's most common shape. Either way the country is the
 * trailing ISO alpha-2 token; a bare country degrades to an empty city, so a
 * locationless role never has a city invented for it.
 */
function resolveAddress(html: string): { locality: string; country: string } {
  const locality = metaContent(html, 'addressLocality');
  const country = metaContent(html, 'addressCountry');
  if (locality !== null || country !== null) {
    return { locality: locality ?? '', country: country ?? '' };
  }

  const street = metaContent(html, 'streetAddress') ?? '';
  const parts = street
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) return { locality: '', country: '' };
  const last = parts[parts.length - 1] ?? '';
  // A trailing 2-letter token is the ISO country ("City, ZA" or bare "ZA").
  if (/^[A-Za-z]{2}$/.test(last)) {
    return { locality: parts.slice(0, -1).join(', '), country: last };
  }
  return { locality: parts.join(', '), country: '' };
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
 * the caller can skip + count it. Two CSB detail-page shapes are tolerated:
 *
 *  - Group-wide tenant (Discovery): title/businessUnit/function are labelled CSB
 *    fields (`data-careersite-propertyid`) — businessUnit is ONLY exposed there;
 *    address is the structured `addressLocality`/`addressCountry` microdata.
 *  - Single-brand tenant (Capitec): the title is schema.org ELEMENT microdata
 *    (`<h1 itemprop="title">`), there is NO business-unit/function labelled span
 *    (both resolve to '', so the adapter keeps every posting), and the address
 *    is usually a single `streetAddress` ("City, ZA" or a bare "ZA").
 *
 * The two shapes are probed in that order, so a group tenant's output is
 * unchanged. Date always rides the schema.org datePosted microdata.
 */
export function parseSitemapDetail(html: string, url: string): SfSitemapPosting | null {
  const jobId = extractJobId(url);
  if (jobId === null) return null;

  // Title is critical: prefer the labelled CSB span; fall back to element
  // microdata for a tenant that carries no labelled fields.
  let title = spanText(html, 'data-careersite-propertyid', 'title');
  if (title === '') title = itempropElementText(html, 'title');
  if (title === '') return null;

  const { locality, country } = resolveAddress(html);

  return {
    jobId,
    url,
    title,
    businessUnit: spanText(html, 'data-careersite-propertyid', 'customfield1'),
    jobFunction: spanText(html, 'data-careersite-propertyid', 'department'),
    // Real HTML on the page (not the feed's double-encoded CDATA) — sanitize as-is.
    description: spanInnerByAttr(html, 'itemprop', 'description') ?? '',
    locality,
    country,
    // Same Java-toString datePosted microdata the feed path enriches from.
    postedDate: extractDatePosted(html),
  };
}

/** GET the URL sitemap XML with retry; see {@link fetchDocument} for the policy. */
export async function fetchSitemap(
  cfg: SuccessFactorsConfig,
  opts?: FetchOptions,
): Promise<string> {
  const url = `https://${cfg.host}${cfg.sitemapPath ?? DEFAULT_SITEMAP_PATH}`;
  return fetchDocument('sitemap', url, cfg.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS, opts);
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
      opts?.log?.(`${label}: skipped ${url} — ${describeError(e)}`);
    }
    opts?.log?.(`${label}: details ${i + 1}/${urls.length}`);
  }

  if (skipped > 0) opts?.log?.(`${label}: skipped ${skipped}/${urls.length} detail page(s)`);
  return result;
}
