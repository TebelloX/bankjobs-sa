// "Find your fit" — the qualification matcher behind /fit/.
//
// Kept dependency-FREE and PURE on purpose, exactly like related.ts and
// savedJobs.ts: every line of this file runs in the visitor's browser. It must
// never import lib/data.ts (which pulls the gitignored job snapshot into
// whatever bundle reaches it) and — the new rule this module adds — it must
// never import @bankjobs/core either. Core's entry point reaches sanitize.ts,
// which depends on sanitize-html: a build-time HTML sanitiser has no business
// being downloaded by a page that only ever reads JSON. What this file needs
// from core is the field-of-study taxonomy, and that TRAVELS WITH THE DATA
// instead: requirements.json ships the exact keyword list that indexed the
// jobs, so the browser parses a typed qualification name against the same
// version of the taxonomy that produced the answers it is matching against. A
// tuned rules file and a stale client cannot disagree.
//
// The price of that isolation is compileKeyword() below — a deliberate copy of
// core's keywordToRegex, three lines of it, with identical semantics. Copies
// drift, so site/test/matchFit.test.ts asserts for EVERY keyword in the shipped
// taxonomy that this compiler and core's agree, over a corpus built out of the
// cases the boundaries exist for: 'IT' must match "IT department" and not
// "digital banking" or "ITIL"; 'audit' must match "internal audit" and not
// "auditing"; 'b com' must match "b com graduate" and not "bcom". If the two
// ever diverge, that test fails before a visitor is shown a wrong bucket.
//
// Nothing here stores or sends anything. The visitor's answers arrive as a
// FitProfile argument and leave as ordered rows; persistence is matchPrefs.ts's
// job and it never leaves the device. That is the site's published promise on
// /about, kept by construction rather than by policy.
//
// The JobReq shape is TRUSTED, not re-validated: requirements.json is our own
// artifact, emitted by our own ingest, with an id-set-equality invariant test
// against jobs.json. Defensive re-parsing here would be untested branches
// guarding against a file only we can write.

/** Where the client fetches the snapshot. Same-origin, so no CSP change. */
export const REQUIREMENTS_DATA_URL = '/data/requirements.json';

/** One job's extracted requirements, exactly as emitted into requirements.json. */
export interface JobReq {
  /** Lowest acceptable qualification as a QUAL_LEVELS ordinal (0–4); null = unstated. */
  minQual: number | null;
  /** Lowest NQF level stated (1–10); null = none stated. Read here only as a signal
   *  that the ad said SOMETHING extractable, since minQual already folds it in. */
  minNqf: number | null;
  /** Field-of-study slugs found in the ad's qualification windows. */
  fields: string[];
  /** Lowest stated years of experience; null = unstated. */
  minYears: number | null;
}

/** One row of the field taxonomy that shipped inside the snapshot. */
export interface TaxonomyField {
  field: string;
  label: string;
  keywords: string[];
}

/** What the visitor told the page. Held in memory for one render, never persisted here. */
export interface FitProfile {
  /** Their highest qualification as a QUAL_LEVELS ordinal: matric 0 … postgrad 4. */
  qualLevel: number;
  /** Field slugs: the picker's choice unioned with whatever parseQualName read. */
  fields: string[];
  /** Years of experience, or null for "not saying" — which is not the same as 0. */
  years: number | null;
}

/**
 * The four buckets a job can be shown in. 'above' is deliberately NOT one of
 * them: a role asking for two or more levels above the visitor is counted and
 * summarised in one muted line, not listed. Everything else is listed.
 */
export type FitBucket = 'strong' | 'possible' | 'stretch' | 'unscored';

/** The full result of a match run: four lists plus the roles that were only counted. */
export interface BucketedJobs<T> {
  strong: T[];
  possible: T[];
  stretch: T[];
  /** Ads whose requirements we could not read. Shown, labelled honestly, never dropped. */
  unscored: T[];
  /** How many roles ask for a qualification more than one level above the visitor's. */
  aboveCount: number;
}

