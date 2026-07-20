/**
 * Workday CXS response shapes, typed from LIVE-captured Absa fixtures
 * (fixtures/absa/, captured 2026-07-20). Only the fields we actually consume
 * are typed; Workday returns many more (facets, questionnaireId, timeLeftToApply,
 * …) that we deliberately omit. Responses are cast, not object-literal-checked,
 * so the extra fields are simply ignored.
 */

/** One posting in a list-page response. `bulletFields` is `[jobReqId, isoDate]`. */
export interface WorkdayListPosting {
  title: string;
  externalPath: string;
  locationsText?: string;
  /** Relative text like "Posted 3 Days Ago" — never use as a date. */
  postedOn?: string;
  remoteType?: string;
  bulletFields: string[];
}

/** The `POST …/jobs` list response. */
export interface WorkdayListResponse {
  total: number;
  jobPostings: WorkdayListPosting[];
}

/**
 * A country reference object. `alpha2Code` is only present on the nested
 * `jobRequisitionLocation.country`, not on the top-level `country` — verified
 * in the fixtures.
 */
export interface WorkdayCountryRef {
  descriptor: string;
  id: string;
  alpha2Code?: string;
}

export interface WorkdayJobRequisitionLocation {
  descriptor: string;
  country?: WorkdayCountryRef;
}

/** The meat of a detail response. */
export interface WorkdayJobPostingInfo {
  id: string;
  title: string;
  /** Messy source HTML — must be run through core's sanitizeDescription. */
  jobDescription: string;
  location: string;
  /**
   * Extra locations for multi-site postings. NOT present in the captured
   * fixtures (single-location only); typed optionally and handled defensively.
   */
  additionalLocations?: string[];
  /** ISO date — this is the canonical posted date. */
  startDate: string;
  postedOn?: string;
  timeType?: string;
  jobReqId: string;
  jobPostingId?: string;
  /** OBJECT, not a string — map `.descriptor` to an ISO alpha-2 code. */
  country?: WorkdayCountryRef;
  jobRequisitionLocation?: WorkdayJobRequisitionLocation;
  remoteType?: string;
  /** Canonical public apply URL. */
  externalUrl: string;
  endDate?: string;
}

export interface WorkdayHiringOrganization {
  name: string;
  url?: string;
}

/** The `GET …{externalPath}` detail response. */
export interface WorkdayJobDetail {
  jobPostingInfo: WorkdayJobPostingInfo;
  hiringOrganization?: WorkdayHiringOrganization;
}

/** The unit a fixture stores: a list item paired with its fetched detail. */
export interface WorkdayRawPosting {
  listItem: WorkdayListPosting;
  detail: WorkdayJobDetail;
}
