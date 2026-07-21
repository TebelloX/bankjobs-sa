import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimiter } from '../src/ratelimit';
import { type ListResp, call, callJson, ids } from './helpers';
import { seedAll } from './seed';

beforeAll(async () => {
  await seedAll(env.DB);
});
beforeEach(() => {
  resetRateLimiter();
});

describe('GET /api/jobs', () => {
  it('lists open jobs, ordered postedDate desc with nulls last; excludes closed', async () => {
    const { res, body } = await callJson<ListResp>('/api/jobs');
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(body.total).toBe(8); // 9 seeded, 1 closed
    expect(ids(body)).toEqual([
      'absa:R-2',
      'standardbank:R-200',
      'firstrand:R-100',
      'absa:R-1',
      'investec:R-50',
      'sarb:1736',
      'absa:R-3',
      'firstrand:R-101', // null postedDate sorts last
    ]);
    expect(ids(body)).not.toContain('nedbank:R-9');
  });

  it('shapes rows like the snapshot lean row + excerpt/applyUrl', async () => {
    const { body } = await callJson<ListResp>('/api/jobs?limit=1');
    const row = body.jobs[0]!;
    expect(row).toEqual({
      id: 'absa:R-2',
      slug: 'absa-r-2',
      title: 'Senior Backend Software Engineer',
      brand: 'Absa',
      source: 'absa',
      category: 'Software & IT',
      categorySlug: 'software-it',
      city: 'Cape Town',
      province: 'Western Cape',
      primaryLocation: 'Cape Town, Western Cape',
      country: 'ZA',
      excerpt: 'Build cloud backend services in Python.',
      postedDate: '2026-07-08',
      applyUrl: 'https://absa.wd3.myworkdayjobs.com/apply/R-2',
    });
  });

  it('caps limit at 50 and floors at 1; clamps junk to defaults', async () => {
    expect((await callJson<ListResp>('/api/jobs?limit=999')).body.limit).toBe(50);
    expect((await callJson<ListResp>('/api/jobs?limit=0')).body.limit).toBe(1);
    expect((await callJson<ListResp>('/api/jobs?limit=abc')).body.limit).toBe(20);
    expect((await callJson<ListResp>('/api/jobs?offset=-5')).body.offset).toBe(0);
  });

  it('paginates with a stable total', async () => {
    const p1 = (await callJson<ListResp>('/api/jobs?limit=2&offset=0')).body;
    const p2 = (await callJson<ListResp>('/api/jobs?limit=2&offset=2')).body;
    expect(p1.total).toBe(8);
    expect(p2.total).toBe(8);
    expect(ids(p1)).toEqual(['absa:R-2', 'standardbank:R-200']);
    expect(ids(p2)).toEqual(['firstrand:R-100', 'absa:R-1']);
  });

  it('filters by country (ZA excludes the Seychelles role)', async () => {
    const body = (await callJson<ListResp>('/api/jobs?country=ZA')).body;
    expect(body.total).toBe(7);
    expect(ids(body)).not.toContain('absa:R-3');
  });

  it('filters by source', async () => {
    const body = (await callJson<ListResp>('/api/jobs?source=absa')).body;
    expect(body.total).toBe(3);
    expect(ids(body).sort()).toEqual(['absa:R-1', 'absa:R-2', 'absa:R-3']);
  });

  it('accepts category by slug OR by canonical name', async () => {
    const bySlug = (await callJson<ListResp>('/api/jobs?category=software-it')).body;
    const byName = (
      await callJson<ListResp>(`/api/jobs?category=${encodeURIComponent('Software & IT')}`)
    ).body;
    expect(bySlug.total).toBe(2);
    expect(ids(bySlug).sort()).toEqual(['absa:R-2', 'investec:R-50']);
    expect(ids(byName).sort()).toEqual(ids(bySlug).sort());
  });

  it('returns empty for an unknown category (not an ignored filter)', async () => {
    const body = (await callJson<ListResp>('/api/jobs?category=does-not-exist')).body;
    expect(body.total).toBe(0);
    expect(body.jobs).toEqual([]);
  });

  it('filters by province and by city', async () => {
    expect((await callJson<ListResp>('/api/jobs?province=Gauteng')).body.total).toBe(5);
    expect((await callJson<ListResp>('/api/jobs?province=Western+Cape')).body.total).toBe(1);
    const pta = (await callJson<ListResp>('/api/jobs?city=Pretoria')).body;
    expect(ids(pta).sort()).toEqual(['sarb:1736', 'standardbank:R-200']);
  });

  it('combines category + province', async () => {
    const body = (await callJson<ListResp>('/api/jobs?category=branch-retail&province=Gauteng'))
      .body;
    expect(ids(body)).toEqual(['absa:R-1']);
  });

  it('runs an FTS search with bm25 ordering (title hit ranks first)', async () => {
    const body = (await callJson<ListResp>('/api/jobs?q=engineer')).body;
    expect(body.total).toBe(2);
    expect(body.jobs[0]!.id).toBe('absa:R-2'); // title contains "Engineer"
    expect(ids(body)).toContain('investec:R-50'); // body-only hit
  });

  it('combines q with a structured filter', async () => {
    const body = (await callJson<ListResp>('/api/jobs?q=software&category=software-it')).body;
    expect(ids(body).sort()).toEqual(['absa:R-2', 'investec:R-50']);
  });
});

describe('routing', () => {
  it('404 JSON for unknown paths', async () => {
    const { res, body } = await callJson<{ error: string }>('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(body.error).toBeTruthy();
  });

  it('405 JSON (Allow: GET) for non-GET methods', async () => {
    const res = await call('/api/jobs', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('Allow')).toBe('GET');
    expect(((await res.json()) as { error: string }).error).toBeTruthy();
  });
});
