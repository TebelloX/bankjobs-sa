// Bank-name query interpretation. The old client-side search substring-matched
// title+brand+source+category+location, so "Standard Bank" matched the BRAND
// field and returned only that bank's jobs. The FTS index covers only title +
// description_text (brand is NOT indexed), so a raw MATCH of `"standard"* "bank"*`
// (implicit AND) leaks every description that merely mentions both words —
// SARB/Capitec/Absa noise for "Standard Bank", Investec ("product discovery")
// for "Discovery Bank". We recover the old intent: detect a bank name in q,
// constrain j.brand to it, and let only the LEFTOVER words drive FTS.

// Canonical brand values exactly as stored in jobs.brand (verified in prod).
// GoTyme Bank's source is armed-but-disabled; its aliases are included so the
// mapping is complete the moment rows appear. All matching is on normalized
// lowercase token sequences (see tokenize).
//
// Deliberately NOT aliases: bare `bank`, `standard`, `first`, `reserve`. They
// are too generic — treating them as bank names would hijack real text searches
// (e.g. "standard operating procedure", "first line support", "reserve desk").
const BRAND_ALIASES: Record<string, string[]> = {
  Absa: ['absa'],
  Capitec: ['capitec', 'capitec bank'],
  'Discovery Bank': ['discovery', 'discovery bank'],
  FNB: ['fnb', 'first national bank'],
  FirstRand: ['firstrand', 'first rand', 'firstrand bank'],
  RMB: ['rmb', 'rand merchant bank'],
  WesBank: ['wesbank', 'wes bank'],
  Investec: ['investec'],
  Nedbank: ['nedbank'],
  Postbank: ['postbank', 'post bank', 'south african postbank'],
  SARB: ['sarb', 'reserve bank', 'south african reserve bank'],
  'Standard Bank': ['standard bank', 'standardbank'],
  'GoTyme Bank': ['gotyme', 'gotyme bank', 'tymebank', 'tyme bank'],
};

// Pre-tokenized aliases, flattened to { brand, tokens }. Order follows
// BRAND_ALIASES insertion; detection tie-breaks on length then leftmost index,
// so this order never affects the result (see detectBrand).
const ALIAS_ENTRIES: { brand: string; tokens: string[] }[] = Object.entries(BRAND_ALIASES).flatMap(
  ([brand, aliases]) => aliases.map((a) => ({ brand, tokens: tokenize(a) })),
);

// Case-insensitive canonical lookup for the public `brand` param.
const CANONICAL_BY_LOWER = new Map<string, string>(
  Object.keys(BRAND_ALIASES).map((b) => [b.toLowerCase(), b]),
);

// Same split the FTS sanitizer uses (unicode-aware, non-alphanumeric), plus a
// lowercase so aliases match regardless of case/spacing/punctuation.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

// First index at which `needle` appears as a contiguous run inside `hay`, else -1.
function firstWindowIndex(hay: string[], needle: string[]): number {
  const last = hay.length - needle.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let k = 0; k < needle.length; k++) {
      if (hay[i + k] !== needle[k]) continue outer;
    }
    return i;
  }
  return -1;
}

export interface BrandMatch {
  /** Canonical jobs.brand value to constrain on. */
  brand: string;
  /** The tokens left after removing the alias, space-joined, for the FTS sanitizer. */
  remainder: string;
}

/**
 * Detect at most one bank name in `q`. Finds the LONGEST alias that appears as a
 * contiguous token subsequence anywhere in q (leftmost wins ties); returns its
 * canonical brand plus the remaining tokens (before + after the alias) as the
 * FTS remainder. No alias → null (behavior unchanged from a plain FTS search).
 */
export function detectBrand(q: string): BrandMatch | null {
  const tokens = tokenize(q);
  if (tokens.length === 0) return null;

  let best: { brand: string; start: number; len: number } | null = null;
  for (const entry of ALIAS_ENTRIES) {
    const start = firstWindowIndex(tokens, entry.tokens);
    if (start === -1) continue;
    const len = entry.tokens.length;
    if (best === null || len > best.len || (len === best.len && start < best.start)) {
      best = { brand: entry.brand, start, len };
    }
  }
  if (best === null) return null;

  const remainder = [...tokens.slice(0, best.start), ...tokens.slice(best.start + best.len)];
  return { brand: best.brand, remainder: remainder.join(' ') };
}

/**
 * Resolve the public `brand` param to a canonical jobs.brand (case-insensitive
 * exact match). An unknown value is returned as-is so the SQL `j.brand = ?`
 * simply matches nothing — an empty result set, mirroring how `source` filters.
 */
export function resolveBrandParam(param: string): string {
  return CANONICAL_BY_LOWER.get(param.trim().toLowerCase()) ?? param;
}
