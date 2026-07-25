/**
 * Oracle Recruiting Cloud (Fusion HCM "Candidate Experience", CE) REST shapes,
 * typed from LIVE-captured SARB fixtures (fixtures/sarb/, captured 2026-07-21).
 * REST version 11.13.18.05. Only the fields we consume are typed; the payloads
 * carry many more (RequisitionId, GeographyId, facets, lat/long, …) that we
 * deliberately omit. Responses are cast, not object-literal-checked, so the extra
 * fields are simply ignored.
 */

/**
 * A structured work location — the physical office. `TownOrCity` is the city
 * (e.g. 'Pretoria'), `Region3` the province name (e.g. 'Gauteng', informative —
 * normalizeLocation drives the canonical province from the city), `Country` an
 * ISO 3166-1 alpha-2 code (e.g. 'ZA').
 */
export interface OracleWorkLocation {
  TownOrCity?: string;
  Region3?: string;
  Country?: string;
  AddressLine1?: string;
  AddressLine2?: string;
  AddressLine3?: string;
  PostalCode?: string;
  LocationName?: string;
}

/**
 * One requisition summary in a list-page `requisitionList[]`. `Id` (e.g. '1736')
 * is the human req number used in every public URL — the adapter's key; the huge
 * internal `RequisitionId` surrogate is ignored. `PostedDate` is date-only (the
 * detail's `ExternalPostedStartDate` is the full ISO); `PrimaryLocation` is the
 * candidate-facing location label ('City, Country', or a bare country for a
 * nationwide role). `workLocation` is present only when the list request
 * `expand`s it.
 */
export interface OracleListRequisition {
  Id: string;
  Title?: string;
  /** Date-only 'YYYY-MM-DD'. */
  PostedDate?: string;
  ShortDescriptionStr?: string;
  /** 'City, Country' for a located role; a bare country ('South Africa') marks a
   * nationwide/locationless one. */
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  workLocation?: OracleWorkLocation[];
}

/**
 * The `items[0]` container of a list response (`GET …/recruitingCEJobRequisitions`).
 * `TotalJobsCount` is the full inventory size (paginate by it); `requisitionList`
 * holds this page's summaries.
 *
 * CRITICAL QUIRK: omitting `expand=requisitionList.workLocation` still returns 200
 * with the facets populated but NO `requisitionList` key at all (absent, not an
 * empty array). The client asserts the key exists and throws so a silently-wrong
 * request surfaces as a failure, never a plausible "zero jobs" result.
 */
export interface OracleListContainer {
  Offset?: number;
  Limit?: number;
  TotalJobsCount?: number;
  SiteNumber?: string;
  requisitionList?: OracleListRequisition[];
}

/** The list envelope: the container lives at `items[0]`. */
export interface OracleListResponse {
  items: OracleListContainer[];
}

/**
 * The `items[0]` record of a detail response
 * (`GET …/recruitingCEJobRequisitionDetails?expand=all`). A superset of the list
 * summary: adds the full rich HTML body, the full ISO posted timestamp and the
 * structured category/schedule fields. `ExternalPostedEndDate` (expiry) is
 * present but IGNORED — closure is lastSeen-driven, no expiry is ever stored.
 */
export interface OracleRequisitionDetail extends OracleListRequisition {
  /** Full rich HTML description. */
  ExternalDescriptionStr?: string;
  /**
   * Full rich HTML qualifications/requirements block — SARB posts these in a
   * separate Oracle field rather than inlining them in ExternalDescriptionStr.
   * USED: folded into the description at normalize time, or this content (e.g.
   * degree/NQF level, years of experience) would never reach the DB.
   */
  ExternalQualificationsStr?: string;
  /** Full ISO-8601 posted timestamp; its date part is the canonical posted date. */
  ExternalPostedStartDate?: string;
  /** Expiry — IGNORED. */
  ExternalPostedEndDate?: string;
  /** Human category label, e.g. 'Information Technology'. */
  Category?: string;
  /** e.g. 'Operational / Core Function'. */
  JobFunction?: string;
  /** e.g. 'Professional' — a level, not a schedule; reported, not used. */
  RequisitionType?: string;
  /** e.g. 'On-site' ('' on a few roles). */
  WorkplaceType?: string;
  /** Human schedule label, e.g. 'Full time'. */
  JobSchedule?: string;
  JobShift?: string;
  StudyLevel?: string;
}

/** The detail envelope: the record lives at `items[0]`. */
export interface OracleDetailResponse {
  items: OracleRequisitionDetail[];
}

/** The unit a fixture stores and an adapter normalizes: a list item + its detail. */
export interface OracleRawPosting {
  listItem: OracleListRequisition;
  detail: OracleRequisitionDetail;
}
