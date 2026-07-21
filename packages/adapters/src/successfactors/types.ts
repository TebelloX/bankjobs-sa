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
