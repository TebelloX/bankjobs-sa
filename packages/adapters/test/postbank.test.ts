import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CATEGORIES, QUAL_LEVELS, extractRequirements } from '@bankjobs/core';

import { POSTBANK_SITE_CONFIG, postbankAdapter } from '../src/index';
import {
  advertHtmlFromPdf,
  extractPdfLines,
  fetchAllPostbank,
  parseClosingDate,
  parseVacancies,
  partitionByClosingDate,
  resolveAdvertUrl,
  sastDate,
} from '../src/index';
import type { PostbankRawPosting, PostbankVacancy } from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (committed careers.html + advert PDFs, loaded offline — never the
// network). careers.html is the verbatim listing: 64 rows on capture day, of
// which 2 were still open. Four adverts are committed — both open ones (what an
// offline ingest run replays) and two long-expired frontline ones, kept so the
// closing-date filter has real negatives.
//
// The whole file is pinned to the capture date. Every Postbank advert expires
// within weeks, so a test judged against "today" would go red on a green tree
// the moment the last open ad closed.
// ---------------------------------------------------------------------------

const fixturesDir = new URL('../../../fixtures/postbank/', import.meta.url);
const LIST_URL = 'https://www.postbank.co.za/careers.html';

function readFixture(name: string): string {
  return readFileSync(new URL(name, fixturesDir), 'utf8');
}

function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, fixturesDir)));
}

const manifest = JSON.parse(readFixture('manifest.json')) as {
  capturedAt: string;
  totalAtCapture: number;
  openAtCapture: number;
};

const CAPTURED_AT = new Date(manifest.capturedAt);
const CAPTURE_DAY = sastDate(CAPTURED_AT);

const careersHtml = readFixture('careers.html');
const vacancies = parseVacancies(careersHtml, LIST_URL);
const partition = partitionByClosingDate(vacancies, CAPTURE_DAY);

const OPEN_SLUGS = ['advert-specialist-architect-2026', 'advert-sap-grc-specialist-2026'];
const EXPIRED_SLUGS = [
  'advert-customer-services-clerk-western-cape',
  'advert-team-lead-customer-services-western-cape',
];

function vacancyFor(slug: string): PostbankVacancy {
  const v = vacancies.find((x) => x.slug === slug);
  if (!v) throw new Error(`No committed vacancy row for ${slug}`);
  return v;
}

/** Pair a committed row with its committed advert, as the ingest loader does. */
async function rawFor(slug: string): Promise<PostbankRawPosting> {
  return {
    vacancy: vacancyFor(slug),
    advertHtml: await advertHtmlFromPdf(readFixtureBytes(`${slug}.pdf`)),
  };
}

const raws = new Map<string, PostbankRawPosting>();
for (const slug of [...OPEN_SLUGS, ...EXPIRED_SLUGS]) {
  raws.set(slug, await rawFor(slug));
}

function rawOf(slug: string): PostbankRawPosting {
  const raw = raws.get(slug);
  if (!raw) throw new Error(`No committed advert for ${slug}`);
  return raw;
}

function jobFor(slug: string): ReturnType<typeof postbankAdapter.normalize> {
  return postbankAdapter.normalize(rawOf(slug));
}

// ---------------------------------------------------------------------------
// (a) Careers-table parsing — over the committed listing.
// ---------------------------------------------------------------------------

