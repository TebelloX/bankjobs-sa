import type { FetchOptions } from '../types';
import type { EarcuJobPosting, EarcuRawPosting } from './types';

/**
 * Everything employer-specific lives here so a second eArcu careers site is a
 * new config, not new code. `host` is the careers subdomain (no scheme); the
 * results and grid paths are eArcu-standard and only overridable for a site
 * that has been re-skinned.
 */
export interface EarcuConfig {
  /** Careers host, e.g. 'careers.investec.co.za'. */
  host: string;
  /** default '/jobs/vacancy/find/results/' — the eArcu search results page. */
  resultsPath?: string;
  /** default 400 — delay between every network request. */
  delayMs?: number;
}

/**
 * eArcu answers our honest crawler UA with 200 (verified against the Investec
 * results page, grid endpoint and detail pages 2026-07-21), so — like
 * SmartRecruiters — we never spoof a browser.
 */
export const EARCU_UA = 'Mozilla/5.0 (compatible; BankJobsSA/0.1; +https://github.com/bankjobs-sa)';

const DEFAULT_RESULTS_PATH = '/jobs/vacancy/find/results/';
const DEFAULT_DELAY_MS = 400;
/** Never fetch more than this many detail pages in a single run. */
const SAFETY_CAP = 500;

// eArcu rotates a per-load `pagestamp` token into the results HTML; the grid
// AJAX endpoint requires it plus the session cookies set on that same load.
const GRID_ACTION = 'ajaxaction/posbrowser_gridhandler/';
const PAGESTAMP_RE = /pagestamp=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
// Detail-page links look like /jobs/vacancy/<slug>/<id>/description/ and are
// stable and cookie-free. Tolerant of relative or absolute hrefs.
const DETAIL_URL_RE =
  /(?:https?:\/\/[^\s"'<>]+)?\/jobs\/vacancy\/[^\s"'<>]+?\/\d+\/description\//gi;
const LD_JSON_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
// The detail page's own canonical link is the durable, cookie-free apply URL —
// used to reconstruct `raw.url` from committed HTML fixtures offline.
const CANONICAL_RE = /<link[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["'][^>]*>/i;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The per-load pagestamp from the results HTML, or null if absent. */
export function extractPagestamp(html: string): string | null {
  return PAGESTAMP_RE.exec(html)?.[1] ?? null;
}

/** The canonical detail-page URL declared in a detail page, or null if absent. */
export function extractCanonicalUrl(detailHtml: string): string | null {
  return CANONICAL_RE.exec(detailHtml)?.[1] ?? null;
}

/**
 * Every distinct detail-page URL in a grid HTML fragment, resolved to absolute
 * against `base` and de-duplicated in first-seen order.
 */
export function extractDetailUrls(fragmentHtml: string, base: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of fragmentHtml.matchAll(DETAIL_URL_RE)) {
    let abs: string;
    try {
      abs = new URL(match[0], base).toString();
    } catch {
      continue;
    }
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

/**
 * Turn `set-cookie` response values into a single `Cookie` request header.
 * Node's fetch does not persist cookies, so we collect the name=value pairs and
 * replay them by hand on the grid request.
 */
export function cookieHeaderFrom(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const raw of setCookies) {
    const first = raw.split(';', 1)[0]?.trim();
    if (first && first.includes('=')) pairs.push(first);
  }
  return pairs.join('; ');
}

async function earcuFetch(
  url: string,
  cookie: string | undefined,
  opts: FetchOptions | undefined,
): Promise<Response> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'User-Agent': EARCU_UA };
  if (cookie) {
    headers.Cookie = cookie;
    // The grid endpoint is the site's own XHR; identify the call as such.
    headers['X-Requested-With'] = 'XMLHttpRequest';
  }
  return fetchImpl(url, { headers });
}

/**
 * Fetch every current posting from an eArcu careers site.
 *   1. GET the results page — captures session cookies + the per-load pagestamp.
 *   2. GET the grid AJAX endpoint (cookies + pagestamp) — an HTML fragment whose
 *      anchors are the detail-page URLs. The fragment carries the FULL current
 *      result set for a small employer (verified: all 5 Investec rows in one
 *      fragment, empty gridFooter, no pager), so there is no pagination to walk.
 *   3. GET each cookie-free detail page and parse its JobPosting JSON-LD.
 * Sleeps `delayMs` between EVERY network request. Detail pages whose JSON-LD is
 * missing/unparseable are logged and skipped rather than aborting the run.
 */
export async function fetchAllEarcu(
  cfg: EarcuConfig,
  opts?: FetchOptions,
): Promise<EarcuRawPosting[]> {
  const delayMs = cfg.delayMs ?? DEFAULT_DELAY_MS;
  const resultsPath = cfg.resultsPath ?? DEFAULT_RESULTS_PATH;
  const origin = `https://${cfg.host}`;
  const label = cfg.host;

  let requestsMade = 0;
  const pace = async (): Promise<void> => {
    if (requestsMade > 0) await sleep(delayMs);
    requestsMade += 1;
  };

  // 1) results page → cookies + pagestamp
  await pace();
  const resultsUrl = `${origin}${resultsPath}`;
  const resultsRes = await earcuFetch(resultsUrl, undefined, opts);
  if (!resultsRes.ok) {
    throw new Error(`eArcu results request failed: HTTP ${resultsRes.status} for ${resultsUrl}`);
  }
  const cookie = cookieHeaderFrom(resultsRes.headers.getSetCookie());
  const resultsHtml = await resultsRes.text();
  const pagestamp = extractPagestamp(resultsHtml);
  if (!pagestamp) {
    throw new Error(`eArcu results page carried no pagestamp: ${resultsUrl}`);
  }

  // 2) grid fragment → detail URLs
  await pace();
  const gridUrl = `${origin}${resultsPath}${GRID_ACTION}?pagestamp=${pagestamp}`;
  const gridRes = await earcuFetch(gridUrl, cookie, opts);
  if (!gridRes.ok) {
    throw new Error(`eArcu grid request failed: HTTP ${gridRes.status} for ${gridUrl}`);
  }
  const gridHtml = await gridRes.text();
  const detailUrls = extractDetailUrls(gridHtml, origin).slice(0, SAFETY_CAP);
  opts?.log?.(`${label}: grid returned ${detailUrls.length} vacancies`);

  // 3) detail pages → JobPosting JSON-LD
  const result: EarcuRawPosting[] = [];
  for (let i = 0; i < detailUrls.length; i += 1) {
    const url = detailUrls[i];
    if (url === undefined) continue;
    await pace();
    const res = await earcuFetch(url, undefined, opts);
    if (!res.ok) {
      throw new Error(`eArcu detail request failed: HTTP ${res.status} for ${url}`);
    }
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
