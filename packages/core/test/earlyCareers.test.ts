import { describe, expect, it } from 'vitest';
import { isEarlyCareers } from '../src/index';

// Real titles from the live snapshot wherever possible — the hub is only as
// good as the false positives it refuses.
const positives: string[] = [
  'Capitec Internship Programme 2027',
  'Capitec Graduate Programme 2027',
  'Graduate Programme 2027: Data Science',
  'Learnership Opportunity: Client Services',
  'Actuarial Bursary',
  'Trainee Financial Advisor',
  'FNB Engineering & Technology Graduate Programme',
  'Private Banking and Advisory Graduate Academy 2027',
  'Development Programme, Internship',
  // Suffixed forms need their own keywords — 'apprentice' does not match
  // 'Apprenticeship' under the strict boundaries. Both are listed, so both hit.
  'Apprenticeship: Fitter and Turner',
  // Accepted edge: 'Master Apprentice Chef' matches. An apprentice is
  // early-career whatever the qualifier, so this is the right answer rather
  // than a tolerated miss — 'Master' names the trade rank, not seniority.
  'Master Apprentice Chef',
];

// The traps. 'Internal Consultant (W&I - Paarl)' is a real Investec title and
// the reason the word boundaries use lookarounds rather than \b-free substrings.
const negatives: string[] = [
  'Internal Consultant (W&I - Paarl)',
  'Internal Auditor',
  'Internal Audit Specialist',
  'International Banking Specialist',
  'Relationship Manager, International Wealth & Investment',
  // 'learner' must not reach into 'Learning'.
  'Senior Learning & Development Manager',
  'Postgraduate Recruitment Manager',
  'Teller',
  'Java Developer',
];

describe('isEarlyCareers', () => {
  it.each(positives)('treats %j as an early-careers role', (title) => {
    expect(isEarlyCareers(title)).toBe(true);
  });

  it.each(negatives)('does not treat %j as an early-careers role', (title) => {
    expect(isEarlyCareers(title)).toBe(false);
  });

  it('matches keywords case-insensitively', () => {
    expect(isEarlyCareers('GRADUATE PROGRAMME 2027')).toBe(true);
    expect(isEarlyCareers('actuarial bursary')).toBe(true);
  });

  it('is stateless across repeated calls (no /g regex lastIndex carry-over)', () => {
    const title = 'Capitec Internship Programme 2027';
    expect(isEarlyCareers(title)).toBe(true);
    expect(isEarlyCareers(title)).toBe(true);
    expect(isEarlyCareers(title)).toBe(true);
  });
});
