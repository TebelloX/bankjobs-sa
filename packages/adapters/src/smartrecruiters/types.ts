/**
 * SmartRecruiters public Posting API shapes, typed from LIVE-captured Standard
 * Bank fixtures (fixtures/standardbank/, captured 2026-07-20). Only the fields we
 * actually consume are typed; the API returns many more (customField, industry,
 * experienceLevel, latitude/longitude, …) that we deliberately omit. Responses
 * are cast, not object-literal-checked, so the extra fields are simply ignored.
 */

/**
 * A posting location. `country` is a LOWERCASE ISO 3166-1 alpha-2 code
 * ('za', 'im', 'ng') — uppercase it directly, no name mapping needed.
 */
export interface SrLocation {
  city?: string;
  region?: string;
  country: string;
  address?: string;
  postalCode?: string;
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string;
}

/** {id: 'permanent', label: 'Full-time'} — use the label; Part-time exists. */
export interface SrEmploymentType {
  id: string;
  label: string;
}

/** One posting in a list-page response (`GET …/postings?limit&offset`). */
export interface SrListPosting {
  id: string;
  name: string;
  /** Full ISO timestamp; the date part is the canonical posted date. */
  releasedDate: string;
  location: SrLocation;
  typeOfEmployment?: SrEmploymentType;
}

/** The `GET …/postings` list envelope. */
export interface SrListResponse {
  totalFound: number;
  offset: number;
  limit: number;
  content: SrListPosting[];
}

/** One `{title, text}` section of the job ad. */
export interface SrSection {
  title: string;
  text: string;
}

/**
 * The job ad sections. `companyDescription` is generic bank boilerplate and
 * `additionalInformation` is legal boilerplate — both are skipped when building
 * the display HTML.
 */
export interface SrJobAdSections {
  companyDescription?: SrSection;
  jobDescription?: SrSection;
  qualifications?: SrSection;
  additionalInformation?: SrSection;
}

export interface SrJobAd {
  sections: SrJobAdSections;
}

/** The `GET …/postings/{id}` detail response — a list posting plus the job ad. */
export interface SrPostingDetail extends SrListPosting {
  /** Official apply deep link (jobs.smartrecruiters.com/StandardBankGroup/…). */
  applyUrl: string;
  /** The posting page. */
  postingUrl: string;
  jobAd: SrJobAd;
}

/** The unit a fixture stores: a list item paired with its fetched detail. */
export interface SrRawPosting {
  listItem: SrListPosting;
  detail: SrPostingDetail;
}
