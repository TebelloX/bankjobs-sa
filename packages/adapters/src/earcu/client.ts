import type { FetchOptions } from '../types';
import type { EarcuJobPosting, EarcuRawPosting } from './types';

/**
 * Everything employer-specific lives here so a second eArcu careers site is a
 * new config, not new code. `host` is the careers subdomain (no scheme); the
 * sitemap path is eArcu-standard and only overridable for a site that has been
 * re-skinned.
 */
export interface EarcuConfig {
  /** Careers host, e.g. 'careers.investec.co.za'. */
  host: string;
  /** default '/jobs/sitemap.xml' — the eArcu `<urlset>` of job/talent-pool URLs. */
  sitemapPath?: string;
  /** default 400 — delay between every network request. */
  delayMs?: number;
}

/**
 * eArcu answers our honest crawler UA with 200 on the sitemap and on detail
 * pages (re-verified against careers.investec.co.za 2026-07-28), so — like
 * SmartRecruiters — we never spoof a browser. Spoofing would not help anyway:
 * the surfaces that ARE challenged (see {@link fetchAllEarcu}) challenge browser
 * UA strings too.
 */
export const EARCU_UA = 'Mozilla/5.0 (compatible; BankJobsSA/0.1; +https://github.com/bankjobs-sa)';

const DEFAULT_SITEMAP_PATH = '/jobs/sitemap.xml';
const DEFAULT_DELAY_MS = 400;
/** Never fetch more than this many detail pages in a single run. */
const SAFETY_CAP = 500;

const LOC_RE = /<loc>([\s\S]*?)<\/loc>/gi;
// Vacancy detail pages live at /jobs/vacancy/<slug>/<id>/description/ and are
// stable and cookie-free. Matched against the RESOLVED pathname, so the same
// test covers a relative and an absolute <loc>. Evergreen talent pools sit at
// /jobs/talentpool/<slug>/<id>/description/ — not vacancies, and excluded by
// this shape — as do the handful of ordinary site pages the sitemap also lists.
const DETAIL_PATH_RE = /^\/jobs\/vacancy\/[^/]+\/\d+\/description\/$/i;
const LD_JSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
// The detail page's own canonical link is the durable, cookie-free apply URL —
// used to reconstruct `raw.url` from committed HTML fixtures offline.
const CANONICAL_RE = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i;
// AWS WAF (in front of CloudFront) flags a JS-challenge response with this
// header. It rides on an HTTP 202 with an empty body, which `res.ok` happily
// accepts — hence the status === 200 checks throughout this client.
const WAF_ACTION_HEADER = 'x-amzn-waf-action';

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode the five predefined XML entities a sitemap `<loc>` must escape. Single
 * pass with `&amp;` last so `&amp;amp;` collapses to `&amp;`, never to `&`
 * (same rule as the SuccessFactors feed decoder).
 */
function decodeXmlEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The canonical detail-page URL declared in a detail page, or null if absent. */
export function extractCanonicalUrl(detailHtml: string): string | null {
  return CANONICAL_RE.exec(detailHtml)?.[1] ?? null;
}

/**
 * Every VACANCY detail-page URL in a `<urlset>` sitemap, resolved to absolute
 * against `base` and de-duplicated in first-seen order. Tolerant and
 * dependency-free (same spirit as the SuccessFactors sitemap parser): each
 * `<loc>` is XML-decoded and kept only when it resolves to a
 * `/jobs/vacancy/<slug>/<id>/description/` path, so the evergreen
 * `/jobs/talentpool/…` entries — which outnumber the real vacancies roughly
 * 7:1 — and the ordinary site pages can never leak in.
 */
export function extractDetailUrls(sitemapXml: string, base: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of sitemapXml.matchAll(LOC_RE)) {
    const raw = match[1];
    if (raw === undefined) continue;
    const loc = decodeXmlEntities(raw).trim();
    if (loc === '') continue;
    let resolved: URL;
    try {
      resolved = new URL(loc, base);
    } catch {
      continue;
    }
    if (!DETAIL_PATH_RE.test(resolved.pathname)) continue;
    const abs = resolved.toString();
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/**
 * Find and parse the schema.org JobPosting from a detail page. Scans every
 * `application/ld+json` block (tolerating `@graph` wrappers and array roots)
 * and returns the first JobPosting, or null when none parses.
 */
export function extractJobPostingLd(detailHtml: string): EarcuJobPosting | null {
  for (const match of detailHtml.matchAll(LD_JSON_RE)) {
    const body = match[1];
    if (body === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      continue;
    }
    const found = findJobPosting(parsed);
    if (found) return found;
  }
  return null;
}

function findJobPosting(node: unknown): EarcuJobPosting | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj['@type'] === 'JobPosting') return obj as EarcuJobPosting;
    if (Array.isArray(obj['@graph'])) return findJobPosting(obj['@graph']);
  }
  return null;
}

