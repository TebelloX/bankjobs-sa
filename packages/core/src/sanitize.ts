import sanitizeHtml from 'sanitize-html';

/**
 * sanitize-html config for the display HTML. Only a small allowlist of
 * structural/inline tags survives; everything else has its wrapper discarded
 * while keeping children (sanitize-html's default behaviour), except
 * script/style/etc. whose *content* is dropped entirely via `nonTextTags`.
 *
 * Anchors (`<a>`) are intentionally left out of the allowlist so they are
 * unwrapped to their text content (no tag) — the same discard-but-keep-children
 * behaviour applied to div/span/section.
 */
const HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['p', 'ul', 'ol', 'li', 'h3', 'h4', 'strong', 'em', 'br'],
  allowedAttributes: {},
  transformTags: {
    b: 'strong',
    i: 'em',
    h1: 'h3',
    h2: 'h3',
    h5: 'h4',
    h6: 'h4',
  },
  // Strip the CONTENT of these tags entirely (not just the wrapper).
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
};

/** Second pass: strip absolutely everything down to text nodes. */
const TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [],
  allowedAttributes: {},
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript'],
};

/**
 * Decode the small set of HTML entities that sanitize-html re-encodes into its
 * output text (everything else — e.g. `&rsquo;` — is already decoded to the
 * literal Unicode character by the parser). `&amp;` is decoded last so we never
 * double-decode (e.g. `&amp;lt;` stays `&lt;`).
 */
function decodeBasicEntities(input: string): string {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize messy source HTML into a small display-safe HTML string plus a plain
 * text rendering suitable for excerpts and full-text indexing.
 */
export function sanitizeDescription(rawHtml: string): { html: string; text: string } {
  const html = sanitizeHtml(rawHtml, HTML_OPTIONS);

  // Prefix every tag with a space before stripping so block boundaries (and
  // <br>) become word separators instead of concatenating adjacent words.
  const spaced = html.replace(/</g, ' <');
  const stripped = sanitizeHtml(spaced, TEXT_OPTIONS);
  const text = collapseWhitespace(decodeBasicEntities(stripped));

  return { html, text };
}

/**
 * Produce a short excerpt from plain text.
 * - If the text already fits within `max`, it is returned unchanged.
 * - Otherwise prefer the last sentence-ending punctuation ('.', '!', '?')
 *   between `min` and `max`.
 * - Failing that, cut at the last word boundary before `max` and append '…'.
 */
export function makeExcerpt(text: string, opts?: { min?: number; max?: number }): string {
  const min = opts?.min ?? 300;
  const max = opts?.max ?? 400;

  const t = text.trim();
  if (t.length <= max) return t;

  const upper = Math.min(max, t.length - 1);
  for (let i = upper; i >= min; i--) {
    const ch = t[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      return t.slice(0, i + 1).trim();
    }
  }

  const slice = t.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return cut.trim() + '…';
}
