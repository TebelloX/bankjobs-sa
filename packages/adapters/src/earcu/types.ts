/**
 * eArcu ATS shapes, typed from LIVE-captured Investec fixtures
 * (fixtures/investec/, captured 2026-07-21). eArcu detail pages embed a
 * schema.org JobPosting as an `application/ld+json` block; only the fields we
 * actually consume are typed. Blocks are cast, not object-literal-checked, so
 * the many fields we ignore (geo, salaryCurrency, directApply, …) are dropped.
 */

/** schema.org PropertyValue — how eArcu emits the requisition number. */
export interface LdPropertyValue {
  '@type'?: string;
  name?: string;
  /** The requisition number. May be a string ('13787') or, defensively, a number. */
  value?: string | number;
}

/** schema.org PostalAddress. On some postings every field is absent. */
export interface LdPostalAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  /** Country DISPLAY name ('South Africa'), not an ISO code — map via countryCodeFor. */
  addressCountry?: string;
}

export interface LdPlace {
  '@type'?: string;
  address?: LdPostalAddress;
}

/**
 * The JobPosting JSON-LD block. `identifier` is normally a PropertyValue object
 * but the schema also permits a bare string, so both are accepted. `jobLocation`
 * is an array in every captured posting but the schema allows a single object.
 */
export interface EarcuJobPosting {
  '@type'?: string;
  title?: string;
  /** Full HTML description. */
  description?: string;
  /** Templated to today's date on every load — untrusted, never used. */
  datePosted?: string;
  /** Unreliable (sometimes already past on a live job) — ignored entirely. */
  validThrough?: string;
  /** schema.org token, e.g. 'FULL_TIME'. May be a comma list or array. */
  employmentType?: string | string[];
  identifier?: string | LdPropertyValue;
  jobLocation?: LdPlace | LdPlace[];
}

/**
 * The unit a fixture stores and an adapter normalizes: a detail-page URL paired
 * with its parsed JobPosting JSON-LD. The URL is the durable apply link.
 */
export interface EarcuRawPosting {
  url: string;
  jsonLd: EarcuJobPosting;
}
