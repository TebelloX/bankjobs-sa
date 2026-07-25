// City slugs for the city landing pages, and the list of cities that get one.
//
// provinces.ts and banks.ts enumerate CLOSED sets that packages/core owns — the
// 9 provinces, the 14 brands. Cities are different: nothing owns the list, the
// feeds do. Which towns the banks are hiring in changes with every crawl, so
// this set is DERIVED from the snapshot at build time rather than declared here.
// Slugs use the same rule as jobSlug / PROVINCE_SLUGS / BANK_SLUGS — lowercase,
// non-alphanumeric runs collapse to a single '-' — so 'Cape Town' → 'cape-town',
// 'Century City' → 'century-city' and 'eMalahleni' simply lowercases.
//
// The derivation is a PURE exported function (derivePageCities) plus a thin
// module-scope application to saJobs() at the bottom, the same split feeds.ts
// and related.ts use: the pure half takes rows as an argument and is testable in
// plain node against a synthetic snapshot. That application is also what makes
// this module BUILD-TIME ONLY — it imports data.ts, which pulls in the
// multi-megabyte gitignored job snapshot, so cities.ts must never be reachable
// from a client bundle.
import type { Province } from '@bankjobs/core';
import { saJobs } from './data';
import { PROVINCE_SLUGS } from './provinces';

function kebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * How many open SA roles a city needs before it earns a landing page.
 *
 * Quality over sprawl. The snapshot carries 82 distinct primary cities, but the
 * tail is almost entirely single-vacancy towns (Kakamas, Sannieshof,
 * Christiana …). A floor of 3 yields ~18 real ledgers instead of 82 pages that
 * are mostly one row — thin content search engines discount and a job seeker
 * gets nothing from. Nothing is lost by dropping them: every vacancy in a
 * below-floor town is still on its province page, in the category × province
 * combos, in the feeds and in /search.
 */
export const MIN_CITY_JOBS = 3;

/** A city with enough open roles to have its own landing page. */
export interface PageCity {
  /** Canonical city name as the location resolver spells it, e.g. 'Cape Town'. */
  name: string;
  /** URL slug, e.g. 'cape-town'. */
  slug: string;
  /**
   * The province this city sits in — the first non-null province among its own
   * jobs. Carried because the page cross-links up to the parent province ledger
   * and across to the category × province combos, both of which are keyed by
   * province. null only if no job filed under the city parsed a province at
   * all, which does not happen today: the location resolver reads city and
   * province out of the same alias entry.
   */
  province: Province | null;
}

/** The fields a job row must expose to be counted. FullJob satisfies this. */
export interface CityJob {
  locations: ReadonlyArray<{ city: string | null; province: Province | null }>;
}

/**
 * Nedbank files nationwide adverts under a placeholder location rather than a
 * town. It is a coverage claim, not a city, and must never get a page. Zero rows
 * today — those adverts currently arrive with no parsed location at all — so
 * this is a guard against a future parse promoting the string to a city, not a
 * fix for something happening now.
 */
const NOT_A_CITY = new Set(['National']);

/**
 * The page-worthy cities in `jobs`: biggest ledger first, city name as the
 * tiebreak so the order is byte-stable across rebuilds of unchanged data.
 *
 * A job is filed under locations[0].city — the PRIMARY location, exactly the
 * field the province pages read locations[0].province from. A multi-location
 * advert therefore counts once, under its first city, and the ledger rendered on
 * the page is this same filter run again.
 */
export function derivePageCities(jobs: readonly CityJob[]): PageCity[] {
  const byCity = new Map<string, { count: number; province: Province | null }>();
  for (const job of jobs) {
    const primary = job.locations[0];
    if (!primary?.city) continue;
    const name = primary.city;
    const entry = byCity.get(name);
    if (!entry) {
      byCity.set(name, { count: 1, province: primary.province });
      continue;
    }
    entry.count += 1;
    // First non-null province wins. A city resolves to exactly one province in
    // practice (both come from the same alias entry), so this only ever fills in
    // a value for a city whose earliest rows failed to parse a province.
    if (entry.province === null) entry.province = primary.province;
  }

  const ordered = [...byCity.entries()].sort((a, b) => {
    if (a[1].count !== b[1].count) return b[1].count - a[1].count;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  // ROUTE-SAFETY GUARD — load-bearing, do not drop.
  //
  // pages/vacancies/[city].astro is a SIBLING of [province].astro and
  // [...page].astro: three dynamic routes directly under /vacancies/. Nothing in
  // Astro stops two of them claiming the same URL, and a duplicate emitted path
  // is a build failure. Disjoint getStaticPaths sets are the ONLY thing keeping
  // the three apart, so the disjointness is enforced right here, at the source of
  // the city set:
  //
  //   * a slug equal to one of the 9 province slugs collides with
  //     [province].astro — a town named 'Limpopo' would claim /vacancies/limpopo/
  //   * a purely numeric slug collides with [...page].astro's /vacancies/2/,
  //     /vacancies/3/ … pagination
  //   * an empty slug (a name with no alphanumerics at all) emits /vacancies/
  //     itself, which is page 1 of that same ledger
  //   * two city names that kebab to one slug collide with each other; the
  //     bigger ledger keeps it, the list already being sorted by count
  //
  // Today's feeds trip none of these — the check exists so that stays true as
  // the feeds change, with nobody having to notice.
  const provinceSlugs = new Set<string>(Object.values(PROVINCE_SLUGS));
  const cities: PageCity[] = [];
  const claimed = new Set<string>();
  for (const [name, { count, province }] of ordered) {
    if (count < MIN_CITY_JOBS) continue;
    if (NOT_A_CITY.has(name)) continue;
    const slug = kebab(name);
    if (slug === '' || /^[0-9]+$/.test(slug)) continue;
    if (provinceSlugs.has(slug)) continue;
    if (claimed.has(slug)) continue;
    claimed.add(slug);
    cities.push({ name, slug, province });
  }
  return cities;
}

/**
 * Every city that gets a landing page in this build, biggest ledger first.
 * Derived once at module scope, so the pass over the snapshot happens a single
 * time however many pages read the list.
 */
export const PAGE_CITIES: PageCity[] = derivePageCities(saJobs());

/** City for a slug, or undefined when no landing page is generated for it. */
export function cityForSlug(slug: string): PageCity | undefined {
  return PAGE_CITIES.find((c) => c.slug === slug);
}
