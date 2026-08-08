// Cross-language parity fixture for JobsKit's Swift port of the fit matcher.
//
// Emits ios/JobsKit/Tests/JobsKitTests/Fixtures/fit-parity.json by running the
// site's ACTUAL matchFit.ts (and core's keywordToRegex) over the same
// requirements/jobs fixtures the Swift tests decode. The Swift suite then
// asserts KeywordRegex/FitMatcher reproduce every answer byte for byte — the
// same drift-guard idea as site/test/matchFit.test.ts's compiler parity sweep,
// stretched across the language boundary instead of across two files.
//
// Regenerate (from the repo root — tsx is a root devDependency):
//
//     pnpm exec tsx ios/tools/emit-fit-parity.mts
//
// Deterministic by construction: fixture order in, JSON.stringify out, no
// clock, no sampling. Rerunning against unchanged fixtures rewrites an
// identical file.
//
// compileKeyword is not exported from matchFit.ts, so keyword results are read
// through a one-field parseQualName probe — the exact trick the site's own
// parity test uses, which also means the SHIPPED code path is what gets pinned.
// The script cross-checks every probe answer against core's keywordToRegex and
// refuses to emit on any disagreement, so the fixture can never encode a drift
// between the two TypeScript compilers as "truth".

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bucketJobs, matchJob, parseQualName } from '../../site/src/lib/matchFit.ts';
import type { FitProfile, JobReq, TaxonomyField } from '../../site/src/lib/matchFit.ts';
import { keywordToRegex } from '../../packages/core/src/keywords.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'JobsKit', 'Tests', 'JobsKitTests', 'Fixtures');

interface RequirementsSnapshot {
  version: number;
  generatedAt: string;
  taxonomy: TaxonomyField[];
  jobs: Record<string, JobReq>;
}

interface LeanRow {
  id: string;
  country: string;
}

const requirements = JSON.parse(
  readFileSync(join(fixturesDir, 'requirements.json'), 'utf8'),
) as RequirementsSnapshot;
const jobs = JSON.parse(readFileSync(join(fixturesDir, 'jobs.json'), 'utf8')) as LeanRow[];

