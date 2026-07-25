import { describe, expect, it } from 'vitest';
import type { Province } from '@bankjobs/core';
import { PROVINCE_SLUGS } from '../src/lib/provinces';
import { MIN_CITY_JOBS, PAGE_CITIES, cityForSlug, derivePageCities } from '../src/lib/cities';
import type { CityJob } from '../src/lib/cities';

// derivePageCities is pure and structural, so the bulk of this file feeds it a
// synthetic snapshot rather than the real one — the floor, the slug rule and the
// route-safety exclusions all have to be provable against inputs today's feeds
// happen not to produce. The last block does exercise the real derivation, but
// only on invariants that hold for ANY snapshot: nothing here pins a city, a
// count or a page total, all of which change with every crawl.

/** `n` job rows whose PRIMARY location is `city` in `province`. */
function rows(n: number, city: string | null, province: Province | null = 'Gauteng'): CityJob[] {
  return Array.from({ length: n }, () => ({ locations: [{ city, province }] }));
}

/** Just the names, in the order derivePageCities returned them. */
function names(cities: ReturnType<typeof derivePageCities>): string[] {
  return cities.map((c) => c.name);
}

describe('derivePageCities job floor', () => {
  it('keeps a city sitting exactly on the floor', () => {
    expect(names(derivePageCities(rows(MIN_CITY_JOBS, 'Hermanus')))).toEqual(['Hermanus']);
  });

  it('drops a city one row below the floor', () => {
    expect(derivePageCities(rows(MIN_CITY_JOBS - 1, 'Kakamas'))).toEqual([]);
  });

  it('drops the thin cities and keeps the thick ones from one snapshot', () => {
    const jobs = [
      ...rows(1, 'Sannieshof'),
      ...rows(MIN_CITY_JOBS, 'Roodepoort'),
      ...rows(MIN_CITY_JOBS + 40, 'Johannesburg'),
      ...rows(2, 'Springs'),
    ];
    expect(names(derivePageCities(jobs))).toEqual(['Johannesburg', 'Roodepoort']);
  });

  // The floor is a product decision (quality over sprawl — see cities.ts), not
  // an implementation detail, so it is pinned rather than inferred.
  it('sits at three open roles', () => {
    expect(MIN_CITY_JOBS).toBe(3);
  });
});

describe('derivePageCities slug rule', () => {
  function slugFor(city: string): string | undefined {
    return derivePageCities(rows(MIN_CITY_JOBS, city))[0]?.slug;
  }

  it('kebabs multi-word names', () => {
    expect(slugFor('Cape Town')).toBe('cape-town');
    expect(slugFor('Century City')).toBe('century-city');
    expect(slugFor('Port Elizabeth')).toBe('port-elizabeth');
  });

  it('lowercases a run-together name without inserting separators', () => {
    expect(slugFor('eMalahleni')).toBe('emalahleni');
    expect(slugFor('Mbombela')).toBe('mbombela');
  });

  it('collapses punctuation runs to a single dash and trims the edges', () => {
    expect(slugFor('Bela-Bela')).toBe('bela-bela');
    expect(slugFor('Port St. Johns')).toBe('port-st-johns');
    expect(slugFor(" 'Mangaung' ")).toBe('mangaung');
  });
});

describe('derivePageCities route-safety guard', () => {
  it('excludes a city whose slug is one of the province slugs', () => {
    // /vacancies/limpopo/ and /vacancies/north-west/ belong to [province].astro.
    expect(derivePageCities(rows(MIN_CITY_JOBS + 9, 'Limpopo', 'Limpopo'))).toEqual([]);
    expect(derivePageCities(rows(MIN_CITY_JOBS, 'North West', 'North West'))).toEqual([]);
  });

  it('excludes a purely numeric name', () => {
    // /vacancies/2/ belongs to [...page].astro's pagination.
    expect(derivePageCities(rows(MIN_CITY_JOBS, '2'))).toEqual([]);
    expect(derivePageCities(rows(MIN_CITY_JOBS, '007'))).toEqual([]);
  });

  it('excludes a name that kebabs to nothing', () => {
    // An empty slug emits /vacancies/ itself — page 1 of the ledger.
    expect(derivePageCities(rows(MIN_CITY_JOBS, '—'))).toEqual([]);
    expect(derivePageCities(rows(MIN_CITY_JOBS, '  '))).toEqual([]);
  });

  it("excludes the 'National' coverage placeholder", () => {
    expect(derivePageCities(rows(MIN_CITY_JOBS + 20, 'National'))).toEqual([]);
  });

  it('gives a slug shared by two names to the bigger ledger only', () => {
    const jobs = [...rows(MIN_CITY_JOBS, 'Bela-Bela'), ...rows(MIN_CITY_JOBS + 5, 'Bela Bela')];
    expect(derivePageCities(jobs)).toEqual([
      { name: 'Bela Bela', slug: 'bela-bela', province: 'Gauteng' },
    ]);
  });

  it('excludes the guarded names without taking the good ones down with them', () => {
    const jobs = [
      ...rows(MIN_CITY_JOBS, 'Gauteng', 'Gauteng'),
      ...rows(MIN_CITY_JOBS, 'National'),
      ...rows(MIN_CITY_JOBS, '3'),
      ...rows(MIN_CITY_JOBS, 'Sandton'),
    ];
    expect(names(derivePageCities(jobs))).toEqual(['Sandton']);
  });
});

