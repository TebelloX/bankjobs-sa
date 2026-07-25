import rulesData from './data/requirement-rules.json';
import { keywordToRegex } from './keywords';

// Requirement extraction is a BUILD-TIME site concern only: it feeds the /fit/
// page's requirements.json snapshot and nothing else. Like isEntryLevel and
// isEarlyCareers before it, it is deliberately NOT a stored column, not part of
// the canonical job shape and not an API filter — four fuzzy fields guessed
// from marketing prose do not justify a schema change, a migration and the
// diff/hash blast radius that comes with one, and they would go stale the
// moment the rules file is tuned. Re-deriving them from description_text on
// every ingest run means a rules edit ships with the next cron, with no
// backfill; a column would mean a migration plus a re-hash wave. If API-side
// filtering is ever wanted, the escape hatch is a column added then, not a
// keyword list duplicated in two places.
//
// RATIONALE for the three shape decisions in here:
//
// 1. WINDOWS, not whole text. Bank ads are long marketing prose. "Support our
//    graduate programme", "degree of accuracy", "our engineering team" and
//    "risk appetite" all appear in the body of roles that ask for none of those
//    things. So qualification types and field-of-study slugs are only read from
//    a slice that FOLLOWS a qualifications heading ("Minimum Qualification:",
//    "Essential Qualifications - NQF Level", "Qualifications (Minimum)",
//    "Education"). windowChars is 450 because the measured blocks — Nedbank's
//    NQF line through to "Minimum Experience Level", FirstRand's "Minimum
//    Qualification / Preferred Qualification" pair, Standard Bank's "Type of
//    Qualification / Field of Study" pair — all close well inside that, while a
//    larger window starts swallowing the behavioural-competency lists.
//
// 2. MIN-taking, everywhere. Every number here answers "what is the LOWEST bar
//    this ad states", never "what does it ideally want". That is what makes it
//    safe to read "Preferred Qualification" windows at all: an ad asking for a
//    diploma minimum and a degree preferred yields diploma, so the matcher
//    shows it to diploma holders. The failure mode is deliberately asymmetric —
//    under-stating a requirement shows a user a role they might not get;
//    over-stating hides a role they qualify for. Only the first is recoverable
//    by the reader. Same reason "Honours degree" resolves to degree, not
//    postgrad: 'degree' matches inside the phrase and the minimum wins.
//
// 3. FIELDS are window-scoped and never fall back to whole text. A field slug
//    is a claim about what you must have STUDIED. "Engineering" in a body
//    paragraph is a department; in a qualifications window it is a degree. No
//    windows therefore means no fields at all — an honest empty answer that the
//    page renders as "we couldn't read requirements from this ad" — rather than
//    a plausible-looking guess. minNqf is the one exception with a whole-text
//    fallback, because "NQF 6" is unambiguous wherever it appears: nothing else
//    in a job ad is spelled that way.
//
// Keyword matching goes through the shared keywordToRegex compiler, so 'IT'
// cannot match "digital" and 'ba' cannot match "database" — the boundary
// semantics live in keywords.ts exactly once. Headings are matched with plain
// indexOf on the lowercased text instead (the rules file lists them lowercase),
// because a heading is a position, not a predicate: we need every occurrence's
// offset, and headings like "qualifications (ideal or preferred)" are
// punctuation-heavy strings that a word-boundary compiler would only make
// harder to reason about.
const WINDOW_CHARS: number = rulesData.windowChars;

/** Qualification tiers, lowest first. The index IS the ordinal used by /fit/. */
export type QualType = 'matric' | 'certificate' | 'diploma' | 'degree' | 'postgrad';

/**
 * Ordered qualification tiers: QUAL_LEVELS.indexOf(q) is q's ordinal, so
 * matric=0, certificate=1, diploma=2, degree=3, postgrad=4. Hard-coded rather
 * than read off the rules JSON's key order: the ordinals are a published
 * contract (they ship in requirements.json and in the /fit/ select's
 * data-level), and a reordered JSON object must not silently redefine them.
 */
