import { describe, expect, it } from 'vitest';
import { isEntryLevel } from '../src/index';

// Real titles from the live snapshot wherever possible — the hub is only as
// good as the false positives it refuses.
const positives: string[] = [
  'Teller',
  'Service Consultant (Johannesburg, ZA)',
  '80 Hour Service Consultant (Johannesburg, ZA)',
  'Service Consultant Maternity Replacement (Polokwane, ZA)',
  'Sales Consultant (FAIS)',
  // Absa posts both inversions, hence 'consultant sales' and 'consultant:
  // sales' beside 'sales consultant' — the colon defeats \s+ phrase joining,
  // so the punctuated form is its own keyword.
  'Junior Consultant Sales (FAIS)',
  'Consultant: Sales (FAIS)',
  // Capitec's frontline vocabulary, pre-seeded before their branch channel posts.
  'Bank Better Champion',
  'Cashier',
  'ATM Assistant',
  'Enquiries Officer',
  'Frontline Banker',
  // 'junior' is a hub keyword in its own right, so a junior role outside the
  // branch is a match. That is the intent: the page collects junior roles, not
  // only tellers.
  'Junior Software Engineer',
  // Accepted edge: a rank prefix does not stop a teller being a teller. This
  // exact Nedbank Namibia title is dropped by the page's country filter, not by
  // the predicate.
  'Senior Teller: Mariental (Mariental, NA)',
];

// The traps. All but the two invented boundary probes are live titles, and they
// are the reason keywordToRegex uses lookarounds rather than bare substrings:
// bare 'teller' reaches into "Storyteller" and bare 'cashier' into "Cashiering".
const negatives: string[] = [
  'Storyteller',
  'Cashiering Manager',
  'Confrontline Specialist',
  // 'consultant' alone is not a keyword — the phrase has to name the desk.
  'Internal Consultant (W&I - Paarl)',
  'Consultant, Retentions',
  'Risk Consultant (Johannesburg, ZA)',
  'Employee Relations Consultant - Cape Town',
  'Functional Configuration Consultant III',
  // Suffixed and inflected forms need their own keywords under the strict
  // boundaries: 'service consultant' does not reach "Servicing Consultant" and
  // 'enquiries' does not reach "Enquiry".
  'Omni Channel Servicing Consultant 1 1 (Johannesburg, ZA)',
  'Enquiry Management Specialist',
  'Java Developer',
  'Head of Retail Banking',
];

describe('isEntryLevel', () => {
  it.each(positives)('treats %j as an entry-level role', (title) => {
    expect(isEntryLevel(title)).toBe(true);
  });

  it.each(negatives)('does not treat %j as an entry-level role', (title) => {
    expect(isEntryLevel(title)).toBe(false);
  });

  it('matches keywords case-insensitively', () => {
    expect(isEntryLevel('TELLER')).toBe(true);
    expect(isEntryLevel('bank better champion')).toBe(true);
    expect(isEntryLevel('JUNIOR CONSULTANT SALES (FAIS)')).toBe(true);
  });

  it('is stateless across repeated calls (no /g regex lastIndex carry-over)', () => {
    const title = 'Service Consultant (Johannesburg, ZA)';
    expect(isEntryLevel(title)).toBe(true);
    expect(isEntryLevel(title)).toBe(true);
    expect(isEntryLevel(title)).toBe(true);
  });
});