describe('postbank careers table parser', () => {
  it('parses every vacancy row (count matches the manifest)', () => {
    expect(vacancies.length).toBe(manifest.totalAtCapture);
    expect(vacancies.length).toBe(64);
    for (const v of vacancies) {
      expect(v.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(v.title.length).toBeGreaterThan(0);
      expect(v.pdfUrl.startsWith('https://www.postbank.co.za/vacancies/')).toBe(true);
    }
  });

  it('skips the banner and header rows without special-casing their position', () => {
    // The banner row is a single colspan="3" cell carrying the scam warning and
    // a 'Consent forms' PDF link — a PDF anchor that must NOT become a vacancy.
    expect(careersHtml).toContain('Consent-forms.pdf');
    expect(vacancies.some((v) => v.slug.includes('consent'))).toBe(false);
    // The Position / Location / Closing Date header row has three cells but no
    // anchor.
    expect(vacancies.some((v) => v.title === 'Position')).toBe(false);
  });

  it('reads title, location and closing date out of the three cells', () => {
    const v = vacancyFor('advert-specialist-architect-2026');
    expect(v.title).toBe('SPECIALIST ARCHITECT');
    expect(v.rawLocation).toBe('PRETORIA');
    expect(v.closingDateRaw).toBe('03 August 2026');
    expect(v.closingDate).toBe('2026-08-03');
  });

  it('ignores a three-cell row whose first cell links something other than a PDF', () => {
    const html =
      '<table><tr><td><p><a class="myLink" href="vacancies\\Advert_Real 2026.pdf">REAL</a></p></td>' +
      '<td><p>PRETORIA</p></td><td><p>03 August 2026</p></td></tr>' +
      '<tr><td><a href="/contact.html">Contact us</a></td><td>x</td><td>y</td></tr></table>';
    expect(parseVacancies(html, LIST_URL).map((v) => v.slug)).toEqual(['advert-real-2026']);
  });

  it('decodes &nbsp; out of the cells (the only entity the page uses)', () => {
    const html =
      '<table><tr><td><a href="vacancies\\Advert_X.pdf">SENIOR&nbsp;CLERK</a></td>' +
      '<td>WESTERN&nbsp;CAPE</td><td>03&nbsp;August 2026</td></tr></table>';
    const [v] = parseVacancies(html, LIST_URL);
    expect(v?.title).toBe('SENIOR CLERK');
    expect(v?.rawLocation).toBe('WESTERN CAPE');
    expect(v?.closingDate).toBe('2026-08-03');
  });
});

// ---------------------------------------------------------------------------
// (b) The href quirks. Every href on this page is a WINDOWS path with raw
// spaces; some carry en-dashes, ampersands, double spaces and a stray space
// after 'Advert'. All of it has to resolve to a fetchable https URL.
// ---------------------------------------------------------------------------

describe('postbank advert URL resolution', () => {
  it('turns backslashes into path separators and percent-encodes the spaces', () => {
    expect(resolveAdvertUrl('vacancies\\Advert_Specialist Architect 2026.pdf', LIST_URL)).toBe(
      'https://www.postbank.co.za/vacancies/Advert_Specialist%20Architect%202026.pdf',
    );
  });

  it('encodes en-dashes, and leaves ampersands as the legal path characters they are', () => {
    expect(
      resolveAdvertUrl(
        'vacancies\\Advert_Payments and Interbank Analyst – Electronic Payments 2026.pdf',
        LIST_URL,
      ),
    ).toBe(
      'https://www.postbank.co.za/vacancies/Advert_Payments%20and%20Interbank%20Analyst%20%E2%80%93%20Electronic%20Payments%202026.pdf',
    );
    expect(resolveAdvertUrl('vacancies\\Advert_IT Assets & Risk Officer 2026.pdf', LIST_URL)).toBe(
      'https://www.postbank.co.za/vacancies/Advert_IT%20Assets%20&%20Risk%20Officer%202026.pdf',
    );
  });

  it('resolves the real quirky rows on the committed page, every one to https', () => {
    // 'Advert _Team Lead …' (stray space) and 'Advert  Team Lead …' (double
    // space) are both real rows, and both are committed as fetched fixtures.
    expect(vacancyFor('advert-team-lead-customer-services-western-cape').pdfUrl).toBe(
      'https://www.postbank.co.za/vacancies/Advert%20_Team%20Lead%20Customer%20Services%20Western%20Cape.pdf',
    );
    for (const v of vacancies) {
      expect(() => new URL(v.pdfUrl)).not.toThrow();
      expect(new URL(v.pdfUrl).protocol).toBe('https:');
      expect(v.pdfUrl).not.toContain('\\');
      expect(v.pdfUrl).not.toContain(' ');
    }
  });
});

// ---------------------------------------------------------------------------
// (c) The closing-date filter — the load-bearing logic of this adapter, because
// Postbank never removes a closed advert.
// ---------------------------------------------------------------------------

describe('postbank closing-date filter', () => {
  it('parses the printed date format', () => {
    expect(parseClosingDate('03 August 2026')).toBe('2026-08-03');
    expect(parseClosingDate('3 August 2026')).toBe('2026-08-03');
    expect(parseClosingDate(' 25 December 2026 ')).toBe('2026-12-25');
  });

  it('returns null rather than guessing at anything it cannot read', () => {
    expect(parseClosingDate('')).toBeNull();
    expect(parseClosingDate('TBC')).toBeNull();
    expect(parseClosingDate('2026-08-03')).toBeNull();
    expect(parseClosingDate('03 Augustus 2026')).toBeNull();
    // A date that does not exist is not a date.
    expect(parseClosingDate('31 February 2026')).toBeNull();
    expect(parseClosingDate('00 August 2026')).toBeNull();
  });

  it('reads today in SAST (UTC+2, no DST) — never in UTC', () => {
    // 22:30 UTC is already tomorrow in Johannesburg.
    expect(sastDate(new Date('2026-07-25T22:30:00.000Z'))).toBe('2026-07-26');
    expect(sastDate(new Date('2026-07-25T21:59:59.000Z'))).toBe('2026-07-25');
    expect(sastDate(new Date('2026-07-25T00:00:00.000Z'))).toBe('2026-07-25');
  });

  it('keeps only the unexpired rows of the committed page', () => {
    expect(partition.open.map((v) => v.slug)).toEqual(OPEN_SLUGS);
    expect(partition.open.length).toBe(manifest.openAtCapture);
    expect(partition.expired.length).toBe(62);
    expect(partition.unparsed.length).toBe(0);
    // The committed expired adverts are on the page and are dropped.
    for (const slug of EXPIRED_SLUGS) {
      expect(partition.expired.some((v) => v.slug === slug)).toBe(true);
      expect(partition.open.some((v) => v.slug === slug)).toBe(false);
    }
  });

  it('keeps a role that closes TODAY and drops it the next day', () => {
    // Both open rows close on 2026-08-03.
    expect(partitionByClosingDate(vacancies, '2026-08-03').open.map((v) => v.slug)).toEqual(
      OPEN_SLUGS,
    );
    expect(partitionByClosingDate(vacancies, '2026-08-04').open).toEqual([]);
  });

  it('drops an unreadable closing date instead of publishing it as open', () => {
    const html =
      '<table>' +
      '<tr><td><a href="vacancies\\Advert_Good.pdf">GOOD</a></td><td>PRETORIA</td><td>03 August 2026</td></tr>' +
      '<tr><td><a href="vacancies\\Advert_Bad.pdf">BAD</a></td><td>PRETORIA</td><td>Until filled</td></tr>' +
      '</table>';
    const rows = parseVacancies(html, LIST_URL);
    const split = partitionByClosingDate(rows, '2026-07-25');
    expect(split.open.map((v) => v.slug)).toEqual(['advert-good']);
    expect(split.unparsed.map((v) => v.closingDateRaw)).toEqual(['Until filled']);
    expect(split.expired).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) The PDF advert. PDF.js emits text in CONTENT-STREAM order, which on these
// floating-text-box adverts hoists every section heading to the top of its page;
// the pdf/ client rebuilds reading order from the item geometry. These tests pin
// that, because it is what keeps 'Minimum Requirements' attached to the block
// core's heading-windowed requirements extractor has to read.
// ---------------------------------------------------------------------------

describe('postbank advert PDF extraction', () => {
  it('restores reading order: headings sit above their own sections', async () => {
    const lines = await extractPdfLines(readFixtureBytes('advert-specialist-architect-2026.pdf'));
    const texts = lines.map((l) => l.text);
    const at = (needle: string): number => texts.findIndex((t) => t.startsWith(needle));

    expect(at('JOB TITLE')).toBeLessThan(at('Purpose of the Job'));
    expect(at('Purpose of the Job')).toBeLessThan(at('As an Architect'));
    expect(at('Job Responsibilities')).toBeLessThan(at('Minimum Requirements'));
    // The heading immediately precedes the qualifications it introduces.
    expect(texts[at('Minimum Requirements') + 1]).toBe('Qualification:');
    expect(texts[at('Minimum Requirements') + 2]).toContain('Bachelor’s degree');
  });

  it('assembles headings, paragraphs and bullet lists, and drops the page furniture', () => {
    const html = rawOf('advert-specialist-architect-2026').advertHtml;
    expect(html).toContain('<h3>Purpose of the Job</h3>');
    expect(html).toContain('<h3>Minimum Requirements</h3>');
    expect(html).toContain('<h3>How to Apply</h3>');
    expect(html).toContain('<li>TOGAF, SABSA, or other architecture framework certifications</li>');
    // Metadata rows stay one paragraph each rather than flowing together.
    expect(html).toContain('<p>LOCATION: HEAD OFFICE: PRETORIA</p>');
    // Page furniture is not content.
    expect(html).not.toContain('Page |');
    expect(html).not.toContain('<p>VACANCY</p>');
    // Bullet glyphs are markup here, not text.
    expect(html).not.toContain('•');
  });

  it('rejoins a bullet wrapped across visual lines into one list item', () => {
    const html = rawOf('advert-team-lead-customer-services-western-cape').advertHtml;
    expect(html).toContain(
      '<li>Attend to all issues raised by staff based at the various distribution points. ' +
        'Escalate issues that cannot be resolved to the Regional Operations Managers</li>',
    );
  });

  it('rejoins a paragraph wrapped across visual lines, breaking only on real gaps', () => {
    const html = rawOf('advert-specialist-architect-2026').advertHtml;
    expect(html).toContain(
      '<p>As an Architect, your role will involve designing, governing, and evolving the IT ' +
        'architecture landscape across the organisation.',
    );
  });

  it('escapes advert text so no PDF content can be read as markup', () => {
    expect(rawOf('advert-specialist-architect-2026').advertHtml).toContain(
      'HEAD: IT INNOVATION &amp; ARCHITECTURE',
    );
  });
});

// ---------------------------------------------------------------------------
// (e) normalize — snapshots (both open adverts plus one expired frontline one,
// which is the only committed example of the province-only location shape).
// ---------------------------------------------------------------------------

describe('postbankAdapter.normalize — snapshots', () => {
  const slugs = [...OPEN_SLUGS, 'advert-customer-services-clerk-western-cape'];
  it.each(slugs.map((s) => [s, s] as const))('normalizes %s', (_slug, slug) => {
    expect(jobFor(slug)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// (f) normalize — invariants over every committed advert.
// ---------------------------------------------------------------------------

describe('postbankAdapter.normalize — invariants', () => {
  const jobs = [...raws.keys()].map((slug) => jobFor(slug));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^postbank:[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(job.source).toBe('postbank');
    expect(job.brand).toBe('Postbank');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');
    // The advert survived as structured content, not one flat blob.
    expect(job.descriptionHtml).toContain('<h3>');
    expect(job.descriptionHtml).toContain('<li>');
    expect(job.descriptionText.length).toBeGreaterThan(1500);

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    // applyUrl is the advert PDF itself — there is no application form.
    expect(job.applyUrl.startsWith('https://www.postbank.co.za/vacancies/')).toBe(true);
    expect(job.applyUrl.endsWith('.pdf')).toBe(true);

    // Nothing on the page or in the advert states a posted date or a schedule.
    expect(job.postedDate).toBeNull();
    expect(job.employmentType).toBeNull();

    // Postbank hires only in South Africa.
    expect(job.country).toBe('ZA');
  });

  it('derives ids from the advert filename, stable across runs and unique', () => {
    expect(jobFor('advert-specialist-architect-2026').id).toBe(
      'postbank:advert-specialist-architect-2026',
    );
    // Re-running the parse over the same page yields byte-identical ids.
    const again = parseVacancies(careersHtml, LIST_URL);
    expect(again.map((v) => v.slug)).toEqual(vacancies.map((v) => v.slug));
    // Every row on the page has its own id — the seven near-duplicate
    // 'CUSTOMER SERVICES CLERK' rows differ only by their PDF.
    expect(new Set(vacancies.map((v) => v.slug)).size).toBe(vacancies.length);
  });

  it('throws AdapterNormalizeError when the advert slug is missing', () => {
    const raw = rawOf('advert-specialist-architect-2026');
    const broken = { ...raw, vacancy: { ...raw.vacancy, slug: '' } };
    expect(() => postbankAdapter.normalize(broken)).toThrow(/normalize failed/);
  });

  it('throws AdapterNormalizeError when the advert URL is missing', () => {
    const raw = rawOf('advert-specialist-architect-2026');
    const broken = { ...raw, vacancy: { ...raw.vacancy, pdfUrl: '' } };
    expect(() => postbankAdapter.normalize(broken)).toThrow(/missing advert URL/);
  });
});

// ---------------------------------------------------------------------------
// (g) normalize — location mapping. Cells are free text in CAPS, several list
// more than one place, and 'HEAD OFFICE' is an internal label the adverts
// themselves expand ('LOCATION : HEAD OFFICE: PRETORIA').
// ---------------------------------------------------------------------------

describe('postbankAdapter.normalize — locations', () => {
  /** Normalize a real row against a stand-in advert (locations ignore the PDF). */
  function locationsOf(slug: string): ReturnType<typeof postbankAdapter.normalize> {
    return postbankAdapter.normalize({ vacancy: vacancyFor(slug), advertHtml: '<p>advert</p>' });
  }

  it('PRETORIA → Pretoria, Gauteng', () => {
    const job = jobFor('advert-specialist-architect-2026');
    expect(job.primaryLocation).toBe('Pretoria, Gauteng');
    expect(job.locations).toEqual([{ city: 'Pretoria', province: 'Gauteng', raw: 'PRETORIA' }]);
  });

  it("resolves 'HEAD OFFICE' and 'Postbank Head Office' to Pretoria", () => {
    for (const slug of [
      'advert-head-fraud-risk-management-2026',
      'advert-senior-data-analyst-2026',
    ]) {
      const job = locationsOf(slug);
      expect(job.primaryLocation).toBe('Pretoria, Gauteng');
      expect(job.locations[0]?.city).toBe('Pretoria');
    }
  });

  it('shows a province-only cell as its canonical province, not the shouted raw', () => {
    const job = jobFor('advert-customer-services-clerk-western-cape');
    expect(job.primaryLocation).toBe('Western Cape');
    expect(job.locations).toEqual([{ city: null, province: 'Western Cape', raw: 'WESTERN CAPE' }]);
  });

  it("splits a backslash cell ('JOHANNESBURG\\BLOEMFONTEIN') into both cities", () => {
    const job = locationsOf('advert-manager-inbound-call-centre-bloemfontein-v1-2026');
    expect(job.locations.map((l) => [l.city, l.province])).toEqual([
      ['Johannesburg', 'Gauteng'],
      ['Bloemfontein', 'Free State'],
    ]);
    expect(job.primaryLocation).toBe('Johannesburg, Gauteng');
  });

  it("splits an 'AND' cell and drops the 'X2' headcount marker", () => {
    const job = locationsOf('re-advertisement-regional-manager-kzn-western-cape-2026');
    expect(job.locations.map((l) => l.province)).toEqual(['Western Cape', 'KwaZulu-Natal']);
    expect(job.locations.map((l) => l.city)).toEqual([null, null]);
  });

  it('splits a six-province list, keeping the advert’s own ordering', () => {
    const job = locationsOf('advert-regional-manager-various-areas-2026');
    expect(job.locations.map((l) => l.province)).toEqual([
      'Western Cape',
      'Northern Cape',
      'KwaZulu-Natal',
      'North West',
      'Mpumalanga',
      'Limpopo',
    ]);
    // Without the split, core's longest-alias scan would pick an arbitrary one.
    expect(job.primaryLocation).toBe('Western Cape');
  });

  it('keeps an unrecognised place as raw text rather than inventing a city', () => {
    const job = locationsOf('re-advertisement-account-administrator-2026');
    expect(job.primaryLocation).toBe('RIVONIA');
    expect(job.locations).toEqual([{ city: null, province: null, raw: 'RIVONIA' }]);
  });
});

// ---------------------------------------------------------------------------
// (h) normalize — categories. Per-source rules exist only where the global ones
// misfile this inventory.
// ---------------------------------------------------------------------------

describe('postbankAdapter.normalize — categories', () => {
  it('routes the frontline in-store roles to Branch & Retail', () => {
    // Global rules put both in 'Other' ('customer service' does not match
    // 'CUSTOMER SERVICES'); the per-source rule is the Capitec 'Bank Better
    // Champion' precedent applied to Postbank's own frontline titles.
    expect(jobFor('advert-customer-services-clerk-western-cape').category).toBe('Branch & Retail');
    expect(jobFor('advert-team-lead-customer-services-western-cape').category).toBe(
      'Branch & Retail',
    );
  });

  it("rescues the IT titles the global 'specialist' rule was swallowing", () => {
    // Both would otherwise land in Operations & Admin.
    expect(jobFor('advert-specialist-architect-2026').category).toBe('Software & IT');
    expect(jobFor('advert-sap-grc-specialist-2026').category).toBe('Software & IT');
  });

  it('leaves the titles the global rules already read correctly alone', () => {
    const raw = rawOf('advert-specialist-architect-2026');
    const categoryOf = (title: string): string =>
      postbankAdapter.normalize({ ...raw, vacancy: { ...raw.vacancy, title } }).category;
    expect(categoryOf('SENIOR DATA ANALYST')).toBe('Data & Analytics');
    expect(categoryOf('MANAGER: COMPLIANCE')).toBe('Risk & Compliance');
    expect(categoryOf('CHIEF FINANCIAL OFFICER')).toBe('Finance & Accounting');
    expect(categoryOf('MANAGER: INBOUND CALL CENTRE')).toBe('Customer Service');
  });
});

// ---------------------------------------------------------------------------
// (i) Requirements extraction. This is why the advert has to survive as
// structured text: /fit/ scores a role from the block that FOLLOWS a
// qualifications heading, and min-taking is the safety property there —
// under-stating shows a user a role they may not get, over-stating hides one
// they qualify for, and only the first is recoverable by the reader.
// ---------------------------------------------------------------------------

describe('postbank adverts feed core requirements extraction', () => {
  it("reads the IT advert's degree / NQF 7 / IT field / 3 years", () => {
    const job = jobFor('advert-specialist-architect-2026');
    const reqs = extractRequirements({
      title: job.title,
      descriptionText: job.descriptionText,
      source: 'postbank',
    });
    expect(reqs.minQual).toBe(QUAL_LEVELS.indexOf('degree'));
    expect(reqs.minNqf).toBe(7);
    expect(reqs.fields).toContain('it');
    // 'Minimum 8 years … / 5 years … / 3 years' → the LOWEST bar stated.
    expect(reqs.minYears).toBe(3);
  });

  it("takes the MINIMUM of the frontline advert's 'Matric essential / NQF 5 preferred'", () => {
    const job = jobFor('advert-customer-services-clerk-western-cape');
    const reqs = extractRequirements({
      title: job.title,
      descriptionText: job.descriptionText,
      source: 'postbank',
    });
    // Matric is essential and NQF 5 only preferred, so the answer is matric.
    expect(reqs.minQual).toBe(QUAL_LEVELS.indexOf('matric'));
    expect(reqs.minNqf).toBe(5);
    expect(reqs.minYears).toBe(2);
    expect(reqs.fields.length).toBeGreaterThan(0);
  });

  it('scores every committed advert (none comes back entirely unread)', () => {
    for (const slug of raws.keys()) {
      const job = jobFor(slug);
      const reqs = extractRequirements({
        title: job.title,
        descriptionText: job.descriptionText,
        source: 'postbank',
      });
      expect(reqs.minQual).not.toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// (j) applyUrl host guard. Postbank's apply URL is BUILT from the careers page's
// own origin, so a hijacked listing cannot move it off-host — but the guard is
// still wired, and this proves it fires.
// ---------------------------------------------------------------------------

describe('postbankAdapter.normalize — applyUrl host guard', () => {
  it('throws when an advert URL is not on the allowlisted host', () => {
    const raw = rawOf('advert-specialist-architect-2026');
    const hijacked = {
      ...raw,
      vacancy: { ...raw.vacancy, pdfUrl: 'https://www.postbank.co.za.evil.example/advert.pdf' },
    };
    expect(() => postbankAdapter.normalize(hijacked)).toThrow(/not allowlisted/);
  });

  it('throws on an http:// downgrade', () => {
    const raw = rawOf('advert-specialist-architect-2026');
    const insecure = {
      ...raw,
      vacancy: { ...raw.vacancy, pdfUrl: 'http://www.postbank.co.za/vacancies/Advert.pdf' },
    };
    expect(() => postbankAdapter.normalize(insecure)).toThrow(/must use https/);
  });
});

// ---------------------------------------------------------------------------
// (k) fetchAll, against a stubbed fetch replaying the committed fixtures. The
// listing is load-bearing; an individual advert is not.
// ---------------------------------------------------------------------------

describe('fetchAllPostbank', () => {
  // The committed page has 2 open rows only on its capture day, so pin the
  // clock. Only Date is faked — sleep() still needs real timers.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(CAPTURED_AT);
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  const TEST_CONFIG = { ...POSTBANK_SITE_CONFIG, delayMs: 0 };

  function stubFetch(overrides: Record<string, number> = {}): typeof fetch {
    return (async (url: string) => {
      if (url === LIST_URL) {
        return { ok: true, status: 200, text: async () => careersHtml } as unknown as Response;
      }
      const slug = OPEN_SLUGS.find((s) => url === vacancyFor(s).pdfUrl);
      if (slug === undefined) return { ok: false, status: 404 } as unknown as Response;
      const status = overrides[slug];
      if (status !== undefined) return { ok: false, status } as unknown as Response;
      const bytes = readFixtureBytes(`${slug}.pdf`);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(0),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it('fetches only the unexpired adverts, and reports the split', async () => {
    const logs: string[] = [];
    const raws = await fetchAllPostbank(TEST_CONFIG, {
      fetchImpl: stubFetch(),
      log: (m) => logs.push(m),
    });

    expect(raws.map((r) => r.vacancy.slug)).toEqual(OPEN_SLUGS);
    expect(logs[0]).toContain('64 table rows, 2 open');
    expect(logs[0]).toContain('62 expired');
    for (const raw of raws) expect(raw.advertHtml).toContain('<h3>Minimum Requirements</h3>');
  });

  it('skips and logs one unfetchable advert instead of failing the source', async () => {
    const logs: string[] = [];
    const raws = await fetchAllPostbank(TEST_CONFIG, {
      fetchImpl: stubFetch({ 'advert-sap-grc-specialist-2026': 500 }),
      log: (m) => logs.push(m),
    });

    expect(raws.map((r) => r.vacancy.slug)).toEqual(['advert-specialist-architect-2026']);
    expect(
      logs.some((l) => l.includes('advert-sap-grc-specialist-2026') && l.includes('500')),
    ).toBe(true);
  });

  it('throws when the careers page itself is unavailable', async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 503 }) as unknown as Response) as unknown as typeof fetch;
    await expect(fetchAllPostbank(TEST_CONFIG, { fetchImpl })).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the page stops parsing to rows, rather than reporting zero jobs', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      text: async () => '<html><body><p>We are not hiring.</p></body></html>',
    })) as unknown as typeof fetch;
    await expect(fetchAllPostbank(TEST_CONFIG, { fetchImpl })).rejects.toThrow(/zero vacancy rows/);
  });
});
