import { describe, expect, it } from 'vitest';
import {
  QUAL_LEVELS,
  REQUIREMENT_FIELDS,
  REQUIREMENT_FIELD_RULES,
  REQUIREMENT_RULES_VERSION,
  extractRequirements,
  type JobRequirements,
} from '../src/index';

// Every excerpt below is lifted from a live description_text in db/local.db
// (551 open jobs, 25 Jul 2026) — trimmed at sentence boundaries, never reworded.
// The SARB one is its ExternalQualificationsStr from fixtures/sarb/detail-1.json,
// which the adapter now folds into the description.
interface Case {
  name: string;
  source: string;
  title: string;
  text: string;
  expected: JobRequirements;
}

const cases: Case[] = [
  {
    // FirstRand's branch template: the minimum is Grade 12, the preference is a
    // certificate. Reading the "Preferred Qualification" window too is safe
    // precisely because the minimum wins — matric (0), not certificate (1).
    name: 'firstrand branch template (matric minimum, certificate preferred)',
    source: 'firstrand',
    title: 'Branch Advisor FAIS',
    text:
      'Qualification & Experience Requirement Minimum Qualification: Grade 12/ NQF Level 4 ' +
      'Preferred Qualification: NQF Level 5 Certificate in Banking, Business Administration, ' +
      'Customer Service, or related fields recognized by FAIS 1–3 years of experience in ' +
      'customer-facing environments, service delivery, or client support within financial services',
    expected: { minQual: 0, minNqf: 4, fields: ['finance', 'business-commerce'], minYears: 1 },
  },
  {
    // Nedbank's per-source heading. The global 'essential qualification' also
    // hits inside it, opening a second overlapping window — harmless, because
    // every read is a min-take or a set union.
    name: 'nedbank essential-qualifications block',
    source: 'nedbank',
    title: 'Software Developer II (Johannesburg, ZA)',
    text:
      'Essential Qualifications - NQF Level Diploma in Computer Science or Information ' +
      "Technology (NQF Level 6) Preferred Qualification Bachelor's degree Minimum Experience " +
      'Level 5 - 10 years’ experience in an IT environment',
    expected: { minQual: 2, minNqf: 6, fields: ['it'], minYears: 5 },
  },
  {
    // Absa states the NQF level and the qualification name in one line, and the
    // fields of study as a slash-separated list. minYears comes from "1 to 2
    // years credit management experience"; "At least three years'" is words,
    // not digits, and is deliberately not parsed.
    //
    // 'business-commerce' is deliberately ABSENT, and that is the rules-v2 fix:
    // under v1 the bare keyword 'management' matched inside "Credit Management"
    // and mislabelled a credit qualification as a business/commerce one. Credit
    // Management is a risk-family qualification, and the risk field still
    // captures it through the 'credit management' keyword.
    name: 'absa education line (NQF 7 + bachelors + slash-separated fields)',
    source: 'absa',
    title: 'Specialist: Credit Officer - Credit Lending',
    text:
      'Education: NQF Level 7 (Accounting/Finance/Investment/Economics/Risk/ Credit Management)/ ' +
      'Bachelors Degree. 1 to 2 years credit management experience or similar. At least three ' +
      "years' relevant banking experience.",
    expected: {
      minQual: 3,
      minNqf: 7,
      fields: ['finance', 'accounting', 'economics', 'risk'],
      minYears: 1,
    },
  },
  {
    // Capitec's two per-source headings, minimum and ideal. Honours (4) is the
    // ideal; the Bachelor's minimum (3) is what a job-seeker is measured against.
    name: 'capitec qualifications (minimum) vs (ideal or preferred)',
    source: 'capitec',
    title: 'Data Analyst II',
    text:
      "Qualifications (Minimum) Bachelor's Degree in Finance or Economics " +
      'Qualifications (Ideal or Preferred) Honours Degree in Analytical/Data/Technical or Other',
    expected: { minQual: 3, minNqf: null, fields: ['finance', 'economics'], minYears: null },
  },
  {
    // Standard Bank's table layout: no NQF anywhere, a postgrad sweetener, and
    // the years only readable BACKWARDS from the word "Experience" — which is
    // the entire reason for the second minYears pattern.
    name: 'standardbank qualifications table (postgrad advantageous, min-taking keeps degree)',
    source: 'standardbank',
    title: 'Manager, Branch',
    text:
      'Qualifications Type of Qualification: First Degree Field of Study: Business Commerce, ' +
      'Finance and Accounting, Marketing Post Graduate Degree would be advantageous ' +
      'Experience Required Sales Sales & Distribution 1-2 years',
    expected: {
      minQual: 3,
      minNqf: null,
      fields: ['finance', 'accounting', 'business-commerce', 'marketing'],
      minYears: 1,
    },
  },
  {
    // SARB, post-fold: its requirements only reach description_text once the
    // adapter appends ExternalQualificationsStr. "NQF&nbsp;8" survives
    // sanitisation as a real non-breaking space (kept verbatim below), which is
    // why the NQF pattern separates on \s and not on a literal space.
    //
    // minQual is 3, NOT 4: 'degree' matches inside "Honours degree", and the
    // minimum wins over both the postgrad keyword and the NQF-8 mapping. That
    // is the designed direction of error — under-stating shows a postgrad role
    // to a degree holder, over-stating would hide it from the postgrad holder.
    name: 'sarb job-requirements block (post adapter fold)',
    source: 'sarb',
    title: 'Network Security Specialist',
    text:
      'Job requirements To be considered for this position, candidates must be in possession ' +
      'of: the minimum of an Honours degree (NQF' +
      // A literal U+00A0, spelled out: this is what &nbsp; sanitises to.
      '\u00a08) in Information Technology (IT) or ' +
      'Computer Science, or an equivalent qualification; industry certifications; a Cisco ' +
      'Certified Network Associate (CCNP); and the minimum of 8–10 years’ experience in ' +
      'network security solutions.',
    expected: { minQual: 3, minNqf: 8, fields: ['it'], minYears: 8 },
  },
  {
    // Half of FirstRand's branch ads carry no heading at all, just an NQF level
    // in running prose. NQF is unambiguous wherever it appears, so it falls
    // back to the whole text — but fields stay empty, because with no window
    // there is nothing to trust.
    name: 'firstrand heading-less ad (whole-text NQF fallback, no fields)',
    source: 'firstrand',
    title: 'Branch Advisor FAIS',
    text:
      'You will be an ideal candidate if you possess the following: A completed financial ' +
      'related qualification (NQF5 or higher) 1-2 years’ experience in Client Services Support',
    expected: { minQual: 1, minNqf: 5, fields: [], minYears: 1 },
  },
  {
    // The reported bug, pinned. A visitor who typed "Bcom finance" (parsed to
    // finance + business-commerce) was shown THIS ad as a STRONG fit, because
    // v1's bare 'management' keyword fired on "Access control and identity
    // management" — a security capability, not a degree — 450 chars deep in the
    // window that "Qualifications" opened. Rules v2 drops that keyword, so the
    // only fields left are the two the ad actually names.
    name: 'capitec cyber security engineer (no business-commerce from "identity management")',
    source: 'capitec',
    title: 'Cyber Security Engineer',
    text:
      'Qualifications Minimum: A relevant tertiary qualification in AWS Foundation or Cloud ' +
      "Computing Ideal or Preferred: Bachelor's Degree in Information Technology or Engineering " +
      '– OtherRelevant certifications such as CISSP, CISM, CISA, or other security-related ' +
      'certifications.AWS Data/Security certification Technical capabilities Strong ' +
      'understanding of: Cloud security principles Data protection (encryption, masking, DLP) ' +
      'Access control and identity management Experience with: Scripting (e.g. Bash, PowerShell, ' +
      'Python) Infrastructure-as-Code (e.g. Terraform, Ansible, CloudFormation) DevOps ' +
      'environments and practices Conditions of Employment Clear criminal and credit record',
    expected: { minQual: 3, minNqf: null, fields: ['it', 'engineering'], minYears: null },
  },
  {
    // The reported /fit accuracy bug, pinned: qualification tables often list
    // options in the PLURAL ("Bachelor`s Degrees and Advanced Diplomas"), and
    // v2's keyword lists only had singular forms ("degree", "advanced
    // diploma"). Neither matched, so 61 of 553 live jobs (11%) got the wrong
    // minQual — most of them OVERSTATED (shown as 'degree' when the ad's real
    // floor was 'diploma'), which the file header calls the unrecoverable
    // direction of error. Rules v3 adds the plural forms.
    //
    // minQual is 2 (diploma), not 3 (degree): the bare 'diplomas' keyword
    // fires inside "Advanced Diplomas" and the minimum wins over 'bachelor'/
    // 'advanced diploma' — the same min-take rule that already resolves
    // "Honours degree" to 'degree'. The backtick in "Bachelor`s" is verbatim
    // from the live ad; ATSes emit straight, curly and backtick apostrophes
    // interchangeably, which is also why keywordToRegex treats them as one.
    name: 'absa branch manager (plural qualification names, backtick apostrophe)',
    source: 'absa',
    title: 'Branch Manager - Alfa House',
    text:
      'Education Bachelor`s Degrees and Advanced Diplomas: Business, Commerce and ' +
      'Management Studies (Required)',
    expected: { minQual: 2, minNqf: null, fields: ['business-commerce'], minYears: null },
  },
  {
    // FirstRand's advisor boilerplate, where the global heading 'education'
    // matches MID-SENTENCE ("…experience and education to Private Wealth
    // clients…") and opens a 450-char window over pure marketing copy. Under v1
    // that window yielded business-commerce (from "Money Management") and it
    // (from "make it happen" — the text is lowercased before matching, so the
    // pronoun looked like the keyword 'IT'), tagging ~12 advisor ads as
    // degree-in-IT roles. The window still opens under v2 — the heading match is
    // real — but no v2 keyword fires inside it, so the honest answer is nothing.
    name: 'firstrand advisor boilerplate (mid-sentence "education" window yields nothing)',
    source: 'firstrand',
    title: 'Wealth Manager',
    text:
      'Job Description To deliver exceptional experience and education to Private Wealth clients ' +
      'on basic wealth creation, accumulation and overall protection tactics to increase ' +
      'vertical sales index (VSI) and drive client retention and entrenchment through using ' +
      'contextual Money Management principles. Welcome to FNB, the home of the #changeables . ' +
      'We design for the shapeshifters and deliver products and services that make us ' +
      'incredibly proud of the people who make it happen.',
    expected: { minQual: null, minNqf: null, fields: [], minYears: null },
  },
];