describe('derivePageCities province', () => {
  it("takes the province off the city's own rows", () => {
    expect(derivePageCities(rows(MIN_CITY_JOBS, 'Durban', 'KwaZulu-Natal'))).toEqual([
      { name: 'Durban', slug: 'durban', province: 'KwaZulu-Natal' },
    ]);
  });

  it('uses the first non-null province when the earliest rows parsed none', () => {
    const jobs = [
      ...rows(2, 'George', null),
      ...rows(1, 'George', 'Western Cape'),
      ...rows(1, 'George', 'Gauteng'),
    ];
    expect(derivePageCities(jobs)[0]?.province).toBe('Western Cape');
  });

  it('is null when no row under the city parsed a province', () => {
    expect(derivePageCities(rows(MIN_CITY_JOBS, 'Umhlanga', null))[0]?.province).toBeNull();
  });
});

describe('derivePageCities row selection', () => {
  it('ignores rows with no locations at all', () => {
    const jobs: CityJob[] = [...rows(MIN_CITY_JOBS, 'Pretoria'), { locations: [] }];
    expect(names(derivePageCities(jobs))).toEqual(['Pretoria']);
  });

  it('ignores rows whose primary location parsed no city', () => {
    const jobs = [...rows(MIN_CITY_JOBS, 'Pretoria'), ...rows(9, null)];
    expect(names(derivePageCities(jobs))).toEqual(['Pretoria']);
  });

  it('counts the primary location only, never a second one', () => {
    // Two-location adverts are filed under their first city, the same rule the
    // province pages use — otherwise a city's page count and its ledger differ.
    const jobs: CityJob[] = Array.from({ length: MIN_CITY_JOBS }, () => ({
      locations: [
        { city: 'Sandton', province: 'Gauteng' },
        { city: 'Cape Town', province: 'Western Cape' },
      ] satisfies CityJob['locations'],
    }));
    expect(names(derivePageCities(jobs))).toEqual(['Sandton']);
  });

  it('returns nothing for an empty snapshot', () => {
    expect(derivePageCities([])).toEqual([]);
  });
});

describe('derivePageCities ordering', () => {
  const jobs = [
    ...rows(MIN_CITY_JOBS, 'Randburg'),
    ...rows(MIN_CITY_JOBS + 30, 'Johannesburg'),
    ...rows(MIN_CITY_JOBS, 'Bellville', 'Western Cape'),
    ...rows(MIN_CITY_JOBS + 10, 'Cape Town', 'Western Cape'),
  ];

  it('leads with the biggest ledger and breaks ties on the city name', () => {
    // Bellville and Randburg tie at the floor, so the name decides.
    expect(names(derivePageCities(jobs))).toEqual([
      'Johannesburg',
      'Cape Town',
      'Bellville',
      'Randburg',
    ]);
  });

  it('gives the same order every time, so a rebuild cannot reshuffle the row', () => {
    const first = names(derivePageCities(jobs));
    for (let i = 0; i < 5; i += 1) {
      expect(names(derivePageCities(jobs))).toEqual(first);
    }
  });

  it('does not mutate the rows it was given', () => {
    const before = JSON.stringify(jobs);
    derivePageCities(jobs);
    expect(JSON.stringify(jobs)).toBe(before);
  });
});

describe('PAGE_CITIES / cityForSlug', () => {
  // Snapshot-agnostic invariants on the REAL derivation. The route-safety one is
  // the load-bearing test in this file: a slug that slipped through would break
  // the build the next time the feeds moved, not today.

  it('emits url-safe kebab-case slugs only', () => {
    for (const city of PAGE_CITIES) {
      expect(city.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('never emits a slug a sibling /vacancies/ route already owns', () => {
    const provinceSlugs = new Set<string>(Object.values(PROVINCE_SLUGS));
    for (const city of PAGE_CITIES) {
      expect(provinceSlugs.has(city.slug)).toBe(false);
      expect(city.slug).not.toMatch(/^[0-9]+$/);
    }
  });

  it('gives every city a unique slug', () => {
    const slugs = PAGE_CITIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('round-trips every city through cityForSlug', () => {
    for (const city of PAGE_CITIES) {
      expect(cityForSlug(city.slug)).toEqual(city);
    }
  });

  it('returns undefined for a slug with no page', () => {
    expect(cityForSlug('not-a-city')).toBeUndefined();
    expect(cityForSlug('Johannesburg')).toBeUndefined();
    expect(cityForSlug('')).toBeUndefined();
  });
});