// Within-bucket ranking weights. Field of study outranks everything because it
// is the strongest claim in the data — a field slug only exists when the ad
// named a subject under a qualifications heading, whereas a level can be
// inferred from a bare "NQF 6".
const SCORE_FIELD_MATCH = 4;
const SCORE_RIGHT_LEVEL = 2;
const SCORE_LEVEL_OK = 1;
const SCORE_EXPERIENCE_MET = 1;

/**
 * Compile one taxonomy keyword into a case-insensitive, word-boundary regex.
 *
 * A byte-for-byte behavioural copy of packages/core/src/keywords.ts —
 * metacharacters escaped ('ca(sa)' → 'ca\(sa\)'), interior whitespace joined on
 * \s+ so a multi-word keyword matches as a phrase across any spacing, and
 * alphanumeric LOOKAROUNDS rather than \b so that 'IT' and 'b com' survive
 * being listed at all. Not \b: '\bit\b' would happily match the "it" in
 * "digital" once the surrounding characters are punctuation, and the taxonomy
 * leans on short keywords.
 *
 * The duplication is the point (see the file header); the parity test is the
 * guard. Do not "fix" this by importing core.
 */
function compileKeyword(keyword: string): RegExp {
  const body = keyword
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
}

/**
 * Read field-of-study slugs out of a free-text qualification name — "BCom
 * Accounting" → ['accounting', 'business-commerce'] — in taxonomy order,
 * deduped.
 *
 * FIELDS ONLY, never levels, and that is a product decision rather than a
 * shortcut: the qualification SELECT is authoritative about how far the visitor
 * studied, because it is a closed list they picked from, while this box is
 * free text where "BCom (in progress)", "matric + N4" and "Honours" all mean
 * something the page has no business overruling their own answer with. So the
 * text can only ever ADD subject matter to the profile; it can never promote or
 * demote the level they chose. The page unions this with the field picker,
 * which is why "not sure" plus a typed degree name still matches on subject.
 *
 * Same lowercase-first normalisation the extractor applies to a job ad, so both
 * sides of a match were prepared identically — redundant given the regexes are
 * case-insensitive, and kept because "identical to the extractor" is the
 * property the parity test defends.
 */
export function parseQualName(text: string, taxonomy: TaxonomyField[]): string[] {
  const lower = text.trim().toLowerCase();
  if (lower === '') return [];

  const fields: string[] = [];
  const seen = new Set<string>();
  for (const entry of taxonomy) {
    if (seen.has(entry.field)) continue;
    if (!entry.keywords.some((keyword) => compileKeyword(keyword).test(lower))) continue;
    seen.add(entry.field);
    fields.push(entry.field);
  }
  return fields;
}

/**
 * Place one job against one profile: which bucket, and how well it ranks inside
 * it.
 *
 * The ladder, with L = req.minQual:
 *
 *   unscored  the ad states nothing extractable (or we have no entry for it).
 *             SHOWN, not dropped — roughly a quarter of ads are unreadable
 *             prose, and silently deleting them would turn "we could not read
 *             this one" into "you do not qualify", which is a lie the visitor
 *             cannot see being told. The page labels the section for what it is.
 *   strong    the visitor clears the level bar AND studied a listed field.
 *   possible  they clear the level bar. This includes L === null: an ad that
 *             states experience or nothing at all about qualifications is not
 *             evidence against anyone.
 *   stretch   L is exactly one level above them. Worth an application; plenty
 *             of banks write "degree" and hire the diploma with the right
 *             experience.
 *   above     L is two or more levels above. Counted only.
 *
 * EXPERIENCE DEMOTES, NEVER HIDES: falling short of a stated year count moves a
 * job down exactly one rung (strong→possible, possible→stretch, and stretch
 * stays stretch, its floor). It cannot push anything into 'above', because
 * 'above' is the one outcome that removes a row from the page and experience is
 * the softest signal in the data — years are parsed out of sentences like "5-10
 * years' experience in a related field", and the visitor's own answer is a
 * coarse dropdown. Both sides must have said a number for the comparison to
 * happen at all: "not saying" is not zero.
 *
 * The score orders rows WITHIN a bucket and is never compared across buckets.
 * Right-level (0 ≤ userLevel − L ≤ 1) beats merely clearing the bar, so a
 * postgrad looking at a matric-minimum branch role still sees it — every one of
 * those is `levelOk` and would otherwise flood the list — but sees it below the
 * roles actually pitched at them. An unstated L scores the same +1 as
 * overqualified-by-two: it is not evidence of a good fit, only of the absence
 * of a bad one.
 */