// ---- 1. keyword compiler: every taxonomy keyword × the boundary corpus ------
// The corpus is site/test/matchFit.test.ts's, plus the extra confusions the
// Swift port must not reintroduce (curly vs straight apostrophes, bare 'ITIL',
// 'bachelor's degree') — and each keyword is also run against itself.
const CORPUS: readonly string[] = [
  '',
  '   ',
  'IT department',
  'digital banking',
  'ITIL',
  'ITIL certified',
  'internal audit',
  'auditing',
  'audit',
  'AUDIT',
  'internship programme',
  'b com graduate',
  'bcom',
  'BCom  Accounting',
  "bachelor's degree",
  'bachelor’s degree',
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

function probe(keyword: string, text: string): boolean {
  const solo: TaxonomyField[] = [{ field: 'probe', label: 'probe', keywords: [keyword] }];
  return parseQualName(text, solo).length > 0;
}

const mismatches: string[] = [];
const keywordCases: Array<{ keyword: string; cases: Array<{ t: string; m: boolean }> }> = [];
for (const rule of requirements.taxonomy) {
  for (const keyword of rule.keywords) {
    const texts = [...CORPUS, keyword];
    const cases = texts.map((t) => {
      const local = probe(keyword, t);
      const core = keywordToRegex(keyword).test(t);
      if (local !== core) mismatches.push(`${keyword} on ${JSON.stringify(t)}: ${local}≠${core}`);
      return { t, m: core };
    });
    keywordCases.push({ keyword, cases });
  }
}
if (mismatches.length > 0) {
  console.error('matchFit.ts and core keywords.ts disagree — fixture NOT written:');
  for (const line of mismatches) console.error('  ' + line);
  process.exit(1);
}

// ---- 2. parseQualName over realistic free-text qualification names ----------
const QUAL_NAMES: readonly string[] = [
  'BCom Accounting',
  'National Diploma in IT',
  'matric',
  'BSc Computer Science',
  'LLB',
  'BEng Mechanical Engineering',
  'Higher Certificate in Banking',
  'BCom Marketing Management',
  'CA(SA)',
  'Bachelor of Laws',
  'Diploma: Risk Management',
  'Actuarial Science Honours',
  'National Diploma: Information Technology',
  'B.Sc (Hons) Computer Science; NQF 8',
  'bachelor’s degree in economics',
  'BCom Accounting and Auditing',
  '',
];
const parseQualNameCases = QUAL_NAMES.map((input) => ({
  input,
  fields: parseQualName(input, requirements.taxonomy),
}));

// ---- 3. matchJob over a profile × requirement grid --------------------------
// The cross product covers every ladder branch: unscored (missing entry and
// all-null), possible-via-null-level, strong, stretch, above, the experience
// demotions (strong→possible, possible→stretch, stretch floor) and both sides
// of "not saying is not zero".
const PROFILES: readonly FitProfile[] = [
  { qualLevel: 0, fields: [], years: null },
  { qualLevel: 0, fields: ['finance'], years: 0 },
  { qualLevel: 2, fields: ['it'], years: 1 },
  { qualLevel: 3, fields: ['accounting', 'business-commerce'], years: 2 },
  { qualLevel: 3, fields: [], years: null },
  { qualLevel: 4, fields: ['it'], years: 10 },
  { qualLevel: 1, fields: ['law'], years: 3 },
];

const REQS: ReadonlyArray<JobReq | null> = [
  null, // no entry at all
  { minQual: null, minNqf: null, fields: [], minYears: null },
  { minQual: null, minNqf: 6, fields: [], minYears: null },
  { minQual: null, minNqf: null, fields: ['it'], minYears: null },
  { minQual: null, minNqf: null, fields: [], minYears: 2 },
  { minQual: 0, minNqf: null, fields: [], minYears: null },
  { minQual: 1, minNqf: null, fields: ['finance'], minYears: null },
  { minQual: 2, minNqf: null, fields: [], minYears: 5 },
  { minQual: 3, minNqf: null, fields: ['accounting'], minYears: 5 },
  { minQual: 3, minNqf: null, fields: ['it', 'engineering'], minYears: 2 },
  { minQual: 4, minNqf: null, fields: [], minYears: null },
  { minQual: 4, minNqf: null, fields: ['law'], minYears: null },
  { minQual: 2, minNqf: null, fields: ['finance'], minYears: null },
  { minQual: 1, minNqf: null, fields: [], minYears: 1 },
  { minQual: null, minNqf: null, fields: ['accounting'], minYears: 3 },
];

const matchJobCases = PROFILES.flatMap((profile) =>
  REQS.map((req) => {
    const { bucket, score } = matchJob(profile, req ?? undefined);
    return { profile, req, bucket, score };
  }),
);

// ---- 4. bucketJobs over the full jobs fixture -------------------------------
// The pool is the SAME country scope the /fit/ island uses by default (ZA
// only), in fixture order — jobs.json is already postedDate desc.
const BUCKET_PROFILES: readonly FitProfile[] = [
  { qualLevel: 3, fields: ['accounting'], years: 2 },
  { qualLevel: 0, fields: [], years: null },
  { qualLevel: 4, fields: ['it', 'engineering'], years: 10 },
];

const pool = jobs.filter((row) => row.country === 'ZA');
const bucketJobsCases = BUCKET_PROFILES.map((profile) => {
  const out = bucketJobs(profile, pool, requirements.jobs);
  return {
    profile,
    strong: out.strong.map((r) => r.id),
    possible: out.possible.map((r) => r.id),
    stretch: out.stretch.map((r) => r.id),
    unscored: out.unscored.map((r) => r.id),
    aboveCount: out.aboveCount,
  };
});

const payload = {
  generator: 'ios/tools/emit-fit-parity.mts',
  rulesVersion: requirements.version,
  keywords: keywordCases,
  parseQualName: parseQualNameCases,
  matchJob: matchJobCases,
  bucketJobs: bucketJobsCases,
};

const outPath = join(fixturesDir, 'fit-parity.json');
writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log(
  `wrote ${outPath}: ${keywordCases.length} keywords × ${CORPUS.length + 1} texts, ` +
    `${parseQualNameCases.length} names, ${matchJobCases.length} matchJob cases, ` +
    `${bucketJobsCases.length} bucketJobs runs over ${pool.length} ZA rows`,
);
