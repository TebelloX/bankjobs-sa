import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import {
  absaAdapter,
  AdapterNormalizeError,
  BROWSER_UA,
  fetchAllWorkday,
  HONEST_UA,
} from '../src/index';
import type {
  WorkdayConfig,
  WorkdayJobDetail,
  WorkdayListResponse,
  WorkdayRawPosting,
} from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (loaded offline, never the network).
// ---------------------------------------------------------------------------

function loadFixture<T>(name: string): T {
  const url = new URL(`../../../fixtures/absa/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

const list = loadFixture<WorkdayListResponse>('list-page1.json');
const details = [1, 2, 3].map((n) => loadFixture<WorkdayJobDetail>(`detail-${n}.json`));

/** Pair each detail with its list item by matching jobReqId to bulletFields[0]. */
function pairFor(detail: WorkdayJobDetail): WorkdayRawPosting {
  const reqId = detail.jobPostingInfo.jobReqId;
  const listItem = list.jobPostings.find((p) => p.bulletFields[0] === reqId);
  if (!listItem) throw new Error(`No list item for jobReqId ${reqId}`);
  return { listItem, detail };
}

const pairs = details.map(pairFor);

function jobFor(reqId: string): ReturnType<typeof absaAdapter.normalize> {
  const pair = pairs.find((p) => p.detail.jobPostingInfo.jobReqId === reqId);
  if (!pair) throw new Error(`No fixture pair for ${reqId}`);
  return absaAdapter.normalize(pair);
}

// ---------------------------------------------------------------------------
// Snapshots.
// ---------------------------------------------------------------------------

describe('absaAdapter.normalize — snapshots', () => {
  it.each(pairs.map((p) => [p.detail.jobPostingInfo.jobReqId, p] as const))(
    'normalizes %s',
    (_reqId, raw) => {
      expect(absaAdapter.normalize(raw)).toMatchSnapshot();
    },
  );
});

// ---------------------------------------------------------------------------
// Invariants that must hold for every fixture.
// ---------------------------------------------------------------------------

describe('absaAdapter.normalize — invariants', () => {
  const jobs = pairs.map((p) => absaAdapter.normalize(p));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^absa:R-\d+$/);
    expect(job.source).toBe('absa');
    expect(job.brand).toBe('Absa');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    expect(job.applyUrl.startsWith('https://absa.wd3.myworkdayjobs.com/')).toBe(true);
    expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// Fixture-specific location / country mapping.
// ---------------------------------------------------------------------------

describe('absaAdapter.normalize — location & country', () => {
  it('detail-1 (Lydenburg) resolves to ZA / Mpumalanga', () => {
    const job = jobFor('R-15987866');
    expect(job.country).toBe('ZA');
    expect(job.locations[0]?.city).toBe('Lydenburg');
    expect(job.locations[0]?.province).toBe('Mpumalanga');
    expect(job.primaryLocation).toBe('Lydenburg, Mpumalanga');
  });

  it('detail-3 (Grand Anse) resolves to SC and falls back to the raw location', () => {
    const job = jobFor('R-15989226');
    expect(job.country).toBe('SC');
    // Grand Anse is not a known SA location, so it stays unmatched but keeps raw.
    expect(job.locations[0]?.raw).toBe('Grand Anse');
    expect(job.primaryLocation).toBe('Grand Anse');
  });

  it('a posting with no location data at all defaults to ZA', () => {
    // Verified live: group/pipeline roles carry location:"", country:null,
    // jobRequisitionLocation:null. They must not surface as "International — ZZ".
    const bare = structuredClone(pairs[0]!);
    bare.detail.jobPostingInfo.location = '';
    bare.detail.jobPostingInfo.country = null as never;
    const job = absaAdapter.normalize(bare);
    expect(job.country).toBe('ZA');
    expect(job.primaryLocation).toBeNull();
  });

  it('a present but unrecognized country descriptor still maps to ZZ', () => {
    const odd = structuredClone(pairs[0]!);
    odd.detail.jobPostingInfo.country = { descriptor: 'Atlantis', id: 'x' };
    expect(absaAdapter.normalize(odd).country).toBe('ZZ');
  });
});

// ---------------------------------------------------------------------------
// Error handling.
// ---------------------------------------------------------------------------

describe('absaAdapter.normalize — errors', () => {
  it('throws AdapterNormalizeError when jobReqId is missing', () => {
    const bad = structuredClone(pairs[0]!);
    delete (bad.detail.jobPostingInfo as { jobReqId?: string }).jobReqId;
    expect(() => absaAdapter.normalize(bad)).toThrow(AdapterNormalizeError);
  });

  it('the thrown error carries the source', () => {
    const bad = structuredClone(pairs[0]!);
    delete (bad.detail.jobPostingInfo as { jobReqId?: string }).jobReqId;
    try {
      absaAdapter.normalize(bad);
      expect.unreachable('normalize should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterNormalizeError);
      expect((err as AdapterNormalizeError).source).toBe('absa');
    }
  });
});

// ---------------------------------------------------------------------------
// Client: pagination + User-Agent strategy (stubbed fetch, no network).
// ---------------------------------------------------------------------------

describe('fetchAllWorkday — pagination & UA fallback', () => {
  it('falls back to the browser UA on 406 and paginates in pages of 20', async () => {
    const cfg: WorkdayConfig = {
      host: 'stub.example',
      tenant: 'absa',
      site: 'ABSAcareersite',
      pageSize: 20,
      delayMs: 0, // no real sleeping in tests
    };

    const validCount = 45;
    const valid = Array.from({ length: validCount }, (_, i) => ({
      title: `Job ${i}`,
      externalPath: `/job/City/Job_${i}`,
      locationsText: 'City',
      postedOn: 'Posted Today',
      bulletFields: [`R-${1000 + i}`, '2026-07-20'],
    }));
    // A malformed/hidden posting: no title, no externalPath (verified live on
    // FirstRand's list endpoint). It must be skipped before the detail pass.
    const malformed = { bulletFields: ['R-51859', 'Permanent', 'FNB'] };
    const allPostings = [...valid.slice(0, 5), malformed, ...valid.slice(5)];
    const total = allPostings.length; // 46 -> pages of 20, 20, 6 (one skipped)

    const calls: Array<{ url: string; method: string; ua: string | undefined }> = [];

    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const ua = headers['User-Agent'];
      const method = init.method ?? 'GET';
      calls.push({ url, method, ua });

      // Very first request (honest UA) is rejected with 406.
      if (calls.length === 1) {
        expect(ua).toBe(HONEST_UA);
        return new Response('not acceptable', { status: 406 });
      }

      if (method === 'POST') {
        const body = JSON.parse(init.body as string) as { offset: number };
        const page = allPostings.slice(body.offset, body.offset + 20);
        // Live Workday behavior: the real total appears only on the first page;
        // subsequent pages report total: 0 while still carrying postings.
        const reportedTotal = body.offset === 0 ? total : 0;
        return new Response(JSON.stringify({ total: reportedTotal, jobPostings: page }), {
          status: 200,
        });
      }

      // Detail GET — minimal valid detail.
      return new Response(
        JSON.stringify({
          jobPostingInfo: {
            id: 'x',
            title: 'X',
            jobDescription: '<p>x</p>',
            location: 'City',
            startDate: '2026-07-20',
            jobReqId: 'R-x',
            externalUrl: url,
            country: { descriptor: 'South Africa', id: 'z' },
          },
        }),
        { status: 200 },
      );
    });

    const log: string[] = [];
    const result = await fetchAllWorkday(cfg, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (m) => log.push(m),
    });

    // Every VALID posting was collected and paired with a detail; the malformed
    // one was dropped before the detail pass.
    expect(result).toHaveLength(validCount);

    // Honest UA tried once, then browser UA for everything after the 406.
    expect(calls[0]?.ua).toBe(HONEST_UA);
    expect(calls[0]?.method).toBe('POST');
    for (const c of calls.slice(1)) {
      expect(c.ua).toBe(BROWSER_UA);
    }

    // First page fetched twice (honest 406 + browser retry), then 2 more pages,
    // then one GET per VALID posting (the malformed item is never fetched).
    const listCalls = calls.filter((c) => c.method === 'POST').length;
    const detailCalls = calls.filter((c) => c.method === 'GET').length;
    expect(listCalls).toBe(4); // page1 honest + page1 browser + page2 + page3
    expect(detailCalls).toBe(validCount);

    // Progress logging.
    expect(log).toContain('absa: page 1/3');
    expect(log).toContain('absa: page 2/3');
    expect(log).toContain('absa: page 3/3');
    expect(log).toContain(`absa: details ${validCount}/${validCount}`);
    expect(log).toContain('absa: skipped 1 malformed list items');
  });
});

// ---------------------------------------------------------------------------
// applyUrl host guard (Workday family). A hijacked upstream feed cannot publish
// a phishing apply link: a foreign externalUrl makes normalize throw, which the
// ingest runner turns into a skip (and a wholesale swap trips the >10% abort).
// ---------------------------------------------------------------------------

describe('absaAdapter.normalize — applyUrl host guard', () => {
  it('throws when the feed points externalUrl at a non-allowlisted host', () => {
    const hostile = structuredClone(pairs[0]!);
    hostile.detail.jobPostingInfo.externalUrl = 'https://evil.example.com/phishing-apply';
    expect(() => absaAdapter.normalize(hostile)).toThrow(/not allowlisted/);
  });

  it('rejects a suffix-appended lookalike host (absa.wd3.myworkdayjobs.com.evil.example)', () => {
    const hostile = structuredClone(pairs[0]!);
    hostile.detail.jobPostingInfo.externalUrl = 'https://absa.wd3.myworkdayjobs.com.evil.example/x';
    expect(() => absaAdapter.normalize(hostile)).toThrow(/not allowlisted/);
  });
});
