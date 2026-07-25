import { extractTextItems, getDocumentProxy } from 'unpdf';

/**
 * Layout-aware text extraction for sources whose job ad IS a PDF advert.
 *
 * WHY NOT `extractText()`: unpdf's convenience helper concatenates PDF.js text
 * items in CONTENT-STREAM order, which is the order the generator emitted the
 * drawing operations — not reading order. Postbank's adverts are built from
 * floating text boxes, so a stream-order read hoists every section heading to
 * the top of its page:
 *
 *     Page | 1 / Job Responsibilities / Minimum Requirements / Purpose of the
 *     Job / JOB TITLE : SPECIALIST ARCHITECT / …
 *
 * That is fatal downstream, because core's requirements extractor is
 * heading-WINDOWED: it reads the 450 characters that FOLLOW "minimum
 * requirements". With the headings detached from their content, the window over
 * "Minimum Requirements" contains the purpose blurb and the qualifications
 * block is never read — /fit/ would score the role on nothing.
 *
 * So we reconstruct reading order from geometry instead: PDF.js gives every
 * item its position in PDF user space (origin bottom-left, y grows UPWARD), so
 * grouping items into lines by y and sorting lines top-down (y descending) then
 * left-to-right restores the visual order exactly. Verified against the real
 * Postbank adverts: headings land back on top of their own sections.
 *
 * Single-column layouts only. A two-column PDF would interleave its columns
 * under this model — no such source exists here, and a column-splitting pass
 * would be guesswork until one does.
 */

/** One reconstructed visual line of a PDF page. */
export interface PdfLine {
  /** 1-based page number. */
  page: number;
  /** The line's text, inner whitespace collapsed. */
  text: string;
  /** Left edge (PDF user space, points) of the line's leftmost item. */
  x: number;
  /** Baseline y (PDF user space, points; larger = higher on the page). */
  y: number;
  /** Tallest glyph height on the line, in points. */
  height: number;
  /**
   * Vertical distance from the previous line's baseline, in points; `null` for
   * the first line of a page. A value materially larger than the line height is
   * the source's own paragraph break — the only blank-line signal a PDF has.
   */
  gapBefore: number | null;
}

/**
 * Items whose baselines are within this many points are the same visual line.
 * Postbank's body leading is ~12pt and superscripts/bullets sit within ~2pt of
 * their baseline, so 2.5 merges a line without ever merging two.
 */
const LINE_TOLERANCE_PT = 2.5;

interface TextItem {
  str: string;
  x: number;
  y: number;
  height: number;
}

/** Group one page's items into visual lines, ordered top-down then left-right. */
function linesForPage(items: TextItem[], page: number): PdfLine[] {
  const buckets: { y: number; height: number; parts: { x: number; str: string }[] }[] = [];

  for (const item of items) {
    if (item.str.trim() === '') continue;
    let bucket = buckets.find((b) => Math.abs(b.y - item.y) <= LINE_TOLERANCE_PT);
    if (bucket === undefined) {
      bucket = { y: item.y, height: 0, parts: [] };
      buckets.push(bucket);
    }
    bucket.parts.push({ x: item.x, str: item.str });
    if (item.height > bucket.height) bucket.height = item.height;
  }

  // y DESCENDING: PDF user space puts the origin at the bottom-left.
  buckets.sort((a, b) => b.y - a.y);

  const lines: PdfLine[] = [];
  let previousY: number | null = null;
  for (const bucket of buckets) {
    bucket.parts.sort((a, b) => a.x - b.x);
    // Join with a space, then collapse: PDF.js splits a line into one item per
    // font run, and the runs carry no spacing of their own.
    const text = bucket.parts
      .map((p) => p.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === '') continue;
    lines.push({
      page,
      text,
      x: Math.min(...bucket.parts.map((p) => p.x)),
      y: bucket.y,
      height: bucket.height,
      gapBefore: previousY === null ? null : previousY - bucket.y,
    });
    previousY = bucket.y;
  }
  return lines;
}

/**
 * Extract a PDF's text as reconstructed visual lines, in reading order across
 * every page. Throws whatever PDF.js throws for an unparseable/encrypted file —
 * callers decide whether one bad advert is fatal (it never is here: the house
 * rule is skip-and-log per posting).
 *
 * The input is COPIED first: PDF.js takes ownership of the array it is handed
 * and detaches the underlying buffer, so a caller that still needs its bytes
 * afterwards (to write a fixture, to hash) would otherwise find them gone.
 *
 * `verbosity: 0` silences PDF.js's per-font console warnings; the Postbank
 * adverts subset their fonts, which makes it warn on every single page.
 */
export async function extractPdfLines(bytes: Uint8Array): Promise<PdfLine[]> {
  const doc = await getDocumentProxy(bytes.slice(), { verbosity: 0 });
  const { items } = await extractTextItems(doc);

  const lines: PdfLine[] = [];
  items.forEach((pageItems, index) => {
    lines.push(...linesForPage(pageItems, index + 1));
  });
  return lines;
}
