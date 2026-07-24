// One ledger row, built in the browser.
//
// Lifted VERBATIM out of the search island (site/src/pages/search.astro) when
// the saved page needed the same rows: two islands drawing "a job row" two ways
// would drift, and the ledger row is the site's most-repeated piece of markup.
// The output is byte-identical to components/JobRow.astro's — cell (title +
// source) | when — so a client-rendered row and a server-rendered one are
// indistinguishable, and global.css styles both with one set of rules.
//
// Dependency-free like share.ts / savedJobs.ts: imported by client-bundled
// island code, so it must never reach lib/data.ts and drag the job snapshot into
// the browser payload. It takes a plain row shape rather than importing
// SearchRow, which keeps it usable by anything with those six fields (the
// search snapshot rows, a saved-jobs entry).
//
// DOM APIs only — createElement + textContent, never innerHTML. Titles come
// from bank feeds (and, on the saved page, from localStorage, which the visitor
// or another script can edit): treat every string here as untrusted.

/** The six fields a ledger row renders. */
export interface JobRowData {
  slug: string;
  title: string;
  brand: string;
  category: string;
  primaryLocation: string | null;
  postedDate: string | null;
}

/** Options for rows that are not plain links. */
export interface JobRowOptions {
  /**
   * false renders the title as PLAIN TEXT instead of an /jobs/ link. Only the
   * saved page uses it: a vacancy that has left the snapshot no longer has a
   * page — the build only generates open jobs — so linking it would send the
   * visitor to a 404. Defaults to true, i.e. exactly the extracted behaviour.
   */
  linked?: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-07-21' → '21 Jul'; '' for a missing or unparseable date. */
export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d} ${MONTHS[m - 1]}`;
}

/**
 * Build one ledger <li> for a job row with DOM APIs only — never innerHTML
 * with data. Shared by both search modes and the saved page so the markup stays
 * identical to JobRow.astro regardless of data source: cell (title + source) |
 * when.
 */
export function createJobRow(r: JobRowData, options: JobRowOptions = {}): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'job-row';

  const cell = document.createElement('span');
  cell.className = 'job-cell';

  const linked = options.linked !== false;
  const title = document.createElement(linked ? 'a' : 'span');
  title.className = 'job-title';
  if (title instanceof HTMLAnchorElement) title.href = `/jobs/${r.slug}/`;
  title.textContent = r.title;

  const src = document.createElement('span');
  src.className = 'src';
  const parts = [r.brand, r.category];
  if (r.primaryLocation) parts.push(r.primaryLocation);
  src.textContent = parts.join(' · ');

  cell.appendChild(title);
  cell.appendChild(src);
  li.appendChild(cell);

  if (r.postedDate) {
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = `posted ${fmtDate(r.postedDate)}`;
    li.appendChild(when);
  }
  return li;
}
