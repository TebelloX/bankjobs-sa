import type { FetchOptions } from '../types';
import type { SrListResponse, SrPostingDetail, SrListPosting, SrRawPosting } from './types';

/**
 * Everything company-specific lives here so a new SmartRecruiters employer is a
 * new config, not new code.
 */
export interface SmartRecruitersConfig {
  /** The company identifier in the URL, e.g. 'standardbankgroup'. */
  company: string;
  /** default 100 — the API's hard page-size cap. */
  pageSize?: number;
  /** default 400 — delay between every network request. */
  delayMs?: number;
}

/**
 * SmartRecruiters' public Posting API has no User-Agent restrictions (verified),
 * so we identify ourselves honestly and never spoof a browser.
 */
export const SMARTRECRUITERS_UA =
  'Mozilla/5.0 (compatible; BankJobsSA/0.1; +https://github.com/bankjobs-sa)';

const API_BASE = 'https://api.smartrecruiters.com/v1/companies';
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_DELAY_MS = 400;
/** Never collect more than this many postings in a single run. */
const SAFETY_CAP = 1000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function srFetch(url: string, opts: FetchOptions | undefined): Promise<Response> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  return fetchImpl(url, {
    headers: { 'User-Agent': SMARTRECRUITERS_UA, Accept: 'application/json' },
  });
}

/** Fetch a single list page. */
export async function fetchPostingsList(
  cfg: SmartRecruitersConfig,
  offset: number,
  opts?: FetchOptions,
): Promise<SrListResponse> {
  const limit = cfg.pageSize ?? DEFAULT_PAGE_SIZE;
  const url = `${API_BASE}/${cfg.company}/postings?limit=${limit}&offset=${offset}`;
  const res = await srFetch(url, opts);
  if (!res.ok) {
    throw new Error(
      `SmartRecruiters list request failed: HTTP ${res.status} for ${url} (offset ${offset})`,
    );
  }
  return (await res.json()) as SrListResponse;
}

/** Fetch a single posting detail. */
export async function fetchPostingDetail(
  cfg: SmartRecruitersConfig,
  id: string,
  opts?: FetchOptions,
): Promise<SrPostingDetail> {
  const url = `${API_BASE}/${cfg.company}/postings/${id}`;
  const res = await srFetch(url, opts);
  if (!res.ok) {
    throw new Error(`SmartRecruiters detail request failed: HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as SrPostingDetail;
}

/**
 * Paginate the list endpoint by `totalFound` (or until the safety cap), then
 * fetch each posting's detail. Sleeps `delayMs` between EVERY network request.
 * Non-OK responses throw with status + url.
 */
export async function fetchAllSmartRecruiters(
  cfg: SmartRecruitersConfig,
  opts?: FetchOptions,
): Promise<SrRawPosting[]> {
  const pageSize = cfg.pageSize ?? DEFAULT_PAGE_SIZE;
  const delayMs = cfg.delayMs ?? DEFAULT_DELAY_MS;
  const label = cfg.company;

  let requestsMade = 0;
  // Space out requests: sleep before every request except the very first.
  const pace = async (): Promise<void> => {
    if (requestsMade > 0) await sleep(delayMs);
    requestsMade += 1;
  };

  const postings: SrListPosting[] = [];
  let total = Number.POSITIVE_INFINITY;
  let offset = 0;

  while (postings.length < total && postings.length < SAFETY_CAP) {
    await pace();
    const data = await fetchPostingsList(cfg, offset, opts);
    total = data.totalFound;

    const page = data.content ?? [];
    if (page.length === 0) break;

    postings.push(...page);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pageNum = Math.floor(offset / pageSize) + 1;
    opts?.log?.(`${label}: page ${pageNum}/${totalPages}`);
    offset += page.length;
  }

  const capped = postings.slice(0, SAFETY_CAP);
  const result: SrRawPosting[] = [];

  for (let i = 0; i < capped.length; i += 1) {
    const listItem = capped[i];
    if (listItem === undefined) continue;
    await pace();
    const detail = await fetchPostingDetail(cfg, listItem.id, opts);
    result.push({ listItem, detail });
    opts?.log?.(`${label}: details ${i + 1}/${capped.length}`);
  }

  return result;
}
