import { describe, expect, it } from 'vitest';
import { REQUIREMENT_FIELD_RULES } from '@bankjobs/core';
// Reaching straight at core's compiler by path, not through the package entry:
// keywordToRegex is core-internal (index.ts does not re-export it), and the
// parity guard below wants to bind to THAT FILE — it exists to fail when
// keywords.ts changes and matchFit.ts's copy does not. Legal here and only
// here: this is a node test, not client-bundled code.
import { keywordToRegex } from '../../packages/core/src/keywords';
import { REQUIREMENTS_DATA_URL, bucketJobs, matchJob, parseQualName } from '../src/lib/matchFit';
import type { FitProfile, JobReq, TaxonomyField } from '../src/lib/matchFit';

// Synthetic requirements only — the matcher is pure, so nothing here touches
// the snapshot. Row order is meaningful (the real input is jobs.json order,
// postedDate desc), so tests state it explicitly.
//
// Qualification ordinals, per QUAL_LEVELS: matric 0, certificate 1, diploma 2,
// degree 3, postgrad 4.
const MATRIC = 0;
const DIPLOMA = 2;
const DEGREE = 3;
const POSTGRAD = 4;

function profile(
  qualLevel: number,
  fields: string[] = [],
  years: number | null = null,
): FitProfile {
  return { qualLevel, fields, years };
}

/** A JobReq that states nothing, overridden field by field. */
function req(partial: Partial<JobReq> = {}): JobReq {
  return { minQual: null, minNqf: null, fields: [], minYears: null, ...partial };
}

function bucketOf(user: FitProfile, r: JobReq | undefined): string {
  return matchJob(user, r).bucket;
}

function scoreOf(user: FitProfile, r: JobReq | undefined): number {
  return matchJob(user, r).score;
}

describe('REQUIREMENTS_DATA_URL', () => {
  it('is same-origin, so the page needs no CSP change', () => {
    expect(REQUIREMENTS_DATA_URL).toBe('/data/requirements.json');
  });
});

describe('matchJob buckets', () => {
  it('is strong when the level is cleared and a field matches', () => {
    const user = profile(DEGREE, ['finance']);
    expect(bucketOf(user, req({ minQual: DEGREE, fields: ['finance'] }))).toBe('strong');
  });

  it('is strong when overqualified and a field still matches', () => {
    const user = profile(POSTGRAD, ['accounting']);
    expect(bucketOf(user, req({ minQual: MATRIC, fields: ['accounting'] }))).toBe('strong');
  });

  it('is possible when the level is cleared but no field matches', () => {
    const user = profile(DEGREE, ['finance']);
    expect(bucketOf(user, req({ minQual: DEGREE, fields: ['it'] }))).toBe('possible');
  });

  it('is possible when the ad states a level and no field at all', () => {
    expect(bucketOf(profile(DEGREE, ['finance']), req({ minQual: DIPLOMA }))).toBe('possible');
  });

  it('is possible when the level is unstated but the ad stated something else', () => {
    // An ad that only states experience is not evidence against anyone.
    expect(bucketOf(profile(MATRIC), req({ minYears: 2 }))).toBe('possible');
    expect(bucketOf(profile(MATRIC), req({ minNqf: 6 }))).toBe('possible');
    expect(bucketOf(profile(MATRIC), req({ fields: ['it'] }))).toBe('possible');
  });

  it('is strong when the level is unstated and a field matches', () => {
    expect(bucketOf(profile(MATRIC, ['it']), req({ fields: ['it'] }))).toBe('strong');
  });

  it('is stretch when the ad asks for exactly one level more', () => {
    expect(bucketOf(profile(DIPLOMA), req({ minQual: DEGREE }))).toBe('stretch');
  });

  it('stays stretch even when the field matches — a field cannot buy a level', () => {
    const user = profile(DIPLOMA, ['finance']);
    expect(bucketOf(user, req({ minQual: DEGREE, fields: ['finance'] }))).toBe('stretch');
  });

  it('does not call a BCom Finance graduate a strong fit for a cyber security engineer', () => {
    // The regression pin for the reported bug. The requirements below are what
    // rules v2 extracts from Capitec's Cyber Security Engineer ad; under v1 the
    // ad also carried a spurious 'business-commerce', which "Bcom finance"
    // matched, putting an IT role at the top of a finance graduate's strong
    // list. Level cleared, no field in common, years short: possible.
    const user = profile(DEGREE, ['finance', 'business-commerce'], 5);
    expect(
      bucketOf(user, req({ minQual: DEGREE, fields: ['it', 'engineering'], minYears: 2 })),
    ).toBe('possible');
  });

  it('is above when the ad asks for two or more levels more', () => {
    expect(bucketOf(profile(MATRIC), req({ minQual: DIPLOMA }))).toBe('above');
    expect(bucketOf(profile(DIPLOMA), req({ minQual: POSTGRAD }))).toBe('above');
    // Not even a field match rescues it — two levels is two levels.
    const user = profile(MATRIC, ['finance']);
    expect(bucketOf(user, req({ minQual: POSTGRAD, fields: ['finance'] }))).toBe('above');
  });
});

