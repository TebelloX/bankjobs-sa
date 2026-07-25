// Bank slugs for the per-bank landing pages. packages/core owns BRANDS (the 15
// canonical brand values stored on jobs.brand) but ships no slug map, so this
// mirrors the provinces.ts / CATEGORY_SLUGS idiom in the site: a kebab-case
// slug per brand with a bidirectional lookup. Slugs are derived with the same
// rule as jobSlug in core — lowercase, non-alphanumeric runs collapse to a
// single '-' — so 'Standard Bank' → 'standard-bank', 'GoTyme Bank' →
// 'gotyme-bank' and single-word brands ('WesBank', 'SARB') simply lowercase.
//
// This is the SINGLE source of brand slugs for pages, feeds and filters. Keep
// it dependency-light: it imports constants from @bankjobs/core and nothing
// else, and it must NEVER import lib/data.ts — that module pulls in the
// gitignored build snapshots, which can never reach a client bundle.
import { BRANDS } from '@bankjobs/core';
import type { Brand } from '@bankjobs/core';

function kebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Slug for each of the 15 brands, e.g. { 'Standard Bank': 'standard-bank' }. */
export const BANK_SLUGS: Record<Brand, string> = Object.fromEntries(
  BRANDS.map((name) => [name, kebab(name)]),
) as Record<Brand, string>;

/** URL slug for a brand name, e.g. 'GoTyme Bank' → 'gotyme-bank'. */
export function bankSlug(brand: Brand): string {
  return BANK_SLUGS[brand];
}

/** Brand name for a slug, or undefined if the slug is not one of the fifteen. */
export function brandForSlug(slug: string): Brand | undefined {
  return BRANDS.find((name) => BANK_SLUGS[name] === slug);
}
