import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetRateLimiter, takeToken } from '../src/ratelimit';
import { call } from './helpers';
import { seedAll } from './seed';

beforeAll(async () => {
  await seedAll(env.DB);
});
beforeEach(() => {
  resetRateLimiter();
});

describe('token bucket (unit)', () => {
  it('allows a burst up to capacity, then denies with Retry-After', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 20; i++) {
      expect(takeToken('1.1.1.1', t0).allowed).toBe(true); // capacity = 20
    }
    const denied = takeToken('1.1.1.1', t0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('refills over time (60/min = 1/sec)', () => {
    const t0 = 2_000_000;
    for (let i = 0; i < 20; i++) takeToken('2.2.2.2', t0);
    expect(takeToken('2.2.2.2', t0).allowed).toBe(false);
    // +2s → ~2 tokens back
    expect(takeToken('2.2.2.2', t0 + 2000).allowed).toBe(true);
  });

  it('buckets are per-IP', () => {
    const t0 = 3_000_000;
    for (let i = 0; i < 20; i++) takeToken('3.3.3.3', t0);
    expect(takeToken('3.3.3.3', t0).allowed).toBe(false);
    expect(takeToken('4.4.4.4', t0).allowed).toBe(true); // fresh bucket
  });
});

describe('rate limiting (integration)', () => {
  it('returns 429 + Retry-After once an IP exhausts its burst', async () => {
    const headers = { 'CF-Connecting-IP': '9.9.9.9' };
    let ok = 0;
    let limited = 0;
    let retryAfter: string | null = null;
    // Unique q per request → every call is a cache MISS → each spends a token.
    for (let i = 0; i < 26; i++) {
      const res = await call(`/api/jobs?q=term${i}`, { headers });
      if (res.status === 429) {
        limited++;
        retryAfter = res.headers.get('Retry-After');
      } else {
        ok++;
      }
    }
    expect(ok).toBeGreaterThanOrEqual(15);
    expect(limited).toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });

  it('serves a cache HIT even when the bucket is empty', async () => {
    const headers = { 'CF-Connecting-IP': '8.8.8.8' };
    // Prime the cache for this exact key (spends one token).
    const primed = await call('/api/jobs?q=engineer', { headers });
    expect(primed.headers.get('X-Cache')).toBe('MISS');
    // Drain the bucket on other keys.
    for (let i = 0; i < 40; i++) await call(`/api/jobs?q=drain${i}`, { headers });
    // The cached key still serves — HIT is checked before the limiter.
    const hit = await call('/api/jobs?q=engineer', { headers });
    expect(hit.status).toBe(200);
    expect(hit.headers.get('X-Cache')).toBe('HIT');
  });
});