describe('matchJob unscored', () => {
  it('is unscored when there is no entry for the job at all', () => {
    expect(matchJob(profile(DEGREE, ['finance']), undefined)).toEqual({
      bucket: 'unscored',
      score: 0,
    });
  });

  it('is unscored when the ad stated nothing extractable', () => {
    expect(matchJob(profile(DEGREE, ['finance']), req())).toEqual({ bucket: 'unscored', score: 0 });
  });

  it('is unscored for every profile, not just weak ones — it is a data gap, not a verdict', () => {
    for (const level of [MATRIC, DIPLOMA, DEGREE, POSTGRAD]) {
      expect(bucketOf(profile(level, ['finance', 'it'], 10), req())).toBe('unscored');
    }
  });

  it('is NOT unscored when any single field of the requirements is stated', () => {
    expect(bucketOf(profile(DEGREE), req({ minQual: DEGREE }))).not.toBe('unscored');
    expect(bucketOf(profile(DEGREE), req({ minNqf: 7 }))).not.toBe('unscored');
    expect(bucketOf(profile(DEGREE), req({ fields: ['law'] }))).not.toBe('unscored');
    expect(bucketOf(profile(DEGREE), req({ minYears: 3 }))).not.toBe('unscored');
  });
});

describe('matchJob experience demotion', () => {
  it('demotes strong to possible', () => {
    const user = profile(DEGREE, ['finance'], 1);
    expect(bucketOf(user, req({ minQual: DEGREE, fields: ['finance'], minYears: 5 }))).toBe(
      'possible',
    );
  });

  it('demotes possible to stretch', () => {
    const user = profile(DEGREE, [], 1);
    expect(bucketOf(user, req({ minQual: DEGREE, minYears: 5 }))).toBe('stretch');
  });

  it('leaves stretch as stretch — one rung down, and stretch is the floor', () => {
    const user = profile(DIPLOMA, [], 1);
    expect(bucketOf(user, req({ minQual: DEGREE, minYears: 5 }))).toBe('stretch');
  });

  it('never demotes a listed row out of sight into above', () => {
    // Two levels short AND short on years: still counted as above, not deleted
    // twice over — 'above' is reached by level alone.
    const user = profile(MATRIC, [], 0);
    expect(bucketOf(user, req({ minQual: DEGREE, minYears: 5 }))).toBe('above');
  });

  it('does not demote when the visitor did not say ("not saying" is not zero)', () => {
    const user = profile(DEGREE, ['finance'], null);
    expect(bucketOf(user, req({ minQual: DEGREE, fields: ['finance'], minYears: 5 }))).toBe(
      'strong',
    );
  });

  it('does not demote when the ad did not state years', () => {
    const user = profile(DEGREE, ['finance'], 0);
    expect(bucketOf(user, req({ minQual: DEGREE, fields: ['finance'] }))).toBe('strong');
  });

  it('does not demote when the years are met exactly', () => {
    const user = profile(DEGREE, ['finance'], 5);
    expect(bucketOf(user, req({ minQual: DEGREE, fields: ['finance'], minYears: 5 }))).toBe(
      'strong',
    );
  });
});