export const QUAL_LEVELS: readonly QualType[] = [
  'matric',
  'certificate',
  'diploma',
  'degree',
  'postgrad',
];

/** Field-of-study taxonomy with the keywords that index it. */
export const REQUIREMENT_FIELD_RULES: ReadonlyArray<{
  field: string;
  label: string;
  keywords: string[];
}> = rulesData.fields;

/** The taxonomy without its keywords — what a UI needs to render a picker. */
export const REQUIREMENT_FIELDS: ReadonlyArray<{ field: string; label: string }> =
  rulesData.fields.map(({ field, label }) => ({ field, label }));

/** Bumped whenever the rules file changes shape; stamped into snapshots. */
export const REQUIREMENT_RULES_VERSION: number = rulesData.version;

export interface JobRequirements {
  /** Lowest acceptable qualification as a QUAL_LEVELS ordinal; null = unstated. */
  minQual: number | null;
  /** Lowest NQF level mentioned (1–10); null = none mentioned. */
  minNqf: number | null;
  /** Field-of-study slugs found in qualification windows only, in taxonomy order. */
  fields: string[];
  /** Lowest stated years of experience; null = unstated. */
  minYears: number | null;
}

const GLOBAL_HEADINGS: string[] = rulesData.headings.global;
const PER_SOURCE_HEADINGS: Record<string, string[]> = rulesData.headings.perSource;

const QUAL_MATCHERS: ReadonlyArray<{ level: number; matchers: RegExp[] }> = QUAL_LEVELS.map(
  (qual, level) => ({ level, matchers: rulesData.qualTypes[qual].map(keywordToRegex) }),
);

const FIELD_MATCHERS: ReadonlyArray<{ field: string; matchers: RegExp[] }> = rulesData.fields.map(
  (rule) => ({ field: rule.field, matchers: rule.keywords.map(keywordToRegex) }),
);

// "NQF 6", "NQF Level 6", "NQF level: 6", "NQF5" and "NQF&nbsp;8" (\s covers the
// non-breaking space the banks' HTML is full of) are all the same statement.
const NQF_PATTERN = /nqf\s*(?:level\s*)?:?\s*(\d{1,2})/gi;

// Two shapes, both verified against live copy. The first reads forwards from
// the number ("1–3 years of experience", "5-10 years' experience", "1 to 2
// years credit management experience"); the second reads backwards from the
// word ("Experience Required ... 1-2 years", Standard Bank's table layout).
// [’'`] covers the curly apostrophe the ATSes emit in "years' experience".
const YEARS_PATTERNS: readonly RegExp[] = [
  /(\d{1,2})\s*(?:(?:[-–—]|to)\s*\d{1,2})?\s*\+?\s*years?[’'`]?\s*(?:of\s+)?(?:[\w,()/&\- ]{0,40}?)experience/gi,
  /experience[^.]{0,50}?(\d{1,2})\s*(?:(?:[-–—]|to)\s*\d{1,2})?\s*\+?\s*years?/gi,
];

const MIN_NQF = 1;
const MAX_NQF = 10;
const MAX_YEARS = 40;

/**
 * Every qualification window in the text: the windowChars-long slice that
 * follows each occurrence of each heading, per-source headings first.
 *
 * Overlapping windows are expected and harmless — Nedbank's "essential
 * qualifications - nqf level" contains the global "essential qualification", so
 * one block opens two windows over nearly the same prose. Every read is a
 * min-take or a set union, so reading the same sentence twice cannot change an
 * answer. Dedupe is by START OFFSET, which collapses only the exact repeats (a
 * heading listed twice in the rules file).
 */
function collectWindows(lowerText: string, source: string): string[] {
  const headings = [...(PER_SOURCE_HEADINGS[source] ?? []), ...GLOBAL_HEADINGS];
  const seenStarts = new Set<number>();
  const windows: string[] = [];

  for (const heading of headings) {
    if (heading.length === 0) continue;
    let from = 0;
    for (;;) {
      const at = lowerText.indexOf(heading, from);
      if (at === -1) break;
      const start = at + heading.length;
      if (!seenStarts.has(start)) {
        seenStarts.add(start);
        windows.push(lowerText.slice(start, start + WINDOW_CHARS));
      }
      from = start;
    }
  }

  return windows;
}

/** Every plausible NQF level stated in a chunk of text, in the range 1–10. */
function nqfLevelsIn(text: string): number[] {
  const levels: number[] = [];
  for (const match of text.matchAll(NQF_PATTERN)) {
    const digits = match[1];
    if (digits === undefined) continue;
    const level = Number.parseInt(digits, 10);
    // "NQF 99" is a typo or a reference number, not a level.
    if (level >= MIN_NQF && level <= MAX_NQF) levels.push(level);
  }
  return levels;
}

/**
 * The qualification tier an NQF level implies: ≤4 matric, 5 certificate,
 * 6 diploma, 7 degree, ≥8 postgrad. Monotonic, so mapping the minimum level is
 * the same as taking the minimum of the mapped levels.
 */
function nqfToOrdinal(nqf: number): number {
  if (nqf <= 4) return 0;
  if (nqf >= 8) return 4;
  return nqf - 4;
}

/** Lowest stated years of experience anywhere in the text, or null. */
function minYearsIn(text: string): number | null {
  let min: number | null = null;
  for (const pattern of YEARS_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const digits = match[1];
      if (digits === undefined) continue;
      const years = Number.parseInt(digits, 10);
      // Out-of-range readings are discarded rather than pinned to the bound: a
      // stray "50 years of banking heritage" must not become "50 years'
      // experience required", and pinning it to 40 would be just as wrong.
      if (years < 0 || years > MAX_YEARS) continue;
      if (min === null || years < min) min = years;
    }
  }
  return min;
}