const ALL_NULL: JobRequirements = { minQual: null, minNqf: null, fields: [], minYears: null };

describe('extractRequirements', () => {
  it.each(cases)('$name', ({ source, title, text, expected }) => {
    expect(extractRequirements({ title, descriptionText: text, source })).toEqual(expected);
  });

  it('returns the all-null shape when nothing is stated', () => {
    // A real Investec ad: prose only, no heading, no NQF, no years.
    const text =
      'Description of the role Main responsibilities: Executing all administrative duties ' +
      'relating to investments, including client onboarding and account opening.';
    expect(
      extractRequirements({
        title: 'Investment Administrator',
        descriptionText: text,
        source: 'investec',
      }),
    ).toEqual(ALL_NULL);
  });

  it('ignores field words that fall outside the qualification window', () => {
    // "engineering team" is a department, not a degree. 450 chars of filler put
    // it past the window that "Education" opened.
    const text = `Education Bachelors Degree in Commerce ${'filler '.repeat(80)} Join our engineering team today.`;
    const result = extractRequirements({ title: 'Manager', descriptionText: text, source: 'absa' });
    expect(result.fields).toEqual(['business-commerce']);
    expect(result.fields).not.toContain('engineering');
  });

  it('ignores NQF numbers outside the 1–10 range', () => {
    const result = extractRequirements({
      title: 'Manager',
      descriptionText: 'Education NQF 99 reference number applies.',
      source: 'absa',
    });
    expect(result.minNqf).toBeNull();
    expect(result.minQual).toBeNull();
  });

  it('maps NQF levels onto qualification tiers monotonically', () => {
    const ordinalFor = (nqf: number): number | null =>
      extractRequirements({
        title: 'Analyst',
        descriptionText: `Education NQF Level ${nqf}`,
        source: 'absa',
      }).minQual;

    expect([3, 4].map(ordinalFor)).toEqual([0, 0]);
    expect(ordinalFor(5)).toBe(1);
    expect(ordinalFor(6)).toBe(2);
    expect(ordinalFor(7)).toBe(3);
    expect([8, 9, 10].map(ordinalFor)).toEqual([4, 4, 4]);
  });

  it('takes the lowest of several stated levels and year counts', () => {
    const result = extractRequirements({
      title: 'Specialist',
      descriptionText:
        'Minimum Qualification: NQF Level 6 Diploma. Preferred Qualification: NQF Level 8 ' +
        "Honours Degree. 8-10 years' experience preferred, 3 years' experience required.",
      source: 'firstrand',
    });
    expect(result).toEqual({ minQual: 2, minNqf: 6, fields: [], minYears: 3 });
  });

  it('reads NQF written with or without "level", a colon, or a (non-breaking) space', () => {
    const forms = ['NQF 6', 'NQF Level 6', 'NQF level: 6', 'NQF6', 'nqf 6', 'NQF\u00a06'];
    for (const form of forms) {
      expect(
        extractRequirements({ title: 'x', descriptionText: `Education ${form}`, source: 'absa' })
          .minNqf,
      ).toBe(6);
    }
  });

  it('matches a keyword apostrophe against straight, curly and backtick forms', () => {
    // "master's" has no bare 'master' fallback keyword (only 'masters', a
    // different literal string), so this isolates the apostrophe fix: without
    // it, none of the three real-world forms an ATS emits would match at all.
    for (const form of ["Master's", 'Master’s', 'Master`s']) {
      const result = extractRequirements({
        title: 'Analyst',
        descriptionText: `Qualifications ${form} in Finance required`,
        source: 'absa',
      });
      expect(result.minQual).toBe(4);
    }
  });

  it('respects keyword boundaries inside the window', () => {
    // 'IT' must not match "digital", and 'ba' must not match "database" —
    // keywordToRegex's lookarounds, exercised through the field taxonomy.
    const result = extractRequirements({
      title: 'Analyst',
      descriptionText: 'Qualifications A digital database background is useful.',
      source: 'absa',
    });
    expect(result.fields).toEqual([]);
    expect(result.minQual).toBeNull();
  });

  it('falls back to global headings for an unknown source', () => {
    const result = extractRequirements({
      title: 'Analyst',
      descriptionText: 'Minimum Qualification: National Diploma in Accounting',
      source: 'a-bank-that-does-not-exist-yet',
    });
    expect(result.minQual).toBe(2);
    expect(result.fields).toEqual(['accounting']);
  });

  it('is stateless across repeated calls (no /g regex lastIndex carry-over)', () => {
    const input = {
      title: 'Branch Advisor FAIS',
      descriptionText: "Education NQF Level 6 Diploma. 5 years' experience.",
      source: 'absa',
    };
    const first = extractRequirements(input);
    expect(extractRequirements(input)).toEqual(first);
    expect(extractRequirements(input)).toEqual(first);
    expect(first).toEqual({ minQual: 2, minNqf: 6, fields: [], minYears: 5 });
  });
});

describe('requirement rules', () => {
  it('exposes a versioned taxonomy with unique slugs', () => {
    expect(REQUIREMENT_RULES_VERSION).toBeGreaterThanOrEqual(1);
    const slugs = REQUIREMENT_FIELDS.map((f) => f.field);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(REQUIREMENT_FIELDS).toHaveLength(REQUIREMENT_FIELD_RULES.length);
  });

  it('only ever reports slugs that are in the taxonomy', () => {
    const slugs = new Set(REQUIREMENT_FIELDS.map((f) => f.field));
    const text =
      'Qualifications Degree in Finance, Accounting, Economics, Commerce, Information ' +
      'Technology, Statistics, Actuarial Science, Engineering, Law, Risk Management, ' +
      'Marketing or Human Resources.';
    const result = extractRequirements({ title: 'x', descriptionText: text, source: 'absa' });
    expect(result.fields.length).toBeGreaterThan(0);
    for (const field of result.fields) expect(slugs.has(field)).toBe(true);
  });

  it('orders qualification tiers lowest-first', () => {
    expect(QUAL_LEVELS).toEqual(['matric', 'certificate', 'diploma', 'degree', 'postgrad']);
  });
});
