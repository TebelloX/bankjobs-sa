import type { FetchOptions } from '../types';
import type {
  OracleDetailResponse,
  OracleListContainer,
  OracleListRequisition,
  OracleListResponse,
  OracleRawPosting,
  OracleRequisitionDetail,
} from './types';

/**
 * Everything tenant-specific lives here so a second Oracle Recruiting Cloud
 * employer is a new config, not new code. `siteNumber` is the internal site id
 * the REST finder takes (e.g. 'CX_1002'); `uiSite` is the friendly slug the
 * public job page uses (e.g. 'SARB') — for SARB the two alias the same site.
 */
export interface OracleConfig {
  /** ATS host, e.g. 'fa-evra-saasfaprod1.fa.ocs.oraclecloud.com'. */
  host: string;
  /** Internal site number for the REST finder, e.g. 'CX_1002'. */
  siteNumber: string;
  /** Friendly site slug for the public job-page URL, e.g. 'SARB'. */
  uiSite: string;
  /** default 200 — the list `limit`; up to 200 is verified honored. */
  pageSize?: number;
  /** default 400 — delay between every network request. */
  delayMs?: number;
}

/**
 * Oracle Recruiting Cloud's public Candidate Experience REST API answers our
 * honest crawler UA with 200 (verified against list, detail and the public job
 * page 2026-07-21), so — like SmartRecruiters and Workable — we never spoof a
 * browser. HEAD requests 501; this is a GET-only API.
 */
export const ORACLE_UA =
  'Mozilla/5.0 (compatible; BankJobsSA/0.1; +https://github.com/bankjobs-sa)';

const REST_BASE = '/hcmRestApi/resources/latest';
const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_DELAY_MS = 400;
/** Never collect more than this many postings in a single run. */
const SAFETY_CAP = 1000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The list URL. The ORC `finder` value uses literal `;` and `,` separators
 * (left intact by the URL parser); `expand=requisitionList.workLocation` is
 * MANDATORY — without it the response carries no `requisitionList` key at all.
 */
function listUrl(cfg: OracleConfig, limit: number, offset: number): string {
  const finder = `findReqs;siteNumber=${cfg.siteNumber},limit=${limit},offset=${offset},sortBy=POSTING_DATES_DESC`;
  return `https://${cfg.host}${REST_BASE}/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.workLocation&finder=${finder}`;
}

/**
 * The detail URL. `Id` is kept QUOTED per Oracle convention — this tenant is
 * forgiving of the unquoted form but other ORC tenants are not. The URL parser
 * percent-encodes the quotes (`Id=%221736%22`), which the server accepts.
 */
function detailUrl(cfg: OracleConfig, id: string): string {
  const finder = `ById;Id="${id}",siteNumber=${cfg.siteNumber}`;
  return `https://${cfg.host}${REST_BASE}/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=${finder}`;
}

/**
 * The stable, cookie-free public job page — the durable apply link. The REST
 * endpoints are machine URLs; this is the page a candidate lands on. The page
 * itself is a JS shell (OpenGraph tags only, no JSON-LD), so the REST API is the
 * sole data path — this URL is used only as the link, never fetched for data.
 */
export function oracleJobUrl(cfg: OracleConfig, id: string): string {
  return `https://${cfg.host}/hcmUI/CandidateExperience/en/sites/${cfg.uiSite}/job/${id}`;
}

async function oracleFetch(url: string, opts: FetchOptions | undefined): Promise<Response> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  // Content-Type comes back as application/vnd.oracle.adf.resourcecollection+json
  // — still JSON, so we parse the body and never gate on the MIME type.
  return fetchImpl(url, { headers: { 'User-Agent': ORACLE_UA, Accept: 'application/json' } });
}

/**
 * Fetch one list page and return its `items[0]` container. Non-OK responses
 * throw with status + url. The container is asserted to carry a `requisitionList`
 * key: a missing key means the request lost its `expand` (a silently-wrong 200)
 * and MUST fail loudly rather than look like zero jobs. A present-but-empty array
 * is a real zero and passes through untouched.
 */
