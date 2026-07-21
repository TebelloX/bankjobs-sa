// FTS5 query safety. User `q` must never reach MATCH raw — FTS5 operators
// (AND/OR/NOT/NEAR), column filters (`col:`), quotes and bare `*` would either
// 500 or let a caller rewrite the query. We split on any non-alphanumeric
// (unicode-aware), then wrap each token as a quoted prefix term `"tok"*`.
// Quoting demotes every token to a literal (operators become ordinary words);
// the trailing `*` keeps prefix matching; space between tokens ANDs them.
// Empty after sanitizing (e.g. q was `"` or a lone `*`) → '' and the caller
// falls back to an unfiltered listing.

const MAX_TOKENS = 12; // bound worst-case MATCH cost

export function sanitizeFtsQuery(q: string): string {
  const tokens = q
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
    .slice(0, MAX_TOKENS);
  if (tokens.length === 0) return '';
  // Tokens are already free of quotes (split stripped them); double any anyway.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}
