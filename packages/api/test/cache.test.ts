import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimiter } from '../src/ratelimit';
import { call } from './helpers';
import { seedAll } from './seed';

beforeAll(async () => {
  await seedAll(env.DB);
});
beforeEach(() => {
  resetRateLimiter();
});

describe('edge caching', () => {
  it('MISS then HIT for an identical request, with cache directives on 200s', async () => {
    const first = await call('/api/jobs?limit=6');
    expect(first.status).toBe(200);
    expect(first.headers.get('X-Cache')).toBe('MISS');
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=300, s-maxage=900');

    const second = await call('/api/jobs?limit=6');
    expect(second.headers.get('X-Cache')).toBe('HIT');
    expect(await second.text()).toBe(await first.text());
  });

  it('normalizes the key: param order does not matter', async () => {
    await call('/api/jobs?source=absa&limit=5');
    const hit = await call('/api/jobs?limit=5&source=absa');
    expect(hit.headers.get('X-Cache')).toBe('HIT');
  });

  it('normalizes the key: unknown params are dropped', async () => {
    await call('/api/jobs?limit=3');
    const hit = await call('/api/jobs?limit=3&utm_source=twitter&nonsense=1');
    expect(hit.headers.get('X-Cache')).toBe('HIT');
  });

  it('keys on brand: different brands do not collide', async () => {
    // If `brand` were missing from CACHE_PARAMS both would normalize to
    // `/api/jobs` and the second would be a (wrong-result) HIT.
    expect((await call('/api/jobs?brand=Absa')).headers.get('X-Cache')).toBe('MISS');
    expect((await call('/api/jobs?brand=Capitec')).headers.get('X-Cache')).toBe('MISS');
    expect((await call('/api/jobs?brand=Absa')).headers.get('X-Cache')).toBe('HIT');
  });

  it('/api/meta is cacheable', async () => {
    expect((await call('/api/meta')).headers.get('X-Cache')).toBe('MISS');
    expect((await call('/api/meta')).headers.get('X-Cache')).toBe('HIT');
  });

  it('does not cache non-200 responses', async () => {
    const notFound = await call('/api/jobs/absa:R-999');
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get('Cache-Control')).toBeNull();
    expect(notFound.headers.get('X-Cache')).toBeNull();
  });
});
