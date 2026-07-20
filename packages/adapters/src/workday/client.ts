import type { FetchOptions } from '../types';
import type {
  WorkdayJobDetail,
  WorkdayListPosting,
  WorkdayListResponse,
  WorkdayRawPosting,
} from './types';

/**
 * Everything tenant-specific lives here so a new Workday bank (e.g. FirstRand)
 * is a new config, not new code.
 */
export interface WorkdayConfig {
  host: string;
  tenant: string;
  site: string;
  /** default 20 — verified server cap; larger limits are ignored by Workday. */
  pageSize?: number;
  /** default 400 — delay between every network request. */
  delayMs?: number;
}

/**
 * User-Agent policy (there is a real tension here):
 * We would prefer to identify our crawler honestly, so we try HONEST_UA first.
 * Workday, however, answers 406 Not Acceptable to non-browser User-Agents
 * (verified against the Absa endpoint). So on the FIRST request of a run we try
 * the honest token; if it is rejected with 406 we retry that request once with
 * a browser UA and then reuse the browser UA for the rest of the run. The choice
 * is threaded through the call chain (resolved once in `fetchAllWorkday` and
 * passed down) rather than kept in module-level mutable state, so concurrent
 * runs never clobber each other.
 */
export const HONEST_UA =
  'Mozilla/5.0 (compatible; BankJobsSA/0.1; +https://github.com/bankjobs-sa)';
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_DELAY_MS = 400;
/** Never collect more than this many postings in a single run. */
const SAFETY_CAP = 1000;

function withUserAgent(init: RequestInit, ua: string): RequestInit {
  return {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      'User-Agent': ua,
    },
  };
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Perform one request. When `forcedUa` is set (every request after the first of
 * a run) we use it directly. Otherwise we try the honest UA and, on a single
 * 406, retry once with the browser UA. Returns the response together with the UA
 * that actually got a reply, so the caller can reuse it.
 */
async function fetchWithUaStrategy(
  url: string,
  init: RequestInit,
  opts: FetchOptions | undefined,
  forcedUa: string | undefined,
): Promise<{ res: Response; usedUa: string }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;

  if (forcedUa !== undefined) {
    const res = await fetchImpl(url, withUserAgent(init, forcedUa));
    return { res, usedUa: forcedUa };
  }

  const res = await fetchImpl(url, withUserAgent(init, HONEST_UA));
  if (res.status === 406) {
    opts?.log?.('workday: honest User-Agent got 406, retrying once with a browser User-Agent');
    const retry = await fetchImpl(url, withUserAgent(init, BROWSER_UA));
    return { res: retry, usedUa: BROWSER_UA };
  }
  return { res, usedUa: HONEST_UA };
}

async function requestJobList(
  cfg: WorkdayConfig,
  offset: number,
  opts: FetchOptions | undefined,
  forcedUa: string | undefined,
): Promise<{ data: WorkdayListResponse; usedUa: string }> {
  const url = `https://${cfg.host}/wday/cxs/${cfg.tenant}/${cfg.site}/jobs`;
  const limit = cfg.pageSize ?? DEFAULT_PAGE_SIZE;
  const body = JSON.stringify({ appliedFacets: {}, limit, offset, searchText: '' });

  const { res, usedUa } = await fetchWithUaStrategy(
    url,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body,
    },
    opts,
    forcedUa,
  );

  if (!res.ok) {
    throw new Error(
      `Workday list request failed: HTTP ${res.status} for ${url} (offset ${offset})`,
    );
  }

  const data = (await res.json()) as WorkdayListResponse;
  return { data, usedUa };
}