export async function fetchOracleJobList(
  cfg: OracleConfig,
  offset: number,
  opts?: FetchOptions,
): Promise<OracleListContainer> {
  const limit = cfg.pageSize ?? DEFAULT_PAGE_SIZE;
  const url = listUrl(cfg, limit, offset);
  const res = await oracleFetch(url, opts);
  if (!res.ok) {
    throw new Error(`Oracle list request failed: HTTP ${res.status} for ${url} (offset ${offset})`);
  }
  const data = (await res.json()) as OracleListResponse;
  const container = data.items?.[0];
  if (!container) {
    throw new Error(`Oracle list response had no items[0] for ${url}`);
  }
  if (!Object.prototype.hasOwnProperty.call(container, 'requisitionList')) {
    throw new Error(
      `Oracle list response is missing the 'requisitionList' key for ${url} — the ` +
        `expand=requisitionList.workLocation param was likely dropped (a facets-only 200); ` +
        `refusing to treat this as zero jobs.`,
    );
  }
  return container;
}

/**
 * Fetch one requisition's detail (the HTML body + structured fields live here,
 * not in the list). Returns the `items[0]` record. Non-OK responses — or a 200
 * with no `items[0]` — throw with status + url.
 */
export async function fetchOracleJobDetail(
  cfg: OracleConfig,
  id: string,
  opts?: FetchOptions,
): Promise<OracleRequisitionDetail> {
  const url = detailUrl(cfg, id);
  const res = await oracleFetch(url, opts);
  if (!res.ok) {
    throw new Error(`Oracle detail request failed: HTTP ${res.status} for ${url}`);
  }
  const data = (await res.json()) as OracleDetailResponse;
  const detail = data.items?.[0];
  if (!detail) {
    throw new Error(`Oracle detail response had no items[0] for ${url}`);
  }
  return detail;
}

/**
 * Paginate the list by `TotalJobsCount` (or until the safety cap), then fetch
 * each requisition's detail. Sleeps `delayMs` between EVERY network request.
 * Non-OK responses throw with status + url.
 */
export async function fetchAllOracle(
  cfg: OracleConfig,
  opts?: FetchOptions,
): Promise<OracleRawPosting[]> {
  const pageSize = cfg.pageSize ?? DEFAULT_PAGE_SIZE;
  const delayMs = cfg.delayMs ?? DEFAULT_DELAY_MS;
  const label = cfg.uiSite;

  let requestsMade = 0;
  // Space out requests: sleep before every request except the very first.
  const pace = async (): Promise<void> => {
    if (requestsMade > 0) await sleep(delayMs);
    requestsMade += 1;
  };

  const listItems: OracleListRequisition[] = [];
  let total = Number.POSITIVE_INFINITY;
  let offset = 0;

  while (listItems.length < total && listItems.length < SAFETY_CAP) {
    await pace();
    const container = await fetchOracleJobList(cfg, offset, opts);
    total = container.TotalJobsCount ?? 0;

    const page = container.requisitionList ?? [];
    if (page.length === 0) break;

    listItems.push(...page);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const pageNum = Math.floor(offset / pageSize) + 1;
    opts?.log?.(`${label}: list page ${pageNum}/${totalPages} (+${page.length}, total ${total})`);
    offset += page.length;
  }

  const capped = listItems.slice(0, SAFETY_CAP);
  const result: OracleRawPosting[] = [];

  for (let i = 0; i < capped.length; i += 1) {
    const listItem = capped[i];
    if (listItem === undefined) continue;
    await pace();
    const detail = await fetchOracleJobDetail(cfg, listItem.Id, opts);
    result.push({ listItem, detail });
    opts?.log?.(`${label}: details ${i + 1}/${capped.length}`);
  }

  return result;
}
