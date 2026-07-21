/**
 * Workable public careers-API shapes, typed from LIVE-captured fixtures
 * (fixtures/gotyme/, captured 2026-07-21 — the real GoTyme empty list plus a
 * stand-in employer for the populated schema). Only the fields we consume are
 * typed; the API returns many more (accountUid, approvalStatus, language,
 * isInternal, salary, …) that we deliberately omit. Responses are cast, not
 * object-literal-checked, so the extra fields are simply ignored.
 */

/**
 * A posting location. `countryCode` is the ISO alpha-2 the API ships directly
 * and is what the adapter uses; `country` is a DISPLAY name ('South Africa'),
 * kept only as a countryCodeFor fallback for records missing the code.
 */
export interface WorkableLocation {
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string;
}

/**
 * One posting in a v3 list-page response (`POST …/api/v3/accounts/{slug}/jobs`).
 * `shortcode` is the stable requisition id used in the public job URL; `type` is
 * the employment token ('full', 'part', …); `published` is a full ISO timestamp
 * whose date part is the canonical posted date; `department` is a label array.
 */
export interface WorkableListItem {
  id: number;
  shortcode: string;
  title: string;
  remote?: boolean;
  workplace?: string;
  location?: WorkableLocation;
  locations?: WorkableLocation[];
  state?: string;
  /** Full ISO timestamp, e.g. '2026-06-22T00:00:00.000Z'. */
  published?: string;
  /** Employment token: 'full' | 'part' | 'contract' | 'temporary' | 'internship' | … */
  type?: string;
  department?: string[];
}

/**
 * The v3 list envelope. `nextPage` is an opaque continuation cursor present only
 * while more pages remain; it is echoed back in the NEXT request body as
 * `{ token: nextPage }` (verified — the field names differ between response and
 * request). Its absence marks the last page.
 */
export interface WorkableListResponse {
  total: number;
  results: WorkableListItem[];
  nextPage?: string;
}

/**
 * The v1 detail response (`GET …/api/v1/accounts/{slug}/jobs/{shortcode}`) — a
 * superset of the list item that additionally carries the HTML body split across
 * `description`, `requirements` and `benefits`. There is no apply-URL field; the
 * public job page is reconstructed from slug + shortcode.
 */
export interface WorkableJobDetail extends WorkableListItem {
  description?: string;
  requirements?: string;
  benefits?: string;
}

/** The unit a fixture stores and an adapter normalizes: a list item + its detail. */
export interface WorkableRawPosting {
  listItem: WorkableListItem;
  detail: WorkableJobDetail;
}