async function requestJobDetail(
  cfg: WorkdayConfig,
  externalPath: string,
  opts: FetchOptions | undefined,
  forcedUa: string | undefined,
): Promise<{ data: WorkdayJobDetail; usedUa: string }> {
  const url = `https://${cfg.host}/wday/cxs/${cfg.tenant}/${cfg.site}${externalPath}`;

  const { res, usedUa } = await fetchWithUaStrategy(
    url,
    { headers: { Accept: 'application/json' } },
    opts,
    forcedUa,
  );

  if (!res.ok) {
    throw new Error(`Workday detail request failed: HTTP ${res.status} for ${url}`);
  }

  const data = (await res.json()) as WorkdayJobDetail;
  return { data, usedUa };
}

/** Fetch a single list page (POST). */
export async function fetchJobList(
  cfg: WorkdayConfig,
  offset: number,
  opts?: FetchOptions,
): Promise<WorkdayListResponse> {
  const { data } = await requestJobList(cfg, offset, opts, undefined);
  return data;
}

/** Fetch a single job detail (GET). `externalPath` starts with '/job/…'. */
export async function fetchJobDetail(
  cfg: WorkdayConfig,
  externalPath: string,
  opts?: FetchOptions,
): Promise<WorkdayJobDetail> {
  const { data } = await requestJobDetail(cfg, externalPath, opts, undefined);
  return data;
}

/**
 * Paginate the list endpoint until we have every posting (or hit the safety
 * cap), then fetch each posting's detail. Sleeps `delayMs` between EVERY network
 * request. The UA is resolved once (honest → browser on 406) and reused for the
 * whole run. Non-OK responses (after the one 406 retry) throw with status + url.
 */
export async function fetchAllWorkday(
  cfg: WorkdayConfig,
  opts?: FetchOptions,
): Promise<WorkdayRawPosting[]> {
  const pageSize = cfg.pageSize ?? DEFAULT_PAGE_SIZE;
  const delayMs = cfg.delayMs ?? DEFAULT_DELAY_MS;
  const label = cfg.tenant;

  let requestsMade = 0;
  // Space out requests: sleep before every request except the very first.
  const pace = async (): Promise<void> => {
    if (requestsMade > 0) await sleep(delayMs);
    requestsMade += 1;
  };

  const postings: WorkdayListPosting[] = [];
  let total = Number.POSITIVE_INFINITY;
  let usedUa: string | undefined;
  let offset = 0;

  while (postings.length < total && postings.length < SAFETY_CAP) {
    await pace();
    const { data, usedUa: ua } = await requestJobList(cfg, offset, opts, usedUa);
    usedUa = ua;
    // Workday reports the real total only on the first page; later pages return
    // total: 0 while still carrying postings. Ignore non-positive totals and rely
    // on the empty-page break to terminate.
    if (data.total > 0) total = data.total;

    const page = data.jobPostings ?? [];
    if (page.length === 0) break;

    postings.push(...page);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pageNum = Math.floor(offset / pageSize) + 1;
    opts?.log?.(`${label}: page ${pageNum}/${totalPages}`);
    offset += page.length;
  }

  const capped = postings.slice(0, SAFETY_CAP);

  // Some postings are malformed/hidden: no title and no externalPath (e.g.
  // bulletFields ['R51859','Permanent','FNB'] with neither). They cannot be
  // fetched or normalized, so drop them before the detail pass and report how
  // many were skipped.
  const fetchable = capped.filter((li) => Boolean(li.externalPath) && Boolean(li.title));
  const skipped = capped.length - fetchable.length;
  if (skipped > 0) opts?.log?.(`${label}: skipped ${skipped} malformed list items`);

  const result: WorkdayRawPosting[] = [];

  for (let i = 0; i < fetchable.length; i += 1) {
    const listItem = fetchable[i];
    if (listItem === undefined) continue;
    await pace();
    const { data, usedUa: ua } = await requestJobDetail(cfg, listItem.externalPath, opts, usedUa);
    usedUa = ua;
    result.push({ listItem, detail: data });
    opts?.log?.(`${label}: details ${i + 1}/${fetchable.length}`);
  }

  return result;
}
