import { describe, expect, it } from 'vitest';
import { pickRelated } from '../src/lib/related';
import type { RelatedCandidate } from '../src/lib/related';

// Synthetic pool only — the picker is pure and structural, so nothing here
// touches the job snapshot. Pool order is meaningful (the real pool is
// postedDate desc, nulls last, id tiebreak), so tests state it explicitly.

interface MakeOpts {
  category?: string;
  brand?: string;
  country?: string;
  /** undefined → no locations at all; null → a location with no province. */
  province?: string | null;
}

function make(id: string, opts: MakeOpts = {}): RelatedCandidate {
  const { category = 'Sales', brand = 'Absa', country = 'ZA' } = opts;
  const locations = 'province' in opts ? [{ province: opts.province ?? null }] : [];
  return { id, brand, category, country, locations };
}

const target = make('target', { category: 'Sales', brand: 'Absa', province: 'Gauteng' });

describe('pickRelated tiers', () => {
  // Deliberately WORST-first in pool order, so a passing order test proves the
  // tiers beat pool position rather than accidentally agreeing with it.
  const t4 = make('t4', { category: 'Software & IT', brand: 'Absa', province: 'Western Cape' });
  const t3 = make('t3', { category: 'Sales', brand: 'Nedbank', province: 'Limpopo' });
  const t2 = make('t2', { category: 'Sales', brand: 'Absa', country: 'NA', province: null });
  const t1 = make('t1', { category: 'Sales', brand: 'Capitec', province: 'Gauteng' });
  const pool = [t4, t3, t2, t1];

  it('orders province, then brand, then country, then brand-only', () => {
    expect(pickRelated(target, pool, 4).map((j) => j.id)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('fills the best tier first when capped below the tier count', () => {
    expect(pickRelated(target, pool, 1).map((j) => j.id)).toEqual(['t1']);
    expect(pickRelated(target, pool, 2).map((j) => j.id)).toEqual(['t1', 't2']);
  });

  it('keeps pool order within a tier', () => {
    const a = make('a', { category: 'Sales', brand: 'FNB', province: 'Gauteng' });
    const b = make('b', { category: 'Sales', brand: 'FNB', province: 'Gauteng' });
    const c = make('c', { category: 'Sales', brand: 'FNB', province: 'Gauteng' });
    expect(pickRelated(target, [c, a, b]).map((j) => j.id)).toEqual(['c', 'a', 'b']);
  });

  it('skips a tier entirely when nothing matches it', () => {
    // No same-province and no same-brand-and-category rows: tier 3 then 4.
    const country = make('country', { category: 'Sales', brand: 'FNB', province: 'Limpopo' });
    const brandOnly = make('brandOnly', { category: 'Other', brand: 'Absa', province: 'Limpopo' });
    expect(pickRelated(target, [brandOnly, country]).map((j) => j.id)).toEqual([
      'country',
      'brandOnly',
    ]);
  });

  it('never returns a row matching no tier at all', () => {
    const unrelated = make('unrelated', {
      category: 'Software & IT',
      brand: 'Nedbank',
      country: 'KE',
      province: null,
    });
    expect(pickRelated(target, [unrelated])).toEqual([]);
  });
});

describe('pickRelated exclusion and dedup', () => {
  it('never returns the job itself', () => {
    const twin = make('twin', { category: 'Sales', brand: 'Absa', province: 'Gauteng' });
    const picked = pickRelated(target, [target, twin]);
    expect(picked.map((j) => j.id)).toEqual(['twin']);
  });

  it('excludes any row sharing the job id, even a different object', () => {
    const impostor = make('target', { category: 'Sales', brand: 'Absa', province: 'Gauteng' });
    expect(pickRelated(target, [impostor])).toEqual([]);
  });

  it('returns a row once when it matches several tiers', () => {
    // Same category + province (t1) AND same brand (t2/t4) — one row out.
    const both = make('both', { category: 'Sales', brand: 'Absa', province: 'Gauteng' });
    expect(pickRelated(target, [both]).map((j) => j.id)).toEqual(['both']);
  });

  it('dedups a pool that repeats the same id', () => {
    const row = make('dup', { category: 'Sales', brand: 'Absa', province: 'Gauteng' });
    const copy = make('dup', { category: 'Sales', brand: 'Absa', province: 'Gauteng' });
    expect(pickRelated(target, [row, copy, row]).map((j) => j.id)).toEqual(['dup']);
  });

  it('returns nothing for a pool holding only the job itself', () => {
    expect(pickRelated(target, [target])).toEqual([]);
  });

  it('returns nothing for an empty pool', () => {
    expect(pickRelated(target, [])).toEqual([]);
  });
});

describe('pickRelated cap', () => {
  const pool = Array.from({ length: 10 }, (_, i) =>
    make(`j${i}`, { category: 'Sales', brand: 'Absa', province: 'Gauteng' }),
  );

  it('defaults to five rows', () => {
    expect(pickRelated(target, pool)).toHaveLength(5);
    expect(pickRelated(target, pool).map((j) => j.id)).toEqual(['j0', 'j1', 'j2', 'j3', 'j4']);
  });

  it('honours an explicit max', () => {
    expect(pickRelated(target, pool, 3).map((j) => j.id)).toEqual(['j0', 'j1', 'j2']);
    expect(pickRelated(target, pool, 20)).toHaveLength(10);
  });

  it('returns nothing for a non-positive max', () => {
    expect(pickRelated(target, pool, 0)).toEqual([]);
    expect(pickRelated(target, pool, -1)).toEqual([]);
  });
});

describe('pickRelated province handling', () => {
  it('falls back to the country tier for an international job with no province', () => {
    const intl = make('intl', { category: 'Sales', brand: 'Absa', country: 'NA', province: null });
    const sameCountry = make('sameCountry', {
      category: 'Sales',
      brand: 'Nedbank',
      country: 'NA',
      province: null,
    });
    // Same category AND same brand, but South African — for a job with a
    // province that would be tier 2 either way; the point is that the
    // province-less job's TOP tier is country, so the Namibian row outranks it.
    const za = make('za', { category: 'Sales', brand: 'Absa', province: 'Gauteng' });
    expect(pickRelated(intl, [za, sameCountry], 2).map((j) => j.id)).toEqual(['sameCountry', 'za']);
  });

  it('treats a job with no locations the same as one with a null province', () => {
    const noLocations = make('noloc', { category: 'Sales', brand: 'Absa', country: 'ZA' });
    const nullProvince = make('nullprov', {
      category: 'Sales',
      brand: 'Absa',
      country: 'ZA',
      province: null,
    });
    const pool = [
      make('a', { category: 'Sales', brand: 'FNB', province: 'Gauteng' }),
      make('b', { category: 'Sales', brand: 'FNB', country: 'NA', province: null }),
    ];
    expect(pickRelated(noLocations, pool).map((j) => j.id)).toEqual(
      pickRelated(nullProvince, pool).map((j) => j.id),
    );
    // Tier 1 for both is "same category + same country", so the SA row comes
    // through and the Namibian one — same category, but another country and
    // another brand — matches no tier at all.
    expect(pickRelated(noLocations, pool).map((j) => j.id)).toEqual(['a']);
  });

  it('does not match a null province against another null province', () => {
    // Two province-less SA rows are only related through the country tier, so
    // an off-category one stays out.
    const job = make('job', { category: 'Sales', brand: 'Absa', country: 'ZA', province: null });
    const other = make('other', { category: 'Other', brand: 'FNB', country: 'ZA', province: null });
    expect(pickRelated(job, [other])).toEqual([]);
  });
});

describe('pickRelated determinism', () => {
  const pool = [
    make('a', { category: 'Sales', brand: 'FNB', province: 'Gauteng' }),
    make('b', { category: 'Sales', brand: 'Absa', country: 'NA', province: null }),
    make('c', { category: 'Other', brand: 'Absa', province: 'Limpopo' }),
    make('d', { category: 'Sales', brand: 'Nedbank', province: 'Western Cape' }),
    make('e', { category: 'Sales', brand: 'Capitec', province: 'Gauteng' }),
    target,
  ];

  it('gives the same answer for the same input every time', () => {
    const first = pickRelated(target, pool).map((j) => j.id);
    for (let i = 0; i < 5; i += 1) {
      expect(pickRelated(target, pool).map((j) => j.id)).toEqual(first);
    }
    expect(first).toEqual(['a', 'e', 'b', 'd', 'c']);
  });

  it('does not mutate the pool or the job', () => {
    const snapshot = pool.map((j) => j.id);
    const before = JSON.stringify(target);
    pickRelated(target, pool);
    expect(pool.map((j) => j.id)).toEqual(snapshot);
    expect(JSON.stringify(target)).toBe(before);
  });
});
