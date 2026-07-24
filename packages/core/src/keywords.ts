// Keyword → regex compilation shared by the rule-driven title classifiers
// (categorize.ts, earlyCareers.ts). Both read a JSON keyword list and test it
// against a job title, so the boundary semantics are defined here exactly once
// — a second, subtly different compiler is how 'intern' starts matching
// "Internal Consultant".

/** Escape the regex metacharacters in a literal keyword ('.net' → '\.net'). */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a keyword into a case-insensitive, word-boundary regex. Multi-word
 * keywords match as phrases (interior whitespace matches one-or-more spaces).
 * Boundaries use lookarounds on alphanumerics so keywords like `.net` and `IT`
 * still match without being swallowed by neighbouring word characters.
 *
 * The lookarounds are load-bearing in both directions: `intern` must not match
 * "Internal Consultant" or "International Wealth", and `learner` must not match
 * "Learning & Development" — but equally, `intern` does NOT match "Internship",
 * so suffixed forms have to be listed as their own keywords.
 */
export function keywordToRegex(keyword: string): RegExp {
  const body = keyword.trim().split(/\s+/).map(escapeRegex).join('\\s+');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}
