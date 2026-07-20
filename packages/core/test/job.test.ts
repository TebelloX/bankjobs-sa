import { describe, expect, it } from 'vitest';
import { CATEGORIES, CATEGORY_SLUGS, jobSlug } from '../src/index';

const slugCases: Array<[string, string]> = [
  ['absa:R-15989226', 'absa-r-15989226'],
  ['firstrand:FNB-123', 'firstrand-fnb-123'],
  ['UPPER:CASE', 'upper-case'],
  ['already-clean', 'already-clean'],
  ['  Weird__ID!!  ', 'weird-id'],
  ['---leading-and-trailing---', 'leading-and-trailing'],
  ['a...b___c', 'a-b-c'],
];

describe('jobSlug', () => {
  it.each(slugCases)('slugifies %j -> %j', (input, expected) => {
    expect(jobSlug(input)).toBe(expected);
  });
});

describe('CATEGORY_SLUGS', () => {
  it('has a slug for every category', () => {
    for (const category of CATEGORIES) {
      expect(CATEGORY_SLUGS[category]).toBeTruthy();
    }
  });

  it('matches the specified slugs', () => {
    expect(CATEGORY_SLUGS['Software & IT']).toBe('software-it');
    expect(CATEGORY_SLUGS['Branch & Retail']).toBe('branch-retail');
    expect(CATEGORY_SLUGS['Customer Service']).toBe('customer-service');
    expect(CATEGORY_SLUGS['Data & Analytics']).toBe('data-analytics');
    expect(CATEGORY_SLUGS['Finance & Accounting']).toBe('finance-accounting');
    expect(CATEGORY_SLUGS['Risk & Compliance']).toBe('risk-compliance');
    expect(CATEGORY_SLUGS['Credit & Lending']).toBe('credit-lending');
    expect(CATEGORY_SLUGS['Operations & Admin']).toBe('operations-admin');
    expect(CATEGORY_SLUGS['Sales']).toBe('sales');
    expect(CATEGORY_SLUGS['Other']).toBe('other');
  });

  it('produces unique slugs', () => {
    const slugs = Object.values(CATEGORY_SLUGS);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});
