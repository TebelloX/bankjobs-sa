import { describeError } from '@bankjobs/core';

import type { FetchOptions } from '../types';
import type { PdfLine } from '../pdf/client';
import { extractPdfLines } from '../pdf/client';
import type { PostbankRawPosting, PostbankVacancy } from './types';

/**
 * Everything site-specific for the South African Postbank careers page. There is
 * no ATS behind this one: `careers.html` is a hand-maintained, server-rendered
 * HTML table and each row links a PDF advert. Verified live 2026-07-25.
 */
export interface PostbankConfig {
  /** Careers host, no scheme. */
  host: string;
  /** default '/careers.html' — the single listing page. */
  careersPath?: string;
  /** default 400 — delay between every network request. */
  delayMs?: number;
}

/**
 * The careers page and every advert PDF answer our honest crawler UA with 200
 * (verified 2026-07-25), so — like SmartRecruiters, eArcu, Workable and
 * SuccessFactors — we never spoof a browser.
 */
export const POSTBANK_UA =
  'Mozilla/5.0 (compatible; BankJobsSA/0.1; +https://github.com/bankjobs-sa)';

const DEFAULT_CAREERS_PATH = '/careers.html';
const DEFAULT_DELAY_MS = 400;
/**
 * Never fetch more than this many adverts in a single run. Only unexpired rows
 * are ever fetched (a handful), so this is a runaway guard, not a page size.
 */
const SAFETY_CAP = 60;

/** SAST is UTC+02:00 year-round — South Africa has never observed DST. */
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

const TABLE_ROW_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const TABLE_CELL_RE = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
const ANCHOR_RE = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i;

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The careers listing URL for a config. */
export function careersUrl(config: PostbankConfig): string {
  return `https://${config.host}${config.careersPath ?? DEFAULT_CAREERS_PATH}`;
}

/**
 * The only entity on the page is `&nbsp;` (verified: it is the sole entity in
 * the captured HTML), but the basic five are decoded anyway so a future edit
 * cannot leak a literal `&amp;` into a title. `&amp;` goes last so `&amp;lt;`
 * never double-decodes.
 */
function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** Strip tags, decode entities, collapse whitespace. */
function cellText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 'Advert_Specialist Architect 2026.pdf' → 'advert-specialist-architect-2026'.
 * The same rule core's `jobSlug` uses, applied to the PDF's basename: lowercase,
 * runs of non-alphanumerics collapse to one '-'. That folds away every one of
 * this site's filename quirks at once — the raw spaces, the double spaces
 * ('Advert  Team Lead …'), the stray underscore-space ('Advert _Team Lead …'),
 * the en-dashes and the ampersands — while keeping distinct adverts distinct.
 */