/**
 * Read the stated minimum requirements out of a job ad: qualification tier, NQF
 * level, fields of study and years of experience. Deterministic, rules-driven,
 * and pure — same text in, same answer out, no I/O.
 *
 * Everything is optional by design: an ad that states nothing extractable comes
 * back all-null (`{ minQual: null, minNqf: null, fields: [], minYears: null }`)
 * so the page can show it honestly as unscored instead of guessing. `title` is
 * accepted for shape parity with the ingest row and reserved for future title
 * signals; v1 reads requirements from the description only, exactly as
 * isEntryLevel reads them from the title only, and for the mirror-image reason:
 * a title is too short to state a requirement, a description too long to state
 * one unambiguously outside its own heading.
 *
 * `source` is a plain string, not SourceId: it selects the per-source heading
 * list and an unknown source simply gets the global headings. That keeps the
 * function callable straight off a DB row without a cast, and means adding a
 * bank cannot break extraction before its rules exist.
 */
export function extractRequirements(input: {
  title: string;
  descriptionText: string;
  source: string;
}): JobRequirements {
  const lowerText = input.descriptionText.toLowerCase();
  const windows = collectWindows(lowerText, input.source);

  // NQF is unambiguous wherever it is written, so fall back to the whole text
  // when no window states one — FirstRand's branch ads say "a completed
  // financial related qualification (NQF5 or higher)" under no heading at all.
  const windowedNqf = windows.flatMap(nqfLevelsIn);
  const nqfLevels = windowedNqf.length > 0 ? windowedNqf : nqfLevelsIn(lowerText);
  const minNqf = nqfLevels.length > 0 ? Math.min(...nqfLevels) : null;

  const ordinals: number[] = [];
  if (minNqf !== null) ordinals.push(nqfToOrdinal(minNqf));
  for (const { level, matchers } of QUAL_MATCHERS) {
    if (windows.some((window) => matchers.some((matcher) => matcher.test(window)))) {
      ordinals.push(level);
    }
  }
  const minQual = ordinals.length > 0 ? Math.min(...ordinals) : null;

  const fields = FIELD_MATCHERS.filter(({ matchers }) =>
    windows.some((window) => matchers.some((matcher) => matcher.test(window))),
  ).map(({ field }) => field);

  return { minQual, minNqf, fields, minYears: minYearsIn(lowerText) };
}
