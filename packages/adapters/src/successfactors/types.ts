/**
 * SAP SuccessFactors Career Site Builder (CSB) shapes, typed from the LIVE
 * Google-for-Jobs feed a CSB tenant exposes (verified against jobs.nedbank.co.za
 * 2026-07-21). The feed path is mislabelled `/sitemap.xml` but is an <rss>
 * <channel> document with a `g:` namespace — one <item> per open role, uncapped,
 * cold-fetchable with no cookies/auth. Only the fields we consume are typed.
 */

/**
 * One <item> from the feed. Every field is XML-entity-decoded by the parser, so
 * `jobFunction` is 'Administration & Operations' (not '…&amp;…') and
 * `description` is real HTML (the CDATA payload carries HTML-encoded HTML —
 * `&lt;p&gt;…` — which the parser un-escapes to `<p>…`).
 */
export interface SfFeedItem {
  /** g:id — the numeric SuccessFactors posting id (equals guid and the URL id;
   * distinct from the internal REQ ID that appears free-text in the body). */
  id: string;
  title: string;
  /** Public job-detail page URL (also the durable apply link). */
  link: string;
  /** g:location, formatted 'City, CC' (e.g. 'Johannesburg, ZA', 'Mariental, NA'). */
  location: string;
  /** g:job_function — the tenant's job-function label. */
  jobFunction: string;
  /** g:employer. */
  employer: string;
  /** The decoded description HTML (CDATA payload un-escaped to real HTML). */
  description: string;
}

/**
 * The unit a fixture stores and the adapter normalizes: a feed item plus the
 * postedDate enriched (non-fatally) from its detail page, or null when the
 * enrichment fetch/extraction missed. `normalize` reads only this, so it stays
 * pure and offline-testable.
 */
export interface SfRawPosting {
  item: SfFeedItem;
  postedDate: string | null;
}

/**
 * A posting acquired via the SITEMAP-driven path (Discovery). Some CSB tenants
 * serve a genuine URL sitemap at `/sitemap.xml` — a `<urlset>` whose every
 * `<loc>` is a job detail page — rather than the Google-for-Jobs RSS the feed
 * path consumes. Every field here is parsed from the detail page, so unlike the
 * feed path the detail page is LOAD-BEARING: a page missing jobId or title is
 * skipped upstream (never emitted), so both are always present here.
 *
 * `normalize` reads only this record, so it stays pure and offline-testable.
 */
export interface SfSitemapPosting {
  /** Numeric SuccessFactors posting id, taken from the detail-page URL. */
  jobId: string;
  /** The public detail-page URL (also the durable apply link). */
  url: string;
  title: string;
  /** The 'Business Unit' labelled field (customfield1), e.g. 'Discovery Bank'
   * — a group-wide CSB site tags each posting with its brand here. '' on a
   * single-brand tenant (Capitec) that carries no labelled fields. */
  businessUnit: string;
  /** The 'Function' labelled field (department), e.g. 'Banking' — folds into
   * the categorize haystack alongside the title. '' when the tenant carries no
   * labelled department field. */
  jobFunction: string;
  /** The description HTML from the detail page (schema.org `description`). */
  description: string;
  /** The posting's city string: schema.org `addressLocality` microdata (e.g.
   * 'Sandton - 1 Discovery Place', where the CSB combines suburb + building), or
   * the city parsed from a single `streetAddress` ('Sandton, ZA' → 'Sandton').
   * '' for a nationwide/pipeline role with no city — normalizeLocation resolves
   * the rest. */
  locality: string;
  /** ISO alpha-2 country: schema.org `addressCountry` microdata ('ZA') or the
   * trailing token of a `streetAddress`. Emitted as a code directly, not a
   * display name; '' when no address microdata is present. */
  country: string;
  /** YYYY-MM-DD from the datePosted microdata, or null (tolerant). */
  postedDate: string | null;
}
