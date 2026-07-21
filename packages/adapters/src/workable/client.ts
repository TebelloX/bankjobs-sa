import type { FetchOptions } from '../types';
import type {
  WorkableJobDetail,
  WorkableListItem,
  WorkableListResponse,
  WorkableRawPosting,
} from './types';

/**
 * Everything employer-specific lives here so a second Workable employer is a new
 * config, not new code. `slug` is the account identifier in the URL, e.g.
 * 'gotyme-za-south-africa'.
 */
export interface WorkableConfig {
  /** Workable account slug, e.g. 'gotyme-za-south-africa'. */
  slug: string;
  /** default 400 — delay between every network request. */
  delayMs?: number;
}

/**
 * Workable's public careers API answers our honest crawler UA with 200 (verified
 * against the list, detail and public job pages 2026-07-21), so — like
 * SmartRecruiters and eArcu — we never spoof a browser.
 */
export const WORKABLE_UA =
  'Mozilla/5.0 (compatible; BankJobsSA/0.1; +https://github.com/bankjobs-sa)';

const APPLY_ORIGIN = 'https://apply.workable.com';
const DEFAULT_DELAY_MS = 400;
/** Never collect more than this many postings in a single run. */
const SAFETY_CAP = 1000;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The stable, cookie-free public job page — the durable apply link. The v3/v1
 * API URLs are machine endpoints, not user-facing; this is the page a candidate
 * lands on and applies from. Verified 200 for a live shortcode 2026-07-21.
 */
export function workableJobUrl(slug: string, shortcode: string): string {
  return `${APPLY_ORIGIN}/${slug}/j/${shortcode}/`;
}

/**
 * Fetch one v3 list page. Page 1 sends `{}`; subsequent pages echo the previous
 * response's `nextPage` cursor back as `{ token }` in the body (GET 404s — the
 * endpoint is POST-only). Non-OK responses throw with status + url.
 */
export async function fetchWorkableJobList(
  cfg: WorkableConfig,
  token: string | undefined,
  opts?: FetchOptions,
): Promise<WorkableListResponse> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const url = `${APPLY_ORIGIN}/api/v3/accounts/${cfg.slug}/jobs`;
  const body = token ? JSON.stringify({ token }) : '{}';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'User-Agent': WORKABLE_UA,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Workable list request failed: HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as WorkableListResponse;
}

/**
 * Fetch one posting's detail (the HTML body lives here, not in the list). Uses
 * the v1 detail endpoint — the v3 API has no per-job GET. Non-OK responses throw
 * with status + url.
 */
export async function fetchWorkableJobDetail(
  cfg: WorkableConfig,
  shortcode: string,
  opts?: FetchOptions,
): Promise<WorkableJobDetail> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const url = `${APPLY_ORIGIN}/api/v1/accounts/${cfg.slug}/jobs/${shortcode}`;
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': WORKABLE_UA, Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Workable detail request failed: HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as WorkableJobDetail;
}

/**
 * Walk every list page via the `nextPage` continuation cursor (or until the
 * safety cap), then fetch each posting's detail. Sleeps `delayMs` between EVERY
 * network request. Non-OK responses throw with status + url.
 */
export async function fetchAllWorkable(
  cfg: WorkableConfig,
  opts?: FetchOptions,
): Promise<WorkableRawPosting[]> {
  const delayMs = cfg.delayMs ?? DEFAULT_DELAY_MS;
  const label = cfg.slug;

  let requestsMade = 0;
  // Space out requests: sleep before every request except the very first.
  const pace = async (): Promise<void> => {
    if (requestsMade > 0) await sleep(delayMs);
    requestsMade += 1;
  };

  const listItems: WorkableListItem[] = [];
  let token: string | undefined;
  let page = 0;

  while (listItems.length < SAFETY_CAP) {
    await pace();
    const data = await fetchWorkableJobList(cfg, token, opts);
    page += 1;
    const results = data.results ?? [];
    listItems.push(...results);
    opts?.log?.(`${label}: page ${page} (+${results.length}, total ${data.total})`);
    if (!data.nextPage || results.length === 0) break;
    token = data.nextPage;
  }

  const capped = listItems.slice(0, SAFETY_CAP);
  const result: WorkableRawPosting[] = [];

  for (let i = 0; i < capped.length; i += 1) {
    const listItem = capped[i];
    if (listItem === undefined) continue;
    await pace();
    const detail = await fetchWorkableJobDetail(cfg, listItem.shortcode, opts);
    result.push({ listItem, detail });
    opts?.log?.(`${label}: details ${i + 1}/${capped.length}`);
  }

  return result;
}
