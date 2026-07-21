import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CATEGORIES } from '@bankjobs/core';

import { gotymeAdapter } from '../src/index';
import { fetchAllWorkable, fetchWorkableJobList } from '../src/index';
import type {
  WorkableConfig,
  WorkableJobDetail,
  WorkableListResponse,
  WorkableRawPosting,
} from '../src/index';

// ---------------------------------------------------------------------------
// Fixtures (loaded offline, never the network). `list-empty.json` is the REAL
// GoTyme feed (0 roles today). The `standin-*` fixtures are a public stand-in
// Workable account ('careers' — Workable's own board) captured to pin the
// populated schema; the adapter normalizes them under the GoTyme brand, which
// is intentional and only exercises the parsing + mapping, not the employer.
// ---------------------------------------------------------------------------

function loadFixture<T>(name: string): T {
  const url = new URL(`../../../fixtures/gotyme/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as T;
}

const emptyList = loadFixture<WorkableListResponse>('list-empty.json');
const standinList = loadFixture<WorkableListResponse>('standin-list.json');
const details = [1, 2].map((n) => loadFixture<WorkableJobDetail>(`standin-detail-${n}.json`));

/** Pair each detail with its list item by shortcode (the detail is a superset). */
function pairFor(detail: WorkableJobDetail): WorkableRawPosting {
  const listItem = standinList.results.find((p) => p.shortcode === detail.shortcode) ?? detail;
  return { listItem, detail };
}

const pairs = details.map(pairFor);

function jobFor(shortcode: string): ReturnType<typeof gotymeAdapter.normalize> {
  const pair = pairs.find((p) => p.detail.shortcode === shortcode);
  if (!pair) throw new Error(`No fixture pair for ${shortcode}`);
  return gotymeAdapter.normalize(pair);
}

// A zero-delay config so the paced client never actually sleeps in tests.
const TEST_CONFIG: WorkableConfig = { slug: 'gotyme-za-south-africa', delayMs: 0 };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// (a) The real, empty GoTyme feed → the client yields nothing.
// ---------------------------------------------------------------------------

describe('workable client — real empty GoTyme feed', () => {
  it('parses the committed empty list to zero results', async () => {
    const fetchImpl = (async () => jsonResponse(200, emptyList)) as unknown as typeof fetch;
    const list = await fetchWorkableJobList(TEST_CONFIG, undefined, { fetchImpl });
    expect(list.total).toBe(0);
    expect(list.results).toEqual([]);
  });

  it('fetchAll yields [] and never fetches a detail', async () => {
    let detailCalls = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') return jsonResponse(200, emptyList);
      detailCalls += 1;
      return jsonResponse(200, {});
    }) as unknown as typeof fetch;

    const raws = await fetchAllWorkable(TEST_CONFIG, { fetchImpl });
    expect(raws).toEqual([]);
    expect(detailCalls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Client pagination + list/detail pairing, against a stubbed fetch. The
// live stand-in fits on one page, so the two real postings are split across two
// synthetic pages to exercise the nextPage continuation-token path.
// ---------------------------------------------------------------------------

describe('workable client — pagination and pairing', () => {
  it('walks the nextPage cursor and pairs each posting with its detail', async () => {
    const [item1, item2] = standinList.results;
    const detailByShortcode = new Map(details.map((d) => [d.shortcode, d]));
    const listBodies: string[] = [];

    const fetchImpl = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        const body = String(init?.body ?? '{}');
        listBodies.push(body);
        const token = (JSON.parse(body) as { token?: string }).token;
        // Page 1 (no token) → first posting + a cursor; page 2 (token) → the rest.
        return token
          ? jsonResponse(200, { total: 2, results: [item2] })
          : jsonResponse(200, { total: 2, results: [item1], nextPage: 'CURSOR-2' });
      }
      // Detail GET: the trailing path segment is the shortcode.
      const shortcode = url.split('/').filter(Boolean).pop() ?? '';
      const detail = detailByShortcode.get(shortcode);
      if (!detail) throw new Error(`unexpected detail request for ${url}`);
      return jsonResponse(200, detail);
    }) as unknown as typeof fetch;

    const raws = await fetchAllWorkable(TEST_CONFIG, { fetchImpl });

    expect(raws.map((r) => r.detail.shortcode)).toEqual([item1?.shortcode, item2?.shortcode]);
    // Every list item is paired with the detail carrying the same shortcode.
    for (const raw of raws) {
      expect(raw.detail.shortcode).toBe(raw.listItem.shortcode);
    }
    // Two list requests: page 1 with an empty body, page 2 echoing the cursor
    // back as { token } (the request field differs from the response's nextPage).
    expect(listBodies).toEqual(['{}', JSON.stringify({ token: 'CURSOR-2' })]);
  });
});

// ---------------------------------------------------------------------------
// (c) normalize — snapshots.
// ---------------------------------------------------------------------------

describe('gotymeAdapter.normalize — snapshots', () => {
  it.each(pairs.map((p) => [p.detail.shortcode, p] as const))('normalizes %s', (_sc, raw) => {
    expect(gotymeAdapter.normalize(raw)).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------------------
// (c) normalize — invariants that must hold for every posting.
// ---------------------------------------------------------------------------

describe('gotymeAdapter.normalize — invariants', () => {
  const jobs = pairs.map((p) => gotymeAdapter.normalize(p));

  it.each(jobs.map((j) => [j.id, j] as const))('%s has a canonical shape', (_id, job) => {
    expect(job.id).toMatch(/^gotyme:[A-Za-z0-9]+$/);
    expect(job.source).toBe('gotyme');
    expect(job.brand).toBe('GoTyme Bank');

    expect(CATEGORIES).toContain(job.category);

    // Sanitized HTML: no containers, scripts, styles, or inline attributes.
    expect(job.descriptionHtml).not.toContain('<div');
    expect(job.descriptionHtml).not.toContain('<script');
    expect(job.descriptionHtml).not.toContain('<style');
    expect(job.descriptionHtml).not.toContain(' style=');

    expect(job.excerpt.length).toBeGreaterThanOrEqual(250);
    expect(job.excerpt.length).toBeLessThanOrEqual(401);

    // Apply URL is the stable public job page under the GoTyme apply origin,
    // built from THIS adapter's slug regardless of the stand-in's employer.
    expect(job.applyUrl.startsWith('https://apply.workable.com/gotyme-za-south-africa/j/')).toBe(
      true,
    );

    // published is a real ISO timestamp, so postedDate is a real date.
    expect(job.postedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// (c) normalize — mapping-specific assertions.
// ---------------------------------------------------------------------------

describe('gotymeAdapter.normalize — mapping', () => {
  it('detail-1 (Boston, United States) → US, city fallback, dept-driven category', () => {
    const job = jobFor('401786A940');
    expect(job.id).toBe('gotyme:401786A940');
    // The API's own ISO alpha-2 countryCode is used directly.
    expect(job.country).toBe('US');
    // Not an SA city, so it falls back to the raw city string.
    expect(job.locations[0]?.city).toBeNull();
    expect(job.primaryLocation).toBe('Boston');
    expect(job.employmentType).toBe('Full-time');
    // Title carries no keyword; the 'Operations' department decides the category.
    expect(job.category).toBe('Operations & Admin');
    expect(job.applyUrl).toBe('https://apply.workable.com/gotyme-za-south-africa/j/401786A940/');
    expect(job.postedDate).toBe('2026-06-22');
  });

  it('detail-2 (Athens, Greece) → title-driven Software & IT, GR from countryCode', () => {
    const job = jobFor('5656BF6FBE');
    expect(job.country).toBe('GR');
    expect(job.primaryLocation).toBe('Athens');
    expect(job.category).toBe('Software & IT');
  });

  it('a record without countryCode falls back to the display name, then ZZ', () => {
    const pair = pairs.find((p) => p.detail.shortcode === '5656BF6FBE');
    if (!pair) throw new Error('No fixture pair for 5656BF6FBE');
    const stripped = {
      ...pair,
      detail: { ...pair.detail, location: { ...pair.detail.location, countryCode: undefined } },
    };
    // 'Greece' is not in the core country table, so the fallback yields 'ZZ' —
    // never a silent ZA. Real GoTyme records carry countryCode 'ZA' anyway.
    expect(gotymeAdapter.normalize(stripped).country).toBe('ZZ');
  });
});