export function matchJob(
  user: FitProfile,
  req: JobReq | undefined,
): { bucket: FitBucket | 'above'; score: number } {
  if (!req) return { bucket: 'unscored', score: 0 };

  const level = req.minQual;
  const minYears = req.minYears;
  if (level === null && req.minNqf === null && minYears === null && req.fields.length === 0) {
    return { bucket: 'unscored', score: 0 };
  }

  const levelOk = level === null || user.qualLevel >= level;
  const oneAbove = level !== null && level === user.qualLevel + 1;
  const fieldMatch = req.fields.some((field) => user.fields.includes(field));
  const expShort = minYears !== null && user.years !== null && user.years < minYears;
  const expMet = minYears !== null && user.years !== null && user.years >= minYears;

  let bucket: FitBucket | 'above';
  if (levelOk && fieldMatch) bucket = 'strong';
  else if (levelOk) bucket = 'possible';
  else if (oneAbove) bucket = 'stretch';
  else bucket = 'above';

  if (expShort) {
    if (bucket === 'strong') bucket = 'possible';
    else if (bucket === 'possible') bucket = 'stretch';
  }

  const gap = level === null ? null : user.qualLevel - level;
  let score = 0;
  if (fieldMatch) score += SCORE_FIELD_MATCH;
  if (gap !== null && gap >= 0 && gap <= 1) score += SCORE_RIGHT_LEVEL;
  if (levelOk) score += SCORE_LEVEL_OK;
  if (expMet) score += SCORE_EXPERIENCE_MET;

  return { bucket, score };
}

/**
 * Sort a whole snapshot into the four buckets, best fit first.
 *
 * DETERMINISTIC by construction: rows are read in the order given (the caller
 * hands over jobs.json order — postedDate descending), each bucket is then
 * sorted by score descending with a stable sort, so equally-scored rows keep
 * their input order and the freshest of two identical fits is the one on top.
 * Same inputs in, byte-identical lists out — no shuffling, no sampling, no
 * clock.
 *
 * Generic over the row type for the same reason pickRelated is: this module
 * must not import the job shape from lib/data.ts, so it asks for the one field
 * it actually reads (`id`, the key into `reqs`) and hands back whatever it was
 * given. A job with no entry in `reqs` lands in `unscored` rather than
 * vanishing — the id sets are equal by ingest invariant, but a fetch that raced
 * a deploy must degrade to "we could not read this one", not to a missing row.
 */
export function bucketJobs<T extends { id: string }>(
  user: FitProfile,
  rows: readonly T[],
  reqs: Record<string, JobReq>,
): BucketedJobs<T> {
  const scored: Record<FitBucket, Array<{ row: T; score: number }>> = {
    strong: [],
    possible: [],
    stretch: [],
    unscored: [],
  };
  let aboveCount = 0;

  for (const row of rows) {
    const { bucket, score } = matchJob(user, reqs[row.id]);
    if (bucket === 'above') {
      aboveCount += 1;
      continue;
    }
    scored[bucket].push({ row, score });
  }

  // Array#sort is stable (guaranteed since ES2019), which is what makes input
  // order the tiebreak rather than an implementation detail.
  const rank = (entries: Array<{ row: T; score: number }>): T[] =>
    entries.sort((a, b) => b.score - a.score).map((entry) => entry.row);

  return {
    strong: rank(scored.strong),
    possible: rank(scored.possible),
    stretch: rank(scored.stretch),
    unscored: rank(scored.unscored),
    aboveCount,
  };
}