function slugForPdf(pdfPath: string): string {
  const base = pdfPath.split('/').pop() ?? pdfPath;
  return base
    .replace(/\.pdf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Resolve a careers-table href to an absolute, percent-encoded PDF URL.
 *
 * The hrefs are WINDOWS paths written straight into the HTML —
 * `vacancies\Advert_Specialist Architect 2026.pdf` — with raw spaces and,
 * on some rows, en-dashes and ampersands. Normalising `\` to `/` and handing the
 * result to the WHATWG URL parser does the rest: it percent-encodes the spaces
 * and non-ASCII bytes exactly as the server expects (verified: every encoded URL
 * returns 200). Returns null for an href that will not resolve.
 */
export function resolveAdvertUrl(href: string, baseUrl: string): string | null {
  try {
    return new URL(href.trim().replace(/\\/g, '/'), baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Parse a printed closing date ('03 August 2026') to 'YYYY-MM-DD', or null when
 * it does not parse. Never guesses: an unreadable date makes the row unusable,
 * and the caller drops it rather than publish an ad that may have closed months
 * ago (see {@link partitionByClosingDate}).
 */
export function parseClosingDate(printed: string): string | null {
  const match = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/.exec(printed.trim());
  if (!match) return null;

  const [, dayStr, monthName, yearStr] = match;
  const month = MONTHS[(monthName ?? '').toLowerCase()];
  if (month === undefined) return null;

  const day = Number(dayStr);
  const year = Number(yearStr);
  // Reject impossible dates ('31 February 2026') by round-tripping through UTC.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1) return null;
  if (date.getUTCDate() !== day) return null;

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Today's calendar date in South Africa (UTC+2, no DST) as 'YYYY-MM-DD'. */
export function sastDate(now: Date): string {
  return new Date(now.getTime() + SAST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Every vacancy row on the careers page, in page order.
 *
 * A row counts only when it has exactly three cells and the first links a PDF —
 * which excludes the page's banner row (a single `colspan="3"` cell carrying the
 * scam warning and the 'Consent forms' link) and the Position/Location/Closing
 * Date header row, without either being special-cased by position.
 */
export function parseVacancies(html: string, baseUrl: string): PostbankVacancy[] {
  const vacancies: PostbankVacancy[] = [];

  for (const row of html.matchAll(TABLE_ROW_RE)) {
    const rowHtml = row[1] ?? '';
    const cells = [...rowHtml.matchAll(TABLE_CELL_RE)].map((m) => m[1] ?? '');
    if (cells.length !== 3) continue;

    const anchor = ANCHOR_RE.exec(cells[0] ?? '');
    if (!anchor) continue;
    const href = anchor[1] ?? '';
    if (!/\.pdf$/i.test(href.trim())) continue;

    const pdfUrl = resolveAdvertUrl(href, baseUrl);
    if (pdfUrl === null) continue;

    const slug = slugForPdf(href.replace(/\\/g, '/'));
    if (slug === '') continue;

    const closingDateRaw = cellText(cells[2] ?? '');
    vacancies.push({
      slug,
      title: cellText(anchor[2] ?? ''),
      rawLocation: cellText(cells[1] ?? ''),
      closingDateRaw,
      closingDate: parseClosingDate(closingDateRaw),
      pdfUrl,
    });
  }

  return vacancies;
}

export interface VacancyPartition {
  /** Rows still open: closing date >= today in SAST (a row closing TODAY is open). */
  open: PostbankVacancy[];
  /** Rows whose closing date has passed. */
  expired: PostbankVacancy[];
  /** Rows whose printed closing date did not parse — dropped, never published. */
  unparsed: PostbankVacancy[];
}

/**
 * Split the table by closing date against `today` ('YYYY-MM-DD', SAST).
 *
 * THIS FILTER IS THE ADAPTER. Postbank never removes a closed advert: the page
 * carries every ad it has run this year (64 rows on 2026-07-25, of which 2 were
 * still open), so publishing the table as-is would fill the site with roles that
 * closed months ago. ISO dates compare correctly as strings, and `>=` keeps a
 * role closing today — applications close at the END of the closing date.
 *
 * An unparseable date is dropped, NOT kept: the alternative is publishing an ad
 * that may have closed in January. One-off drops are logged; a systemic date
 * format change collapses the open count, which the ingest run's count-drop
 * guardrail catches.
 */
export function partitionByClosingDate(
  vacancies: PostbankVacancy[],
  today: string,
): VacancyPartition {
  const partition: VacancyPartition = { open: [], expired: [], unparsed: [] };
  for (const vacancy of vacancies) {
    if (vacancy.closingDate === null) partition.unparsed.push(vacancy);
    else if (vacancy.closingDate >= today) partition.open.push(vacancy);
    else partition.expired.push(vacancy);
  }
  return partition;
}

// ---------------------------------------------------------------------------
// Advert PDF → block HTML
// ---------------------------------------------------------------------------

/** Page furniture that is not part of the ad. */
const DROP_LINE_PATTERNS: readonly RegExp[] = [
  /^page\s*\|?\s*\d+$/i, // 'Page | 1' footer
  /^vacanc(?:y|ies)$/i, // the decorative banner over the metadata block
  /^[•▪‣·o*-]$/, // a bullet glyph orphaned onto its own line
];

/**
 * The advert template's section headings, matched against a whole line (its
 * trailing colon already stripped). Derived from the real adverts, never
 * guessed; an unlisted heading degrades to a paragraph rather than being lost.
 *
 * Getting these right is load-bearing beyond looks: core's requirements
 * extractor reads the 450 characters FOLLOWING 'minimum requirements' /
 * 'qualifications', so these lines have to survive into `descriptionText`
 * immediately ahead of the qualifications block — which is exactly what the
 * layout-ordered extraction plus these headings produce.
 */
const HEADING_PATTERNS: readonly RegExp[] = [
  /^purpose(?: of the job| statement)?$/i,
  /^(?:key |main )?(?:job )?responsibilit(?:y|ies)$/i,
  /^(?:minimum |essential |role )?requirements?$/i,
  /^minimum qualifications?(?: and experience)?(?: required)?$/i,
  /^qualifications?(?: and experience)?$/i,
  /^experience(?: and knowledge(?: of)?)?$/i,
  /^knowledge(?: and understanding)?(?: of)?$/i,
  /^(?:key )?skills(?: (?:&|and) attributes)?$/i,
  /^attributes$/i,
  /^competenc(?:y|ies)$/i,
  /^how to apply$/i,
  /^closing date$/i,
  /^disclaimers?$/i,
];

/**
 * The advert's metadata block: an ALL-CAPS label, a colon, then the value
 * ('JOB TITLE : SPECIALIST ARCHITECT', 'LOCATION : HEAD OFFICE: PRETORIA').
 * Each is one logical row, so it is emitted as its own paragraph instead of
 * being flowed together with its neighbours by the paragraph merger below.
 */
const METADATA_RE = /^([A-Z][A-Z0-9]*(?:[ _/][A-Z0-9]+){0,3})\s*:\s*(\S.*)$/;

/** The bullet glyphs the adverts use — U+2022 today, the rest defensively. */
const BULLET_RE = /^[•▪‣·]\s*/;

/**
 * A line whose baseline sits more than this multiple of its own height below the
 * previous one starts a new block. Measured: the adverts run ~1.25x leading
 * inside a paragraph and ~2x between paragraphs, so 1.5 separates them cleanly.
 */
const PARAGRAPH_GAP_RATIO = 1.5;

/**
 * A non-bullet line indented at least this many points past the bullet that
 * opened the current list item is that item's WRAPPED CONTINUATION, not new
 * prose. Measured: continuations sit exactly 18pt past their bullet.
 */
const CONTINUATION_INDENT_PT = 6;

/** One block of a parsed advert: a section heading, a paragraph or a list. */
export type AdvertBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] };

function headingTextFor(line: string): string | null {
  const stripped = line.replace(/\s*:\s*$/, '').trim();
  if (stripped === '' || stripped.length > 64) return null;
  return HEADING_PATTERNS.some((p) => p.test(stripped)) ? stripped : null;
}

/**
 * Turn layout-ordered PDF lines into the advert's blocks: headings, paragraphs
 * and bullet lists. Wrapped lines are rejoined — a PDF has no paragraphs, only
 * positioned lines, so the vertical gap and the left indent are the only
 * evidence of where one block ends and the next begins.
 */
export function advertBlocks(lines: readonly PdfLine[]): AdvertBlock[] {
  const blocks: AdvertBlock[] = [];
  let list: { items: string[]; bulletX: number } | null = null;
  let paragraph: string[] | null = null;

  const closeParagraph = (): void => {
    if (paragraph !== null && paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    }
    paragraph = null;
  };
  const closeList = (): void => {
    if (list !== null && list.items.length > 0) blocks.push({ kind: 'list', items: list.items });
    list = null;
  };

  for (const line of lines) {
    const text = line.text.trim();
    if (text === '' || DROP_LINE_PATTERNS.some((p) => p.test(text))) continue;

    const heading = headingTextFor(text);
    if (heading !== null) {
      closeParagraph();
      closeList();
      blocks.push({ kind: 'heading', text: heading });
      continue;
    }

    if (BULLET_RE.test(text)) {
      closeParagraph();
      const item = text.replace(BULLET_RE, '').trim();
      if (list === null) list = { items: [], bulletX: line.x };
      // A deeper-indented bullet run is still one list here: the adverts nest at
      // most one level and a flat list reads the same after sanitizing.
      if (item !== '') list.items.push(item);
      continue;
    }

    // Wrapped continuation of the open list item.
    if (list !== null && list.items.length > 0 && line.x >= list.bulletX + CONTINUATION_INDENT_PT) {
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last] ?? ''} ${text}`.trim();
      continue;
    }

    closeList();

    const metadata = METADATA_RE.exec(text);
    if (metadata) {
      closeParagraph();
      blocks.push({ kind: 'paragraph', text: `${metadata[1]}: ${metadata[2]}` });
      continue;
    }

    const newBlock = line.gapBefore === null || line.gapBefore > line.height * PARAGRAPH_GAP_RATIO;
    if (newBlock) closeParagraph();
    if (paragraph === null) paragraph = [];
    paragraph.push(text);
  }

  closeParagraph();
  closeList();
  return blocks;
}

