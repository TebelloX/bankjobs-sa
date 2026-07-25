/** One row of the Postbank careers table, before the PDF advert is fetched. */
export interface PostbankVacancy {
  /**
   * Stable id, slugged from the advert's PDF FILENAME — the only durable
   * identifier this source has (there is no requisition number anywhere, on the
   * page or in the advert). A re-advertised role gets a new PDF and therefore a
   * new id, which is correct: it is a new posting with a new closing date.
   */
  slug: string;
  /** The anchor's text, as published (Postbank writes titles in CAPS). */
  title: string;
  /** The location cell verbatim, e.g. 'PRETORIA' or 'JOHANNESBURG\\BLOEMFONTEIN'. */
  rawLocation: string;
  /** Closing date as printed, e.g. '03 August 2026'. */
  closingDateRaw: string;
  /** Closing date as YYYY-MM-DD, or null when the printed date did not parse. */
  closingDate: string | null;
  /** Absolute, percent-encoded URL of the advert PDF. */
  pdfUrl: string;
}

/**
 * A vacancy row paired with its advert. The PDF IS the job ad — the careers
 * table carries only title/location/closing date — so `advertHtml` is the
 * layout-reconstructed advert, already assembled into simple block HTML and
 * ready for core's `sanitizeDescription`.
 */
export interface PostbankRawPosting {
  vacancy: PostbankVacancy;
  advertHtml: string;
}
