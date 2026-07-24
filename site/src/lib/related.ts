// "More like this" picker for the job detail page.
//
// Kept dependency-FREE on purpose, exactly like share.ts and freshness.ts:
// data.ts imports the (gitignored) job snapshots, so a module that imported it
// — even for a type — would risk dragging 5 MB of JSON into anything that ever
// reaches a browser bundle. Instead this file declares the minimal structural
// shape it reads (RelatedCandidate) and stays generic, so callers hand it real
// FullJob rows and get FullJob rows back with no import at all. That also makes
// it plain-node unit-testable against a synthetic pool.
//
// Selection is TIERED and PURE: candidates are taken in pool order (the pool is
// already deterministically sorted — postedDate desc, nulls last, id tiebreak),
// never shuffled, never sampled. Same snapshot in, byte-identical rows out, so
// a rebuild with unchanged data produces an unchanged page.

/** The fields a job row must expose to be matched. FullJob satisfies this. */
export interface RelatedCandidate {
  id: string;
  brand: string;
  category: string;
  /** ISO 3166-1 alpha-2, 'ZZ' if unknown. */
  country: string;
  locations: ReadonlyArray<{ province: string | null }>;
}

/** The province a row is filed under: its first location's, or null. */
function provinceOf(job: RelatedCandidate): string | null {
  return job.locations[0]?.province ?? null;
}

/**
 * Pick up to `max` jobs related to `job` from `pool`, best match first.
 *
 * Tiers, filled in order until `max` is reached:
 *   1. same category, same province — or, for a job with no province
 *      (international, or an SA listing with no province parsed), same
 *      category and same country
 *   2. same category, same brand
 *   3. same category, same country
 *   4. same brand
 *
 * Within a tier, pool order wins. The job itself is excluded and every row is
 * deduped by id, so a candidate matching several tiers appears once, at its
 * best tier.
 */
export function pickRelated<T extends RelatedCandidate>(job: T, pool: readonly T[], max = 5): T[] {
  if (max <= 0) return [];

  const province = provinceOf(job);
  const sameCategory = (c: T): boolean => c.category === job.category;

  const tiers: Array<(c: T) => boolean> = [
    province === null
      ? (c) => sameCategory(c) && c.country === job.country
      : (c) => sameCategory(c) && provinceOf(c) === province,
    (c) => sameCategory(c) && c.brand === job.brand,
    (c) => sameCategory(c) && c.country === job.country,
    (c) => c.brand === job.brand,
  ];

  const picked: T[] = [];
  const seen = new Set<string>([job.id]);

  for (const matches of tiers) {
    for (const candidate of pool) {
      if (picked.length >= max) return picked;
      if (seen.has(candidate.id)) continue;
      if (!matches(candidate)) continue;
      seen.add(candidate.id);
      picked.push(candidate);
    }
  }

  return picked;
}