/**
 * Assemble an advert's blocks into the simple HTML core's `sanitizeDescription`
 * keeps: `<h3>`, `<p>`, `<ul>/<li>`. Text is escaped here, before assembly, so a
 * stray '<' in an advert can never be read as markup.
 */
export function blocksToHtml(blocks: readonly AdvertBlock[]): string {
  const out: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'heading') out.push(`<h3>${escapeHtml(block.text)}</h3>`);
    else if (block.kind === 'paragraph') out.push(`<p>${escapeHtml(block.text)}</p>`);
    else out.push(`<ul>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul>`);
  }
  return out.join('');
}

/** An advert PDF's bytes → the block HTML for its description. */
export async function advertHtmlFromPdf(bytes: Uint8Array): Promise<string> {
  return blocksToHtml(advertBlocks(await extractPdfLines(bytes)));
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Fetch the careers table, drop every closed advert, then fetch and extract the
 * PDF for each row that is still open.
 *
 * The listing is load-bearing (a non-200, or a page that parses to zero rows,
 * throws — the source has never had an empty table). An individual advert is
 * not: a PDF that 404s or will not parse is logged and skipped, so one bad file
 * cannot take the whole bank offline. That is the Discovery/SuccessFactors
 * detail-page precedent, applied to a source where the detail IS the ad.
 */
export async function fetchAllPostbank(
  config: PostbankConfig,
  opts?: FetchOptions,
): Promise<PostbankRawPosting[]> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const log = opts?.log ?? ((): void => {});
  const delayMs = config.delayMs ?? DEFAULT_DELAY_MS;
  const listUrl = careersUrl(config);

  const res = await fetchImpl(listUrl, {
    headers: { 'User-Agent': POSTBANK_UA, Accept: 'text/html' },
  });
  if (!res.ok) {
    throw new Error(`postbank: careers page ${listUrl} returned HTTP ${res.status}`);
  }
  const html = await res.text();

  const vacancies = parseVacancies(html, listUrl);
  if (vacancies.length === 0) {
    throw new Error(
      `postbank: careers page parsed to zero vacancy rows — the table markup may have drifted (${listUrl})`,
    );
  }

  const today = sastDate(new Date());
  const { open, expired, unparsed } = partitionByClosingDate(vacancies, today);
  log(
    `postbank: ${vacancies.length} table rows, ${open.length} open (closing >= ${today} SAST), ` +
      `${expired.length} expired, ${unparsed.length} unreadable closing date`,
  );
  for (const vacancy of unparsed) {
    log(`postbank: skipped ${vacancy.slug} — unreadable closing date '${vacancy.closingDateRaw}'`);
  }

  const wanted = open.slice(0, SAFETY_CAP);
  if (open.length > wanted.length) {
    log(`postbank: safety cap reached — fetching ${wanted.length} of ${open.length} adverts`);
  }

  const raws: PostbankRawPosting[] = [];
  const seen = new Set<string>();
  for (const vacancy of wanted) {
    if (seen.has(vacancy.slug)) {
      log(`postbank: skipped duplicate advert ${vacancy.slug}`);
      continue;
    }
    seen.add(vacancy.slug);

    await sleep(delayMs);
    try {
      const pdfRes = await fetchImpl(vacancy.pdfUrl, {
        headers: { 'User-Agent': POSTBANK_UA, Accept: 'application/pdf' },
      });
      if (!pdfRes.ok) {
        log(`postbank: skipped ${vacancy.slug} — advert PDF returned HTTP ${pdfRes.status}`);
        continue;
      }
      const advertHtml = await advertHtmlFromPdf(new Uint8Array(await pdfRes.arrayBuffer()));
      if (advertHtml === '') {
        log(`postbank: skipped ${vacancy.slug} — advert PDF yielded no text`);
        continue;
      }
      raws.push({ vacancy, advertHtml });
    } catch (err) {
      log(`postbank: skipped ${vacancy.slug} — advert PDF failed: ${describeError(err)}`);
    }
  }

  log(`postbank: ${raws.length} advert(s) extracted`);
  return raws;
}
