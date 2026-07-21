import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { sarbAdapter } from '../src/index';
import { fetchAllOracle, fetchOracleJobList } from '../src/index';
import type {
  OracleConfig,
  OracleDetailResponse,
  OracleListRequisition,
  OracleListResponse,
  OracleRawPosting,
  OracleRequisitionDetail,
} from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (loaded offline, never the network). list-page1.json is the verbatim
// SARB list response (24 requisitions); detail-{1,2,3}.json are verbatim detail
// responses — the generic bare-"South Africa"/IT role (1643), a Policy &
// Regulation analyst (1739) and the Personal Assistant (1750).
// ---------------------------------------------------------------------------

function loadFixture<T>(name: string): T {
  const url = new URL(`../../../fixtures/sarb/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

const listResponse = loadFixture<OracleListResponse>('list-page1.json');
const listContainer = listResponse.items[0];
const listItems: OracleListRequisition[] = listContainer?.requisitionList ?? [];
const details = [1, 2, 3].map(
  (n) => loadFixture<OracleDetailResponse>(`detail-${n}.json`).items[0] as OracleRequisitionDetail,
);

/** Pair each detail with its list summary by Id (the detail is a superset). */
function pairFor(detail: OracleRequisitionDetail): OracleRawPosting {
  const listItem = listItems.find((p) => p.Id === detail.Id) ?? detail;
  return { listItem, detail };
}

const pairs = details.map(pairFor);

function jobFor(id: string): ReturnType<typeof sarbAdapter.normalize> {
  const pair = pairs.find((p) => p.detail.Id === id);
  if (!pair) throw new Error(`No fixture pair for ${id}`);
  return sarbAdapter.normalize(pair);
}

// A zero-delay config so the paced client never actually sleeps in tests.
const TEST_CONFIG: OracleConfig = {
  host: 'fa-evra-saasfaprod1.fa.ocs.oraclecloud.com',
  siteNumber: 'CX_1002',
  uiSite: 'SARB',
  delayMs: 0,
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// (a) List parsing — the committed list has the manifest's count, and the client
// surfaces TotalJobsCount from the items[0] container.
// ---------------------------------------------------------------------------

describe('oracle client — list parsing', () => {
  it('parses the committed list to 24 requisitions with TotalJobsCount 24', async () => {
    const fetchImpl = (async () => jsonResponse(200, listResponse)) as unknown as typeof fetch;
    const container = await fetchOracleJobList(TEST_CONFIG, 0, { fetchImpl });
    expect(container.requisitionList?.length).toBe(24);
    expect(container.TotalJobsCount).toBe(24);
    // Every summary carries the human req Id used as the adapter key.
    expect(container.requisitionList?.every((r) => /^\d+$/.test(r.Id))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) The expand quirk — omitting expand=requisitionList.workLocation returns a
// 200 with facets but NO requisitionList key; the client MUST throw, never
// silently report zero jobs.
// ---------------------------------------------------------------------------

describe('oracle client — missing requisitionList guard', () => {
  it('throws (mentioning expand) when the container has no requisitionList key', async () => {
    // A facets-only container: TotalJobsCount is present, requisitionList absent.
    const facetsOnly = { items: [{ Offset: 0, Limit: 200, TotalJobsCount: 24, Facets: [] }] };
    const fetchImpl = (async () => jsonResponse(200, facetsOnly)) as unknown as typeof fetch;

    await expect(fetchOracleJobList(TEST_CONFIG, 0, { fetchImpl })).rejects.toThrow(
      /requisitionList/,
    );
    await expect(fetchOracleJobList(TEST_CONFIG, 0, { fetchImpl })).rejects.toThrow(/expand/);
  });

  it('does NOT throw for a real zero (requisitionList present but empty)', async () => {
    const empty = { items: [{ Offset: 0, Limit: 200, TotalJobsCount: 0, requisitionList: [] }] };
    const fetchImpl = (async () => jsonResponse(200, empty)) as unknown as typeof fetch;
    const container = await fetchOracleJobList(TEST_CONFIG, 0, { fetchImpl });
    expect(container.requisitionList).toEqual([]);
    expect(container.TotalJobsCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (c) Client pagination + list/detail pairing, against a stubbed fetch. The real
// list fits on one page, so three real summaries are split across two synthetic
// pages to exercise the offset-until-TotalJobsCount path and the per-req detail
// fetch. The stub sees the raw finder URL (literal quotes), so Id="…" is parsed
// straight from it.
// ---------------------------------------------------------------------------

describe('oracle client — pagination and pairing', () => {
  it('paginates by offset up to TotalJobsCount and pairs each detail by Id', async () => {
    const [item1, item2, item3] = listItems;
    const trio = [item1, item2, item3].filter((x): x is OracleListRequisition => x !== undefined);
    const detailById = new Map(details.map((d) => [d.Id, d]));
    const listOffsets: string[] = [];

    // pageSize 2 → page 1 (offset 0): [item1,item2]; page 2 (offset 2): [item3].
    const fetchImpl = (async (url: string) => {
      if (url.includes('recruitingCEJobRequisitions?')) {
        const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? '0');
        listOffsets.push(String(offset));
        const page = offset === 0 ? [trio[0], trio[1]] : [trio[2]];
        return jsonResponse(200, {
          items: [{ Offset: offset, Limit: 2, TotalJobsCount: trio.length, requisitionList: page }],
        });
      }
      // Detail GET: parse the quoted Id straight out of the finder.
      const id = /Id="(\d+)"/.exec(url)?.[1] ?? '';
      const detail = detailById.get(id) ?? { Id: id };
      return jsonResponse(200, { items: [detail] });
    }) as unknown as typeof fetch;

    const raws = await fetchAllOracle({ ...TEST_CONFIG, pageSize: 2 }, { fetchImpl });

    expect(raws.map((r) => r.detail.Id)).toEqual(trio.map((t) => t.Id));
    for (const raw of raws) {
      expect(raw.detail.Id).toBe(raw.listItem.Id);
    }
    // Two list requests: offset 0 then offset 2 (advanced by the first page size).
    expect(listOffsets).toEqual(['0', '2']);
  });
});

// ---------------------------------------------------------------------------
// (d) normalize — snapshots.
// ---------------------------------------------------------------------------

describe('sarbAdapter.normalize — snapshots', () => {
  it.each(pairs.map((p) => [p.detail.Id, p] as const))('normalizes %s', (_id, raw) => {
    expect(sarbAdapter.normalize(raw)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// (e) normalize — invariants that must hold for every posting.
// ---------------------------------------------------------------------------

describe('sarbAdapter.normalize — invariants', () => {
  const jobs = pairs.map((p) => sarbAdapter.normalize(p));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^sarb:\d+$/);
    expect(job.source).toBe('sarb');
    expect(job.brand).toBe('SARB');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    // Apply URL is the stable public job page under the SARB site.
    expect(
      job.applyUrl.startsWith(
        'https://fa-evra-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/SARB/job/',
      ),
    ).toBe(true);

    // ExternalPostedStartDate is a real ISO timestamp → a real date.
    expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Every current SARB role is South African.
    expect(job.country).toBe('ZA');

    // The '(Id) ' req-number prefix is stripped from the title.
    expect(job.title.startsWith(`(${job.id.replace('sarb:', '')})`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (f) normalize — mapping-specific assertions.
// ---------------------------------------------------------------------------

describe('sarbAdapter.normalize — mapping', () => {
  it('1643 (PrimaryLocation "South Africa") → locationless ZA, IT, title prefix stripped', () => {
    const job = jobFor('1643');
    expect(job.id).toBe('sarb:1643');
    expect(job.country).toBe('ZA');
    // Nationwide role: no invented city, empty locations, null primaryLocation —
    // even though its workLocation still carries the Pretoria Head Office.
    expect(job.locations).toEqual([]);
    expect(job.primaryLocation).toBeNull();
    expect(job.category).toBe('Software & IT');
    // The leading '(1643) ' is stripped; interior parens are kept intact.
    expect(job.title).toBe('Senior Network Specialist - (F5 & CISCO FTD) - BSTD');
    expect(job.employmentType).toBe('Full-time');
    expect(job.postedDate).toBe('2026-07-08');
    expect(job.applyUrl).toBe(
      'https://fa-evra-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/SARB/job/1643',
    );
  });

  it('1739 (Pretoria) → Pretoria/Gauteng and the per-source Risk & Compliance rule', () => {
    const job = jobFor('1739');
    expect(job.primaryLocation).toBe('Pretoria, Gauteng');
    expect(job.locations).toEqual([{ city: 'Pretoria', province: 'Gauteng', raw: 'Pretoria' }]);
    // Category 'Analyst - Policy and Regulation' → Risk & Compliance (per-source).
    expect(job.category).toBe('Risk & Compliance');
    expect(job.title).toBe('Senior Analyst- Licensing and Authorisation');
    expect(job.postedDate).toBe('2026-07-10');
  });

  it('1750 (Personal Assistant) → Pretoria/Gauteng and the per-source Operations & Admin rule', () => {
    const job = jobFor('1750');
    expect(job.primaryLocation).toBe('Pretoria, Gauteng');
    // Title 'Personal Assistant' → Operations & Admin (per-source rule).
    expect(job.category).toBe('Operations & Admin');
    expect(job.title).toBe('Personal Assistant');
  });

  it('maps the JobSchedule label and yields null when it is absent', () => {
    const pair = pairs.find((p) => p.detail.Id === '1750');
    if (!pair) throw new Error('No fixture pair for 1750');
    // Real value 'Full time' → house style 'Full-time'.
    expect(sarbAdapter.normalize(pair).employmentType).toBe('Full-time');
    // A role with no JobSchedule (real: ~2 roles) yields null, never an invention.
    const stripped = { ...pair, detail: { ...pair.detail, JobSchedule: undefined } };
    expect(sarbAdapter.normalize(stripped).employmentType).toBeNull();
  });
});