describe('matchJob score', () => {
  it('adds up field, right-level, level-ok and experience', () => {
    const user = profile(DEGREE, ['finance'], 5);
    expect(scoreOf(user, req({ minQual: DEGREE, fields: ['finance'], minYears: 5 }))).toBe(8);
  });

  it('counts one level of overqualification as right-level', () => {
    expect(scoreOf(profile(DEGREE), req({ minQual: DIPLOMA }))).toBe(3);
    expect(scoreOf(profile(DEGREE), req({ minQual: DEGREE }))).toBe(3);
  });

  it('gives overqualified-by-two only the level-ok point', () => {
    expect(scoreOf(profile(DEGREE), req({ minQual: MATRIC }))).toBe(1);
    expect(scoreOf(profile(POSTGRAD), req({ minQual: MATRIC }))).toBe(1);
  });

  it('treats an unstated level like overqualified — absence of a bar, not a good fit', () => {
    expect(scoreOf(profile(DEGREE), req({ minYears: 2 }))).toBe(1);
  });

  it('scores a stretch row on field and experience only', () => {
    const user = profile(DIPLOMA, ['finance'], 6);
    expect(scoreOf(user, req({ minQual: DEGREE, fields: ['finance'], minYears: 5 }))).toBe(5);
  });

  it('gives an unscored row a zero', () => {
    expect(scoreOf(profile(POSTGRAD, ['finance'], 10), req())).toBe(0);
  });

  it('does not award experience when only one side stated it', () => {
    expect(scoreOf(profile(DEGREE, [], null), req({ minQual: DEGREE, minYears: 3 }))).toBe(3);
    expect(scoreOf(profile(DEGREE, [], 9), req({ minQual: DEGREE }))).toBe(3);
  });
});

