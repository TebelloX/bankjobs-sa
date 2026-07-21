// Province slugs for the location landing pages. packages/core owns PROVINCES
// (the 9 SA provinces) but ships no slug map, so this mirrors the core
// CATEGORY_SLUGS idiom in the site: a kebab-case slug per province with a
// bidirectional lookup. Slugs are derived with the same rule as jobSlug in
// core — lowercase, non-alphanumeric runs collapse to a single '-' — so
// 'Western Cape' → 'western-cape' and 'KwaZulu-Natal' → 'kwazulu-natal'.
import { PROVINCES } from '@bankjobs/core';
import type { Province } from '@bankjobs/core';

function kebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Slug for each of the 9 provinces, e.g. { 'Western Cape': 'western-cape' }. */
export const PROVINCE_SLUGS: Record<Province, string> = Object.fromEntries(
  PROVINCES.map((name) => [name, kebab(name)]),
) as Record<Province, string>;

/** URL slug for a province name, e.g. 'KwaZulu-Natal' → 'kwazulu-natal'. */
export function provinceSlug(province: Province): string {
  return PROVINCE_SLUGS[province];
}

/** Province name for a slug, or undefined if the slug is not one of the nine. */
export function provinceForSlug(slug: string): Province | undefined {
  return PROVINCES.find((name) => PROVINCE_SLUGS[name] === slug);
}
