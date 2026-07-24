import { describe, expect, it } from 'vitest';
import { BRANDS } from '@bankjobs/core';
import { BANK_SLUGS, bankSlug, brandForSlug } from '../src/lib/banks';

describe('BANK_SLUGS', () => {
  it('covers every brand', () => {
    expect(Object.keys(BANK_SLUGS).sort()).toEqual([...BRANDS].sort());
  });

  it('gives every brand a unique slug', () => {
    const slugs = BRANDS.map((b) => BANK_SLUGS[b]);
    expect(new Set(slugs).size).toBe(BRANDS.length);
  });

  it('emits url-safe kebab-case slugs only', () => {
    for (const brand of BRANDS) {
      expect(BANK_SLUGS[brand]).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });
});

describe('bankSlug / brandForSlug', () => {
  it('round-trips every brand', () => {
    for (const brand of BRANDS) {
      expect(brandForSlug(bankSlug(brand))).toBe(brand);
    }
  });

  it('maps the multi-word brands the way the URLs read', () => {
    expect(bankSlug('Standard Bank')).toBe('standard-bank');
    expect(bankSlug('GoTyme Bank')).toBe('gotyme-bank');
    expect(bankSlug('Discovery Bank')).toBe('discovery-bank');
  });

  it('lowercases single-word brands without inserting separators', () => {
    expect(bankSlug('WesBank')).toBe('wesbank');
    expect(bankSlug('DirectAxis')).toBe('directaxis');
    expect(bankSlug('SARB')).toBe('sarb');
  });

  it('returns undefined for a slug that is not a brand', () => {
    expect(brandForSlug('not-a-bank')).toBeUndefined();
    expect(brandForSlug('Standard Bank')).toBeUndefined();
    expect(brandForSlug('')).toBeUndefined();
  });
});
