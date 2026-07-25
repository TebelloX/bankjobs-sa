import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimiter } from '../src/ratelimit';
import { callJson } from './helpers';
import { seedAll } from './seed';

interface Meta {
  generatedAt: string;
  totalOpen: number;
  totalSA: number;
  totalInternational: number;
  sources: { id: string; name: string; count: number; lastSuccessAt: string | null }[];
  categories: Record<string, number>;
  provinces: Record<string, number>;
}

beforeAll(async () => {
  await seedAll(env.DB);
});
beforeEach(() => {
  resetRateLimiter();
});

describe('GET /api/meta', () => {
  it('mirrors the snapshot meta aggregates from D1', async () => {
    const { res, body } = await callJson<Meta>('/api/meta');
    expect(res.status).toBe(200);

    expect(body.totalOpen).toBe(8);
    expect(body.totalSA).toBe(7);
    expect(body.totalInternational).toBe(1);

    // Every sources row present (10), counts span all open jobs (SA + intl).
    expect(body.sources.length).toBe(10);
    const bySource = new Map(body.sources.map((s) => [s.id, s.count]));
    expect(bySource.get('absa')).toBe(3);
    expect(bySource.get('firstrand')).toBe(2);
    expect(bySource.get('standardbank')).toBe(1);
    expect(bySource.get('nedbank')).toBe(0); // its only role is closed

    // Category counts are SA-only, all 10 slugs present.
    expect(Object.keys(body.categories).length).toBe(10);
    expect(body.categories['software-it']).toBe(2);
    expect(body.categories['risk-compliance']).toBe(1); // absa:R-3 (SC) excluded
    expect(body.categories['sales']).toBe(0); // only a closed role
    expect(body.categories['other']).toBe(0);

    // Province counts are SA-only, distinct jobs, >0 only.
    expect(body.provinces).toEqual({ Gauteng: 5, 'Western Cape': 1, 'KwaZulu-Natal': 1 });
    expect(body.provinces['Free State']).toBeUndefined(); // closed role's province

    expect(typeof body.generatedAt).toBe('string');
  });
});