describe('bucketJobs', () => {
  const job = (id: string) => ({ id });

  it('sorts every row into exactly one bucket and counts the rest', () => {
    const user = profile(DIPLOMA, ['finance']);
    const rows = [
      job('strong'),
      job('possible'),
      job('stretch'),
      job('above'),
      job('unscored'),
      job('missing'),
    ];
    const reqs: Record<string, JobReq> = {
      strong: req({ minQual: DIPLOMA, fields: ['finance'] }),
      possible: req({ minQual: DIPLOMA, fields: ['it'] }),
      stretch: req({ minQual: DEGREE }),
      above: req({ minQual: POSTGRAD }),
      unscored: req(),
    };

    const out = bucketJobs(user, rows, reqs);
    expect(out.strong.map((r) => r.id)).toEqual(['strong']);
    expect(out.possible.map((r) => r.id)).toEqual(['possible']);
    expect(out.stretch.map((r) => r.id)).toEqual(['stretch']);
    expect(out.unscored.map((r) => r.id)).toEqual(['unscored', 'missing']);
    expect(out.aboveCount).toBe(1);
  });

  it('counts every above row and lists none of them', () => {
    const user = profile(MATRIC);
    const rows = [job('a'), job('b'), job('c')];
    const reqs: Record<string, JobReq> = {
      a: req({ minQual: DIPLOMA }),
      b: req({ minQual: DEGREE }),
      c: req({ minQual: POSTGRAD }),
    };
    const out = bucketJobs(user, rows, reqs);
    expect(out.aboveCount).toBe(3);
    expect([...out.strong, ...out.possible, ...out.stretch, ...out.unscored]).toEqual([]);
  });

  it('ranks overqualified-by-two BELOW a right-level row in the same bucket', () => {
    // Deliberately worst-first in input order, so passing proves the score beat
    // position rather than agreeing with it.
    const user = profile(POSTGRAD);
    const rows = [job('over'), job('right')];
    const reqs: Record<string, JobReq> = {
      over: req({ minQual: MATRIC }),
      right: req({ minQual: DEGREE }),
    };
    const out = bucketJobs(user, rows, reqs);
    expect(out.possible.map((r) => r.id)).toEqual(['right', 'over']);
  });

  it('ranks a field match above a right-level-only row', () => {
    const user = profile(DEGREE, ['it']);
    const rows = [job('levelOnly'), job('field')];
    const reqs: Record<string, JobReq> = {
      levelOnly: req({ minQual: DEGREE }),
      field: req({ minQual: MATRIC, fields: ['it'] }),
    };
    const out = bucketJobs(user, rows, reqs);
    expect(out.strong.map((r) => r.id)).toEqual(['field']);
    expect(out.possible.map((r) => r.id)).toEqual(['levelOnly']);
  });

  it('keeps input order for equal scores — the freshest of two identical fits wins', () => {
    const user = profile(DEGREE, ['finance']);
    const rows = [job('newest'), job('middle'), job('oldest')];
    const same = req({ minQual: DEGREE, fields: ['finance'] });
    const reqs: Record<string, JobReq> = { newest: same, middle: same, oldest: same };
    expect(bucketJobs(user, rows, reqs).strong.map((r) => r.id)).toEqual([
      'newest',
      'middle',
      'oldest',
    ]);
  });

  it('is deterministic: the same inputs produce identical lists', () => {
    const user = profile(DEGREE, ['finance'], 3);
    const rows = Array.from({ length: 20 }, (_, i) => job(`job-${i}`));
    const reqs: Record<string, JobReq> = {};
    for (const [i, row] of rows.entries()) {
      reqs[row.id] = req({ minQual: i % 5, fields: i % 2 === 0 ? ['finance'] : [], minYears: i });
    }
    const first = bucketJobs(user, rows, reqs);
    const second = bucketJobs(user, rows, reqs);
    expect(second).toEqual(first);
  });

  it('does not mutate or reorder the rows it was given', () => {
    const user = profile(POSTGRAD);
    const rows = [job('over'), job('right')];
    const before = rows.map((r) => r.id);
    const reqs: Record<string, JobReq> = {
      over: req({ minQual: MATRIC }),
      right: req({ minQual: POSTGRAD }),
    };
    bucketJobs(user, rows, reqs);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it('returns four empty lists and a zero count for no rows', () => {
    expect(bucketJobs(profile(DEGREE), [], {})).toEqual({
      strong: [],
      possible: [],
      stretch: [],
      unscored: [],
      aboveCount: 0,
    });
  });
});

// The real shipped taxonomy, not a hand-rolled one: parseQualName is only
// interesting against the keyword list that actually indexes the jobs.
const TAXONOMY: TaxonomyField[] = REQUIREMENT_FIELD_RULES.map((rule) => ({
  field: rule.field,
  label: rule.label,
  keywords: [...rule.keywords],
}));

describe('parseQualName', () => {
  it('reads both fields out of "BCom Accounting"', () => {
    const fields = parseQualName('BCom Accounting', TAXONOMY);
    expect(fields).toContain('business-commerce');
    expect(fields).toContain('accounting');
    expect(fields).toHaveLength(2);
  });

  it('reads the it field out of the three ways people type an IT qualification', () => {
    // Rules v2 replaced the bare 'IT' keyword (which matched the English
    // pronoun) with phrase keywords. Typed input must still reach the it field:
    // 'bsc it' catches the first, 'in it' the second, 'information technology'
    // the third.
    expect(parseQualName('BSc IT', TAXONOMY)).toContain('it');
    expect(parseQualName('Diploma in IT', TAXONOMY)).toContain('it');
    expect(parseQualName('National Diploma: Information Technology', TAXONOMY)).toContain('it');
  });

  it('is case- and spacing-insensitive', () => {
    expect(parseQualName('bcom   ACCOUNTING', TAXONOMY)).toEqual(
      parseQualName('BCom Accounting', TAXONOMY),
    );
  });

  it('contributes FIELDS ONLY — a qualification level in the text is ignored', () => {
    // The select stays authoritative about how far someone studied.
    expect(parseQualName('National Diploma', TAXONOMY)).toEqual([]);
    expect(parseQualName('Matric', TAXONOMY)).toEqual([]);
    expect(parseQualName('Honours', TAXONOMY)).toEqual([]);
  });

  it('is empty for empty, blank and unrecognised text', () => {
    expect(parseQualName('', TAXONOMY)).toEqual([]);
    expect(parseQualName('   ', TAXONOMY)).toEqual([]);
    expect(parseQualName('N4 boilermaking', TAXONOMY)).toEqual([]);
  });

  it('returns each field once, in taxonomy order', () => {
    // 'accounting' and 'auditing' both index the accounting field.
    expect(parseQualName('BCom Accounting and Auditing', TAXONOMY)).toEqual([
      'accounting',
      'business-commerce',
    ]);
  });

  it('respects the same word boundaries the extractor uses', () => {
    expect(parseQualName('digital banking diploma', TAXONOMY)).not.toContain('it');
    expect(parseQualName('ITIL certification', TAXONOMY)).not.toContain('it');
    expect(parseQualName('database administration', TAXONOMY)).toEqual([]);
  });

  it('handles regex metacharacters in keywords ("ca(sa)")', () => {
    expect(parseQualName('CA(SA)', TAXONOMY)).toContain('accounting');
  });
});

// The drift guard for matchFit.ts's local copy of core's keyword compiler. Not
// a spot check: EVERY keyword in the shipped taxonomy is run against every line
// of a corpus assembled out of the exact confusions the alphanumeric
// lookarounds exist to prevent.
const CORPUS: readonly string[] = [
  '',
  '   ',
  'IT department',
  'digital banking',
  'ITIL certified',
  'internal audit',
  'auditing',
  'audit',
  'AUDIT',
  'internship programme',
  'b com graduate',
  'bcom',
  'BCom  Accounting',
  'business  administration  degree',
  'risk  management  diploma',
  'CA(SA) or CIMA',
  'a degree in law is a bonus, flawless attention to detail',
  'BA in Communications',
  'database administration',
  'National Diploma: Information  Technology',
  'actuarial science / statistics',
  'taxation and tax',
  'people management and generic management',
  'financial management, treasury or investments',
  'B.Sc (Hons) Computer Science; NQF 8',
  '  leading  and  trailing  whitespace  ',
  'informatics|computing^software development',
  'access control and identity management',
  'the people who make it happen',
  'no keywords at all in this sentence',
];

describe('keyword compiler parity with @bankjobs/core', () => {
  it('agrees with keywordToRegex for every taxonomy keyword on every corpus line', () => {
    const mismatches: string[] = [];
    let matched = 0;
    let unmatched = 0;

    for (const rule of REQUIREMENT_FIELD_RULES) {
      for (const keyword of rule.keywords) {
        // A one-field taxonomy turns parseQualName into a probe of the single
        // keyword, so the parity claim is made about the SHIPPED code path
        // rather than about an export added for the test's convenience.
        const solo: TaxonomyField[] = [{ field: 'probe', label: 'probe', keywords: [keyword] }];
        for (const text of CORPUS) {
          const local = parseQualName(text, solo).length > 0;
          const core = keywordToRegex(keyword).test(text);
          if (local !== core) {
            mismatches.push(
              `${rule.field}/${keyword} on ${JSON.stringify(text)}: ${local}≠${core}`,
            );
          }
          if (core) matched += 1;
          else unmatched += 1;
        }
      }
    }

    expect(mismatches).toEqual([]);
    // The corpus must actually exercise both answers, or the parity assertion
    // above would pass on a corpus that matches nothing.
    expect(matched).toBeGreaterThan(0);
    expect(unmatched).toBeGreaterThan(0);
  });

  it('pins the boundary cases the parity sweep is built around', () => {
    const probe = (keyword: string, text: string): boolean =>
      parseQualName(text, [{ field: 'probe', label: 'probe', keywords: [keyword] }]).length > 0;

    expect(probe('IT', 'IT department')).toBe(true);
    expect(probe('IT', 'digital banking')).toBe(false);
    expect(probe('IT', 'ITIL certified')).toBe(false);
    expect(probe('audit', 'internal audit')).toBe(true);
    expect(probe('audit', 'auditing')).toBe(false);
    expect(probe('auditing', 'internal audit')).toBe(false);
    expect(probe('internal audit', 'internal audit')).toBe(true);
    expect(probe('b com', 'b com graduate')).toBe(true);
    expect(probe('b com', 'bcom')).toBe(false);
    expect(probe('bcom', 'b com graduate')).toBe(false);
    expect(probe('business administration', 'business  administration  degree')).toBe(true);
    expect(probe('ca(sa)', 'CA(SA) or CIMA')).toBe(true);
    expect(probe('law', 'flawless attention to detail')).toBe(false);

    // The rules-v2 replacements. 'IT' above still describes the compiler
    // correctly — it just is not a taxonomy keyword any more, because a
    // two-letter word cannot tell a degree from a pronoun.
    expect(probe('in it', 'BSc in IT')).toBe(true);
    expect(probe('in it', 'the people who make it happen')).toBe(false);
    expect(probe('management studies', 'business, commerce and management studies')).toBe(true);
    expect(probe('bsc it', 'Preferred Qualification BSc IT or BComm IT')).toBe(true);
  });
});
