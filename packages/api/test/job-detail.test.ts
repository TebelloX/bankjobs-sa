import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimiter } from '../src/ratelimit';
import { call, callJson } from './helpers';
import { seedAll } from './seed';

interface Detail {
  id: string;
  slug: string;
  source: string;
  brand: string;
  title: string;
  category: string;
  categorySlug: string;
  employmentType: string | null;
  descriptionHtml: string;
  descriptionText: string;
  excerpt: string;
  primaryLocation: string | null;
  locations: { city: string | null; province: string | null; raw: string }[];
  country: string;
  applyUrl: string;
  postedDate: string | null;
}

beforeAll(async () => {
  await seedAll(env.DB);
});
beforeEach(() => {
  resetRateLimiter();
});

describe('GET /api/jobs/:id', () => {
  it('returns the full record (incl. descriptionHtml) by canonical id', async () => {
    const { res, body } = await callJson<Detail>('/api/jobs/absa:R-2');
    expect(res.status).toBe(200);
    expect(body.id).toBe('absa:R-2');
    expect(body.slug).toBe('absa-r-2');
    expect(body.categorySlug).toBe('software-it');
    expect(body.descriptionHtml).toContain('<p>');
    expect(body.locations).toEqual([
      { city: 'Cape Town', province: 'Western Cape', raw: 'Cape Town' },
    ]);
  });

  it('resolves the same job by its URL slug', async () => {
    const { res, body } = await callJson<Detail>('/api/jobs/absa-r-2');
    expect(res.status).toBe(200);
    expect(body.id).toBe('absa:R-2');
  });

  it('serves an international role with no normalized locations', async () => {
    const body = (await callJson<Detail>('/api/jobs/absa:R-3')).body;
    expect(body.country).toBe('SC');
    expect(body.locations).toEqual([]);
  });

  it('404s for an unknown id', async () => {
    const { res, body } = await callJson<{ error: string }>('/api/jobs/absa:R-999');
    expect(res.status).toBe(404);
    expect(body.error).toBeTruthy();
  });

  it('404s for a closed job (open-only)', async () => {
    expect((await call('/api/jobs/nedbank:R-9')).status).toBe(404);
    expect((await call('/api/jobs/nedbank-r-9')).status).toBe(404); // also by slug
  });
});