async function earcuFetch(url: string, opts: FetchOptions | undefined): Promise<Response> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  return fetchImpl(url, { headers: { 'User-Agent': EARCU_UA } });
}

/**
 * Fail on anything that is not a plain 200. A WAF challenge answers 202 — a
 * SUCCESS status — with an empty body, so an `res.ok` check waves it through and
 * the run dies later with a misleading parse error (exactly how the grid-based
 * discovery failed silently for a day). Naming the header in the message makes
 * this failure mode self-describing in CI logs.
 */
function assertOk(res: Response, what: string, url: string): void {
  if (res.status === 200) return;
  const wafAction = res.headers.get(WAF_ACTION_HEADER);
  if (wafAction !== null && wafAction !== '') {
    throw new Error(
      `eArcu ${what} request blocked by AWS WAF challenge ` +
        `(HTTP ${res.status}, ${WAF_ACTION_HEADER}: ${wafAction}): ${url}`,
    );
  }
  throw new Error(`eArcu ${what} request failed: HTTP ${res.status} for ${url}`);
}

/**
 * Fetch every current posting from an eArcu careers site.
 *   1. GET the sitemap — one request enumerates every vacancy detail URL.
 *   2. GET each cookie-free detail page and parse its JobPosting JSON-LD.
 * Sleeps `delayMs` between EVERY network request. Detail pages whose JSON-LD is
 * missing/unparseable are logged and skipped rather than aborting the run.
 *
 * The sitemap replaced the old results-page + `pagestamp` + grid-AJAX discovery
 * on 2026-07-28: since 27 Jul 2026 AWS WAF answers every request for
 * /jobs/vacancy/find/results/ with an HTTP 202 JavaScript challenge and an empty
 * body, for any client that does not execute the challenge script (browser UA
 * strings included). /jobs/sitemap.xml and the detail pages are NOT challenged,
 * and robots.txt allows everything but /file/*.
 */
export async function fetchAllEarcu(
  cfg: EarcuConfig,
  opts?: FetchOptions,
): Promise<EarcuRawPosting[]> {
  const delayMs = cfg.delayMs ?? DEFAULT_DELAY_MS;
  const sitemapPath = cfg.sitemapPath ?? DEFAULT_SITEMAP_PATH;
  const origin = `https://${cfg.host}`;
  const label = cfg.host;

  let requestsMade = 0;
  const pace = async (): Promise<void> => {
    if (requestsMade > 0) await sleep(delayMs);
    requestsMade += 1;
  };

  // 1) sitemap → every vacancy's detail URL.
  await pace();
  const sitemapUrl = `${origin}${sitemapPath}`;
  const sitemapRes = await earcuFetch(sitemapUrl, opts);
  assertOk(sitemapRes, 'sitemap', sitemapUrl);
  const sitemapXml = await sitemapRes.text();
  const detailUrls = extractDetailUrls(sitemapXml, origin).slice(0, SAFETY_CAP);
  opts?.log?.(`${label}: sitemap listed ${detailUrls.length} vacancies`);

  // 2) detail pages → JobPosting JSON-LD.
  const result: EarcuRawPosting[] = [];
  for (let i = 0; i < detailUrls.length; i += 1) {
    const url = detailUrls[i];
    if (url === undefined) continue;
    await pace();
    const res = await earcuFetch(url, opts);
    assertOk(res, 'detail', url);
    const html = await res.text();
    const jsonLd = extractJobPostingLd(html);
    if (!jsonLd) {
      opts?.log?.(`${label}: no JobPosting JSON-LD at ${url} — skipped`);
      continue;
    }
    result.push({ url, jsonLd });
    opts?.log?.(`${label}: details ${i + 1}/${detailUrls.length}`);
  }

  return result;
}
