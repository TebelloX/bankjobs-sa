import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORIES, categorize, type Category, type SourceId } from '../src/index';

const cases: Array<[string, SourceId, string | undefined, Category]> = [
  // Real fixture titles called out in the spec.
  ['Adviser AIFA: Everyday Banking (FAIS)', 'absa', undefined, 'Sales'],
  ['Specialist Solution Analyst - Investor Services', 'absa', undefined, 'Software & IT'],
  ['Information Risk Manager', 'absa', undefined, 'Risk & Compliance'],
  // One representative title per category.
  ['Java Developer', 'absa', undefined, 'Software & IT'],
  ['.NET Developer', 'absa', undefined, 'Software & IT'],
  ['Data Scientist', 'absa', undefined, 'Data & Analytics'],
  ['Credit Analyst', 'absa', undefined, 'Credit & Lending'],
  ['Compliance Officer', 'absa', undefined, 'Risk & Compliance'],
  ['Financial Accountant', 'absa', undefined, 'Finance & Accounting'],
  ['Teller', 'absa', undefined, 'Branch & Retail'],
  ['Contact Centre Consultant', 'absa', undefined, 'Customer Service'],
  ['Sales Consultant', 'absa', undefined, 'Sales'],
  ['Operations Administrator', 'absa', undefined, 'Operations & Admin'],
  // Fallthrough.
  ['Gardener', 'absa', undefined, 'Other'],
  // sourceCategory participates in the match.
  ['Mystery Role', 'absa', 'Software Development', 'Software & IT'],
];

describe('categorize', () => {
  it.each(cases)('categorizes %j (%s) -> %s', (title, source, sourceCategory, expected) => {
    expect(categorize(title, source, sourceCategory)).toBe(expected);
  });

  it('only ever returns a known category', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../../../fixtures/absa/detail-1.json', import.meta.url), 'utf8'),
    );
    const title: string = fixture.jobPostingInfo.title;
    expect(CATEGORIES).toContain(categorize(title, 'absa'));
  });

  it('matches keywords case-insensitively', () => {
    expect(categorize('SENIOR JAVA DEVELOPER', 'absa')).toBe('Software & IT');
  });

  it('respects word boundaries (does not match "risk" inside another word)', () => {
    // "brisker" contains "risk" as a substring but not as a word.
    expect(categorize('Brisker Widget Handler', 'absa')).toBe('Other');
  });
});
